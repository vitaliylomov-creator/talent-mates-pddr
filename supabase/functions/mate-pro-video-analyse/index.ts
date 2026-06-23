// ────────────────────────────────────────────────────────────────────────────
// mate-pro-video-analyse — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-video-analyse \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// What it does
// ────────────
// Reads N pre-extracted JPEG frames (already uploaded by the browser to the
// mate-pro-frames bucket via canvas-based extraction in the dashboard) and
// runs a single Claude Vision call against them with the Coach sub-agent
// persona plus a "scout's read" output template. Persists the result to
// mate_pro_video_analyses; if a conversation_id is passed, also writes the
// result as an assistant message in mate_pro_messages with attachment_ref
// pointing back at the video_analyses row.
//
// Why client-side frame extraction
// ────────────────────────────────
// The Supabase Edge Deno runtime has a 50 MB memory ceiling and ~60s wall
// clock. ffmpeg-wasm decoding of a 30-second 1080p clip easily blows past
// both. The browser already has a hardware-accelerated H.264/H.265 decoder
// in the <video> element. Per spec § 3 fallback: frontend draws frames to
// canvas, JPEG-encodes at 1280px / quality 0.8, uploads each to
// mate-pro-frames/{agent_id}/{video_analysis_id}/frame_NNN.jpg, then POSTs
// just the storage paths here. We download → base64 → vision API.
//
// Model choice — claude-opus-4-7
// ──────────────────────────────
// Vision-heavy interpretation (body shape, balance, decision-making in the
// moment) benefits significantly from Opus's visual reasoning vs Sonnet.
// Per-analysis cost ≈ €0.30 (8 frames + ~6k system prompt + 600 output);
// at realistic agent usage (50-300 analyses/month) this leaves the €299
// subscription comfortably profitable. mate-pro-chat stays on Sonnet 4.6
// for higher-volume, lower-per-call text work.
//
// Safeguards
// ──────────
//   - MAX_FRAMES = 12 (hard reject above)
//   - MAX_CLIP_DURATION_SEC = 60 (re-check beyond frontend enforcement)
//   - Token counts logged per analysis for future usage tracking
//   - No retries on vision API errors — fail cleanly rather than double-burn
//
// Request body
// ────────────
//   {
//     "conversation_id": "<uuid>" | null,
//     "client_id":       "<uuid>" | null,
//     "frame_paths":     ["{agent_id}/{video_analysis_id}/frame_001.jpg", ...],
//     "focus":           "positioning"|"technical"|"decisions"|"physical",
//     "question":        "optional agent question",
//     "filename":        "raw_clip.mp4",
//     "duration_sec":    12.4,
//     "storage_path":    "{agent_id}/{video_analysis_id}.mp4"  // optional, just stored
//   }
//
// Response
// ────────
//   200 {
//     video_analysis_id, status: "complete",
//     result_text, message_id?: string,
//     frames_used, input_tokens, output_tokens
//   }
//   400 { error }     — bad body / too many frames
//   401 { error }     — missing/invalid JWT
//   403 { error }     — caller not a MATE Pro agent
//   404 { error }     — client_id or conversation_id not owned by caller
//   500 { error }     — frame fetch / Claude / DB failure (with video_analysis_id
//                       persisted as status='failed' if the row was created)
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { MATE_PERSONAS } from "../_shared/mate-personas.ts";

const MAX_FRAMES = 12;
const MAX_CLIP_DURATION_SEC = 60;
const MODEL = "claude-opus-4-7";
const FRAMES_BUCKET = "mate-pro-frames";
const VALID_FOCUS = new Set(["positioning", "technical", "decisions", "physical"]);

// ─────────────────────────────────────────────
// VIDEO ANALYSIS BRIEF — from spec § 2.3
// Prepended above the Coach persona to retarget it for frame-by-frame
// reading. The brief itself is the contract with the model; the underlying
// Coach persona stays untouched and supplies the football reading sensibility.
// ─────────────────────────────────────────────
function buildVisionBrief(focus: string, question?: string): string {
  const focusLabel: Record<string, string> = {
    positioning: "positional awareness, body shape, scanning, support angles",
    technical: "first touch, ball striking, body mechanics on the ball, decision execution",
    decisions: "the decisions taken with the alternatives that were available, awareness of teammates and opponents",
    physical: "the visible physical profile — stride, balance, recovery, change of direction, presence",
  };

  const q = question
    ? `\n<agent_question>\n${question.trim()}\n</agent_question>`
    : "";

  return `<video_analysis_brief>
You are reading a short football clip via 8-12 extracted key frames. You are not analysing live footage and you do not measure quantitative metrics. You describe what is visible to a trained eye — body shape, positioning, technical execution in the moment, decisions taken with the alternatives that were available, and the visible physical profile.

The agent has asked you to focus on: ${focus} (${focusLabel[focus] ?? "general read"}).

You write a scout's read — the kind a Cat 1 academy scout would file after watching a clip. Structure your output exactly:

1. **One-sentence summary** of what the clip shows.
2. **Focus area read** (${focus}) — three to five lines, no padding.
3. **One thing that would interest a club** at the level the client is targeting (or "level unspecified" if you cannot tell from the clip + client context).
4. **One thing that would concern a recruiter** at that level.
5. **One specific question** the agent should investigate next (training history, opposition level, fitness state, body of work).

Do not pad. Do not list bullets longer than necessary. The agent is reading this on a phone between meetings. Markdown is welcome but stay disciplined.
</video_analysis_brief>${q}`;
}

// ─────────────────────────────────────────────
// MAIN HANDLER
// ─────────────────────────────────────────────
Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  let analysisId: string | null = null;
  let admin: any = null;

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
    if (!ANTHROPIC_KEY) return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500);

    // ── 1. Authenticate caller ──────────────────────────────────────────
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Invalid or expired token" }, 401);
    const callerUserId = userData.user.id;

    admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: agent, error: agentErr } = await admin
      .from("mate_pro_agents")
      .select("*")
      .eq("user_id", callerUserId)
      .maybeSingle();
    if (agentErr) return json({ error: agentErr.message }, 500);
    if (!agent) return json({ error: "Caller is not a registered MATE Pro agent" }, 403);

    // ── 2. Parse + validate body ───────────────────────────────────────
    let body: Record<string, any>;
    try { body = await req.json(); }
    catch { return json({ error: "Body must be valid JSON" }, 400); }

    const conversationIdIn: string | null = body.conversation_id ?? null;
    const clientIdIn: string | null = body.client_id ?? null;
    const focus: string = body.focus ?? "positioning";
    const question: string | undefined = typeof body.question === "string" ? body.question.trim() : undefined;
    const filename: string | null = body.filename ?? null;
    const durationSec: number | null = typeof body.duration_sec === "number" ? body.duration_sec : null;
    const storagePath: string | null = body.storage_path ?? null;
    const framePaths: string[] = Array.isArray(body.frame_paths) ? body.frame_paths.filter((p: any) => typeof p === "string") : [];

    if (!VALID_FOCUS.has(focus)) {
      return json({ error: `focus must be one of: ${[...VALID_FOCUS].join(", ")}` }, 400);
    }
    if (framePaths.length < 4) {
      return json({ error: "At least 4 frames required for a useful read" }, 400);
    }
    if (framePaths.length > MAX_FRAMES) {
      return json({ error: `Too many frames (${framePaths.length}); max is ${MAX_FRAMES}` }, 400);
    }
    if (durationSec !== null && durationSec > MAX_CLIP_DURATION_SEC) {
      return json({ error: `Clip too long (${durationSec}s); max is ${MAX_CLIP_DURATION_SEC}s` }, 400);
    }
    // Enforce that every frame path lives under the caller's agent_id folder
    const prefix = `${agent.id}/`;
    const badPath = framePaths.find((p) => !p.startsWith(prefix));
    if (badPath) {
      return json({ error: `Frame path outside your folder: ${badPath}` }, 403);
    }

    // ── 3. Load active client (if any) for context ─────────────────────
    let client: any = null;
    if (clientIdIn) {
      const { data: c, error: cErr } = await admin
        .from("mate_pro_clients")
        .select("first_name, last_name, position_primary, dominant_foot, current_club, current_league, height_cm, weight_kg, date_of_birth, career_history, notes_for_mate")
        .eq("id", clientIdIn)
        .eq("agent_id", agent.id)
        .maybeSingle();
      if (cErr) return json({ error: cErr.message }, 500);
      if (!c) return json({ error: "Client not found in your roster" }, 404);
      client = c;
    }

    // ── 4. Validate conversation_id ownership (if provided) ────────────
    if (conversationIdIn) {
      const { data: conv, error: convErr } = await admin
        .from("mate_pro_conversations")
        .select("id")
        .eq("id", conversationIdIn)
        .eq("agent_id", agent.id)
        .maybeSingle();
      if (convErr) return json({ error: convErr.message }, 500);
      if (!conv) return json({ error: "Conversation not found" }, 404);
    }

    // ── 5. Create video_analyses row up front (status=analysing) ───────
    const { data: vaRow, error: vaErr } = await admin
      .from("mate_pro_video_analyses")
      .insert({
        agent_id: agent.id,
        client_id: clientIdIn,
        conversation_id: conversationIdIn,
        storage_path: storagePath ?? framePaths[0],
        filename,
        duration_sec: durationSec,
        focus,
        question: question ?? null,
        frames_extracted: framePaths.length,
        frame_paths: framePaths,
        status: "analysing",
      })
      .select("id")
      .single();
    if (vaErr || !vaRow) {
      return json({ error: `Could not create analysis row: ${vaErr?.message}` }, 500);
    }
    analysisId = vaRow.id;

    // ── 6. Download each frame from storage, base64-encode ─────────────
    const frameImages: any[] = [];
    for (const path of framePaths) {
      const { data: blob, error: dlErr } = await admin
        .storage
        .from(FRAMES_BUCKET)
        .download(path);
      if (dlErr || !blob) {
        await admin
          .from("mate_pro_video_analyses")
          .update({ status: "failed", error_message: `Frame download failed: ${path}: ${dlErr?.message}` })
          .eq("id", analysisId);
        return json({ error: `Frame download failed: ${path}`, video_analysis_id: analysisId }, 500);
      }
      const buf = new Uint8Array(await blob.arrayBuffer());
      const base64 = uint8ToBase64(buf);
      frameImages.push({
        type: "image",
        source: { type: "base64", media_type: "image/jpeg", data: base64 },
      });
    }

    // ── 7. Build system prompt: vision brief + Coach persona + context ─
    const coachPersona = MATE_PERSONAS.coach ?? MATE_PERSONAS.concierge;
    const visionBrief = buildVisionBrief(focus, question);

    const agentBlock = `
<agent_context>
You are reading this clip for a licensed football agent.
Name: ${agent.first_name} ${agent.last_name}
Agency: ${agent.agency_name ?? "not provided"}
Specialisation: ${agent.specialisation ?? "not provided"}
</agent_context>`.trim();

    const clientBlock = client
      ? `
<client_context>
Client in this clip:
Name: ${client.first_name} ${client.last_name}
Position: ${client.position_primary ?? "not provided"}, ${client.dominant_foot ?? "foot unknown"}-footed
Current club: ${client.current_club ?? "not provided"}, ${client.current_league ?? "league not provided"}
Height/Weight: ${client.height_cm ? client.height_cm + "cm" : "?"} / ${client.weight_kg ? client.weight_kg + "kg" : "?"}
DOB: ${client.date_of_birth ?? "not provided"}
Career history: ${client.career_history ?? "not provided"}
Notes for MATE: ${client.notes_for_mate ?? "none"}
</client_context>`.trim()
      : `<no_client_context>The agent has not specified which client this clip is for. Read the body shown without name-binding; if you cannot anchor the read to a specific role, describe what you see and ask the agent to confirm.</no_client_context>`;

    const overlay = `
<agent_audience_overlay>
The reader of this scout's read is the AGENT, not the player. The persona below was written for direct player conversation; treat its "you" references as the agent's client in the clip. Skip player-direct framing (no second-person performance coaching). Stay in third-person scout voice throughout.
</agent_audience_overlay>`.trim();

    const systemPrompt = `${overlay}

${visionBrief}

${coachPersona}

${agentBlock}

${clientBlock}

Today: ${new Date().toISOString().slice(0, 10)}`;

    // ── 8. Compose vision content array ────────────────────────────────
    const userText = question
      ? `Scout's read on the ${framePaths.length} frames above. Agent's focus: ${focus}. Agent's specific question: ${question}`
      : `Scout's read on the ${framePaths.length} frames above. Agent's focus: ${focus}.`;

    const userContent: any[] = [...frameImages, { type: "text", text: userText }];

    // ── 9. Single Claude Vision call (no tool-use loop — purely vision) ─
    const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": ANTHROPIC_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1500,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
      }),
    });

    if (!claudeRes.ok) {
      const errText = await claudeRes.text();
      console.error("Claude vision error:", errText);
      await admin
        .from("mate_pro_video_analyses")
        .update({ status: "failed", error_message: `Claude API error: ${errText.slice(0, 500)}` })
        .eq("id", analysisId);
      return json({ error: "Claude vision API error", details: errText, video_analysis_id: analysisId }, 500);
    }

    const claudeData = await claudeRes.json();
    const inputTokens = claudeData.usage?.input_tokens ?? 0;
    const outputTokens = claudeData.usage?.output_tokens ?? 0;
    console.log(`[VISION] frames=${framePaths.length} input=${inputTokens} output=${outputTokens} model=${MODEL}`);

    const resultText = (claudeData.content ?? [])
      .filter((c: any) => c.type === "text")
      .map((c: any) => c.text)
      .join("\n")
      .trim();

    if (!resultText) {
      await admin
        .from("mate_pro_video_analyses")
        .update({ status: "failed", error_message: "Empty result from vision call" })
        .eq("id", analysisId);
      return json({ error: "Empty result from vision call", video_analysis_id: analysisId }, 500);
    }

    // ── 10. Persist result_text + status=complete ──────────────────────
    await admin
      .from("mate_pro_video_analyses")
      .update({
        result_text: resultText,
        status: "complete",
        completed_at: new Date().toISOString(),
      })
      .eq("id", analysisId);

    // ── 11. If conversation_id was provided, also insert assistant msg ─
    let messageId: string | null = null;
    if (conversationIdIn) {
      const { data: msg } = await admin
        .from("mate_pro_messages")
        .insert({
          conversation_id: conversationIdIn,
          agent_id: agent.id,
          role: "assistant",
          content: resultText,
          sub_agent: "coach",
          attachment_type: "video_analysis",
          attachment_ref: analysisId,
          attachment_meta: { focus, frames_used: framePaths.length, filename },
        })
        .select("id")
        .single();
      messageId = msg?.id ?? null;
    }

    return json({
      video_analysis_id: analysisId,
      status: "complete",
      result_text: resultText,
      message_id: messageId,
      frames_used: framePaths.length,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
    });
  } catch (err) {
    console.error("mate-pro-video-analyse error:", err);
    if (analysisId && admin) {
      await admin
        .from("mate_pro_video_analyses")
        .update({ status: "failed", error_message: String(err).slice(0, 500) })
        .eq("id", analysisId);
    }
    return json(
      { error: err instanceof Error ? err.message : "Unknown error", video_analysis_id: analysisId },
      500,
    );
  }
});

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function uint8ToBase64(bytes: Uint8Array): string {
  // Deno has native btoa() but it errors on non-ASCII bytes. Build the
  // binary string in 8KB chunks to avoid argument count limits on
  // String.fromCharCode for large frames.
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function json(body: unknown, status = 200): Response {
  // Same defensive escape as mate-pro-chat — see that file's header for why.
  const raw = JSON.stringify(body);
  let safe = "";
  for (let i = 0; i < raw.length; i++) {
    const cc = raw.charCodeAt(i);
    if ((cc >= 0x00 && cc <= 0x1F) || (cc >= 0x7F && cc <= 0x9F)) {
      safe += "\\u" + cc.toString(16).padStart(4, "0");
    } else {
      safe += raw[i];
    }
  }
  return new Response(safe, {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
