// ────────────────────────────────────────────────────────────────────────────
// mate-pro-chat — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-chat \
//            --project-ref zlkzjeaojpxzccpovygk
//          (JWT verification ON — agents call this signed-in)
//
// What it does
// ────────────
// Agent-side chat. Reuses the four MATE personas 1:1 from mate-chat (loaded
// from _shared/mate-personas.ts as a verbatim snapshot). The differences vs
// mate-chat:
//   - Audience: a licensed football agent, not the player themselves.
//     Solved by an <agent_audience_overlay> block prepended to the persona,
//     reframing "the player" as "your client below" and shifting to peer-to-
//     peer voice. Persona text itself is unchanged (spec § 0 rule 4).
//   - Context payload: agent profile + (optional) active-client profile,
//     instead of mate-chat's player profile.
//   - Tools: 7 shared tools from _shared/mate-tools.ts (web/places/weather/
//     UK trains/FIFA regs/football data/world football data) PLUS two new
//     agent-specific tools: list_clients and get_client. player_training_log
//     deliberately dropped — agents have no RLS access to PDDR tables.
//   - Persistence: writes to mate_pro_conversations + mate_pro_messages
//     (created in migration 0005). Conversation threads are first-class
//     entities so the dashboard sidebar can show them grouped by client
//     and ordered by last_message_at.
//
// Why non-streaming
// ─────────────────
// The spec mentioned SSE but mate-chat itself doesn't stream — it runs the
// tool-use loop server-side and returns one JSON payload. Matching that
// pattern keeps the frontend integration identical to Players (spinner →
// rendered response) and avoids the complexity of interleaving stream
// tokens with tool_result blocks.
//
// Request body
// ────────────
//   {
//     "conversation_id": "<uuid>" | null,    // null = start a new thread
//     "client_id":       "<uuid>" | null,    // null = no active client
//     "sub_agent":       "auto"|"legal"|"coach"|"analyst"|"concierge",
//     "message":         "What does FFAR Art 14 say about commission caps?",
//     "pdf_base64":      "..." (optional),   // contract attachment
//     "pdf_name":        "agreement.pdf"     // optional
//   }
//
// Response
// ────────
//   200 {
//     conversation_id, message_id,
//     sub_agent, response,
//     tools_used: string[], iterations, input_tokens, output_tokens, had_pdf
//   }
//   400 { error }   — bad input
//   401 { error }   — missing/invalid JWT
//   403 { error }   — caller is not a MATE Pro agent
//   404 { error }   — client_id or conversation_id not owned by agent
//   500 { error }   — Anthropic / DB error
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { MATE_PERSONAS } from "../_shared/mate-personas.ts";
import { MATE_AGENT_PERSONAS } from "../_shared/mate-personas-agent.ts";
import {
  TOOLS_SHARED,
  tool_web_search,
  tool_places_search,
  tool_weather,
  tool_uk_train_times,
  tool_fifa_regulations_search,
  tool_football_data,
  tool_world_football_data,
} from "../_shared/mate-tools.ts";

const MAX_ITERATIONS = 5;
const MODEL = "claude-sonnet-4-6";
const HISTORY_LIMIT = 20;

// ─────────────────────────────────────────────
// AGENT-SPECIFIC TOOL IMPLEMENTATIONS
// Both tools enforce agent_id scoping at the query level (defence in depth —
// RLS would block cross-agent reads anyway since we authenticate as the
// caller, but we pass agent_id explicitly so the service-role client also
// stays isolated).
// ─────────────────────────────────────────────

async function tool_list_clients(
  supabase: any,
  agentId: string,
  filters: {
    position?: string;
    league?: string;
    status?: string;
    contract_expires_before?: string;
  }
): Promise<string> {
  let q = supabase
    .from("mate_pro_clients")
    .select(
      "id, first_name, last_name, date_of_birth, nationality, position_primary, dominant_foot, current_club, current_league, contract_expires, status, commission_pct"
    )
    .eq("agent_id", agentId)
    .order("status", { ascending: true })
    .order("last_name", { ascending: true });

  if (filters.position) q = q.eq("position_primary", filters.position);
  if (filters.league) q = q.ilike("current_league", `%${filters.league}%`);
  if (filters.status) q = q.eq("status", filters.status);
  if (filters.contract_expires_before) q = q.lte("contract_expires", filters.contract_expires_before);

  const { data, error } = await q;
  if (error) return `Error querying clients: ${error.message}`;
  if (!data || data.length === 0) return "No clients match those criteria.";

  return JSON.stringify(
    data.map((c: any) => ({
      id: c.id,
      name: `${c.first_name} ${c.last_name}`,
      dob: c.date_of_birth,
      nationality: c.nationality,
      position: c.position_primary,
      foot: c.dominant_foot,
      club: c.current_club,
      league: c.current_league,
      contract_expires: c.contract_expires,
      status: c.status,
      commission_pct: c.commission_pct,
    })),
    null,
    2
  );
}

async function tool_get_client(
  supabase: any,
  agentId: string,
  input: { client_id?: string; client_name?: string }
): Promise<string> {
  let q = supabase
    .from("mate_pro_clients")
    .select("*")
    .eq("agent_id", agentId)
    .limit(1);

  if (input.client_id) {
    q = q.eq("id", input.client_id);
  } else if (input.client_name) {
    const parts = input.client_name.trim().split(/\s+/);
    if (parts.length === 1) {
      q = q.or(`first_name.ilike.%${parts[0]}%,last_name.ilike.%${parts[0]}%`);
    } else {
      q = q.ilike("first_name", `%${parts[0]}%`).ilike("last_name", `%${parts.slice(1).join(" ")}%`);
    }
  } else {
    return "Provide client_id or client_name.";
  }

  const { data, error } = await q.maybeSingle();
  if (error) return `Error querying client: ${error.message}`;
  if (!data) return "No matching client in your roster.";
  return JSON.stringify(data, null, 2);
}

// ─────────────────────────────────────────────
// AGENT TOOL SCHEMAS
// ─────────────────────────────────────────────
const AGENT_TOOLS = [
  {
    name: "list_clients",
    description:
      "List the agent's own clients with optional filters. Use whenever the agent asks about their roster as a whole, multiple clients at once, or wants to find clients matching specific criteria (position, league, contract expiry, status). Returns a JSON array of client summaries. Does NOT include career history or notes — use get_client for the deep profile.",
    input_schema: {
      type: "object",
      properties: {
        position: {
          type: "string",
          description: "Filter by playing position (e.g. 'Striker', 'Centre Back', 'Defensive Midfielder').",
        },
        league: {
          type: "string",
          description: "Filter by current league, case-insensitive substring (e.g. 'Premier League', 'Serie A').",
        },
        status: {
          type: "string",
          enum: ["active", "prospect", "dormant"],
          description: "Filter by representation status with this agent.",
        },
        contract_expires_before: {
          type: "string",
          description: "ISO date (YYYY-MM-DD). Lists clients whose contracts expire on or before this date.",
        },
      },
    },
  },
  {
    name: "get_client",
    description:
      "Fetch the full profile of one specific client by name or UUID — includes career history, notes for MATE, representation notes, commission %, physical profile, and all other stored fields. Use when the agent asks about a specific client OTHER than the active one already in the system prompt, or when they need fields not in the active <client_context> block.",
    input_schema: {
      type: "object",
      properties: {
        client_id: { type: "string", description: "Exact UUID if known." },
        client_name: {
          type: "string",
          description: "Single name or 'First Last' — case-insensitive substring match against the agent's own roster.",
        },
      },
    },
  },
];

const TOOLS = [...TOOLS_SHARED, ...AGENT_TOOLS];

// ─────────────────────────────────────────────
// TOOL ROUTER
// ─────────────────────────────────────────────
async function executeTool(
  toolName: string,
  toolInput: any,
  supabase: any,
  agentId: string
): Promise<string> {
  try {
    switch (toolName) {
      case "web_search":
        return await tool_web_search(toolInput.query, toolInput.country_code);
      case "places_search":
        return await tool_places_search(toolInput.query, toolInput.location);
      case "weather":
        return await tool_weather(toolInput.city, toolInput.country_code);
      case "uk_train_times":
        return await tool_uk_train_times(toolInput.from_station, toolInput.to_station);
      case "fifa_regulations_search":
        return await tool_fifa_regulations_search(supabase, toolInput.query, toolInput.top_k ?? 5);
      case "football_data":
        return await tool_football_data(toolInput.type, toolInput.league, toolInput.team_name);
      case "world_football_data":
        return await tool_world_football_data(toolInput.type, toolInput.league, toolInput.team_name);
      case "list_clients":
        return await tool_list_clients(supabase, agentId, toolInput);
      case "get_client":
        return await tool_get_client(supabase, agentId, toolInput);
      default:
        return `Unknown tool: ${toolName}`;
    }
  } catch (err) {
    return `Tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}`;
  }
}

// ─────────────────────────────────────────────
// AGENT PERSONA DETECTION — keyword router from mate-chat L689-711, unchanged
// ─────────────────────────────────────────────
function detectAgentType(message: string, specifiedAgent: string | null): string {
  if (specifiedAgent && specifiedAgent !== "auto") return specifiedAgent;
  const m = message.toLowerCase();
  if (
    m.includes("contract") || m.includes("legal") || m.includes("fifa") ||
    m.includes("clause") || m.includes("regulation") || m.includes("transfer fee") ||
    m.includes("release clause") || m.includes("agent fee") || m.includes("ffar")
  ) return "legal";
  if (
    m.includes("train") || m.includes("fitness") || m.includes("workout") ||
    m.includes("injury") || m.includes("recovery") || m.includes("nutrition") ||
    m.includes("speed") || m.includes("strength")
  ) return "coach";
  if (
    m.includes("market") || m.includes("value") || m.includes("league") ||
    m.includes("standing") || m.includes("fixture") || m.includes("transfer") ||
    m.includes("club") || m.includes("position") || m.includes("stats")
  ) return "analyst";
  return "concierge";
}

// ─────────────────────────────────────────────
// SYSTEM PROMPT BUILDER
// agent_context + client_context (or no_client_active) + audience overlay +
// untouched persona + always-on date + tool guidance.
// ─────────────────────────────────────────────
function buildSystemPrompt(
  agent: any,
  client: any | null,
  agentType: string,
  hasPDF: boolean
): string {
  const now = new Date();
  const dateStr = now.toLocaleDateString("en-GB", {
    weekday: "long", year: "numeric", month: "long", day: "numeric",
  });
  const timeStr = now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });

  const agentBlock = `
<agent_context>
You are speaking with a licensed football agent.
Name: ${agent.first_name} ${agent.last_name}
Agency: ${agent.agency_name ?? "not provided"}
Country of operation: ${agent.country_of_operation ?? agent.ffar_country}
Years of experience: ${agent.years_experience ?? "not provided"}
Specialisation: ${agent.specialisation ?? "not provided"}
FFAR licence: ${agent.ffar_licence} (country: ${agent.ffar_country})
${agent.is_founding ? `Founding Agent #${agent.founding_number}.` : ""}
</agent_context>`.trim();

  const clientBlock = client
    ? `
<client_context>
Currently working on this client:
Name: ${client.first_name} ${client.last_name}
DOB: ${client.date_of_birth ?? "not provided"}
Nationality: ${client.nationality ?? "not provided"}
Position: ${client.position_primary ?? "not provided"}, ${client.dominant_foot ?? "foot unknown"}-footed
Height: ${client.height_cm ? client.height_cm + "cm" : "not provided"} | Weight: ${client.weight_kg ? client.weight_kg + "kg" : "not provided"}
Current club: ${client.current_club ?? "not provided"}, ${client.current_league ?? "league not provided"}
Contract expires: ${client.contract_expires ?? "not provided"}
Representation status: ${client.status}
Commission: ${client.commission_pct ? client.commission_pct + "%" : "not provided"}
Representation notes: ${client.representation_notes ?? "none"}
Career history: ${client.career_history ?? "not provided"}
Notes for MATE: ${client.notes_for_mate ?? "none"}
</client_context>`.trim()
    : `<no_client_active>The agent has not selected a specific client. Treat this as a general or prospecting query. If the question would benefit from client context, you may call list_clients to scan their roster, or ask the agent which client they have in mind.</no_client_active>`;

  // Agent-audience overlay retargets a player-side persona for the agent
  // operator. Skipped entirely when the persona is already agent-native
  // (e.g. agent-side Legal SKILL.md) — the overlay would be misleading.
  const audienceOverlay = `
<agent_audience_overlay>
This conversation is happening inside MATE Pro, the B2B product for licensed football agents. The persona below was originally written for direct conversations with the player. For this conversation:
  - Any phrase like "the player", "the footballer", "you" in the persona refers to the AGENT'S CLIENT described in the <client_context> block above. The reader of your output is the AGENT, not the player.
  - The agent is FFAR-licensed and a peer professional. Skip beginner-level explanations of regulations they work with daily. Get to insight quickly.
  - If the persona instructs you to call a tool that does not exist in this context (e.g. player_training_log, agents have no PDDR access), IGNORE that instruction. Use the tools that ARE available: web_search, places_search, weather, uk_train_times, fifa_regulations_search, football_data, world_football_data, list_clients, get_client.
  - When the agent asks about their roster as a whole, or about multiple clients, prefer list_clients. When they ask about a specific client other than the one in <client_context>, use get_client.
  - Do NOT echo the words "race engineer", "Edge OS" or "MATE Pro" back at the agent. They are framing notes for you, not phrases to repeat.
</agent_audience_overlay>`.trim();

  // Formatting constraints apply universally: agent-native SKILL.md files
  // already contain matching rules in their Section 6.2, this block is the
  // belt-and-suspenders defence in case any persona slips its own rules.
  const formattingConstraints = `
<formatting_constraints>
Output rules for this conversation.

Do not use:
  - Markdown headers of any level. No "# ", "## ", "### ", "#### ". The reader is on a phone between meetings. They read paragraphs, not section walls.
  - Markdown tables. No "| Column | Column |" syntax, no "|---|---|" separator rows. If you have three to five comparison points, write them as a short sentence list or as a tight bulleted list, never as a table.
  - Horizontal rules ("---" or "***").
  - Em-dashes ("—") for stylistic pause. Use a period and start a new sentence. Two short sentences beat one long sentence stitched with an em-dash.
  - Emoji of any kind. No checkmarks, no warning triangles, no arrows, no bullet symbols beyond standard Markdown "-" or "*". If you need to flag risk, write the word "Flag:" or "Risk:".
  - Decorative prefixes like ">>" or "==="
  - Repeated bolding. Bold only the SPECIFIC fact the agent must remember: a number, a date, an article reference, a name. Maximum two or three bold spans in any response.

Do use:
  - Plain prose in complete sentences as the default.
  - Short paragraphs of two to four sentences.
  - Tight bulleted or numbered lists only when ordering genuinely matters (steps 1, 2, 3) or when items truly do not flow as prose.
  - Inline code spans for article references like \`FFAR Art. 15\` or contract clause numbers when precision matters.

Tone: senior peer to senior peer. The reader is a licensed agent with reputation and clients. Substance over visual hierarchy. Treat them as someone whose time you respect.
</formatting_constraints>`.trim();

  const pdfBlockText = hasPDF
    ? `\nA contract document has been uploaded. Analyse it thoroughly as the Legal Advisor and cross-reference with fifa_regulations_search where relevant.`
    : "";

  // Persona selection: prefer agent-native SKILL.md when one exists for this
  // sub-agent type. Falls back to the player-side snapshot from mate-chat
  // wrapped by the audience overlay for sub-agents we have not yet rewritten.
  const agentNativePersona = MATE_AGENT_PERSONAS[agentType];
  let persona: string;
  if (agentNativePersona) {
    // SKILL.md is already written for the agent audience. Append the PDF
    // note only when relevant (agent-side Legal handles PDFs the same way).
    persona = agentNativePersona + (hasPDF ? "\n\n" + pdfBlockText.trim() : "");
  } else {
    const personaRaw = MATE_PERSONAS[agentType] ?? MATE_PERSONAS.concierge;
    // mate-chat originally injects pdfBlock inline at end of the Legal
    // persona via ${pdfBlock}. We preserved that token as literal text in
    // the snapshot and resolve it here so the rest of the persona stays
    // byte-identical to the player-side production version.
    persona = personaRaw.replace("${pdfBlock}", pdfBlockText);
  }
  const useAgentNative = !!agentNativePersona;

  const toolGuidance = `
Tool usage notes:
  • fifa_regulations_search — pgvector-backed RAG over FFAR, RSTP, CAS, national FA texts. Cite results with [T1]/[T2]/[T3] format from the Legal persona.
  • football_data + world_football_data — live league tables, fixtures, results. Use world_football_data for leagues outside the free-tier set (Ukrainian Premier League, Scottish Premiership, Belgian Pro League, etc.).
  • list_clients / get_client — agent's OWN roster only, scoped server-side. Cannot leak across agents.
`.trim();

  const dateBlock = `Today: ${dateStr} | Time: ${timeStr} (UK)`;

  const overlayBlock = useAgentNative
    ? formattingConstraints
    : audienceOverlay + "\n\n" + formattingConstraints;

  return `${overlayBlock}

${persona}

${agentBlock}

${clientBlock}

${dateBlock}

${toolGuidance}

Keep responses focused and premium. The agent reads this between meetings. Never pad.`;
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

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const ANTHROPIC_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";

    if (!ANTHROPIC_KEY) {
      return json({ error: "Server missing ANTHROPIC_API_KEY" }, 500);
    }

    // ── 1. Authenticate caller, derive agent_id ────────────────────────
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Invalid or expired token" }, 401);
    const callerUserId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: agent, error: agentErr } = await admin
      .from("mate_pro_agents")
      .select("*")
      .eq("user_id", callerUserId)
      .maybeSingle();

    if (agentErr) return json({ error: agentErr.message }, 500);
    if (!agent) return json({ error: "Caller is not a registered MATE Pro agent" }, 403);

    // ── 1b. Subscription gate ──────────────────────────────────────────
    // Enforce only when MATE_PRO_BILLING_ENFORCED=true. During early beta
    // the flag is off so warm-network agents can use the product without
    // friction. Flip the env var to true once the conversion flow is
    // validated end-to-end.
    if ((Deno.env.get("MATE_PRO_BILLING_ENFORCED") ?? "false") === "true") {
      const { data: hasAccess } = await admin.rpc("mate_pro_has_active_access", { p_agent_id: agent.id });
      if (!hasAccess) {
        return json({
          error: "Subscribe to continue using MATE Pro.",
          checkout_required: true,
        }, 402);
      }
    }

    // ── 2. Parse body ──────────────────────────────────────────────────
    let body: Record<string, any>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be valid JSON" }, 400);
    }

    const message = typeof body.message === "string" ? body.message.trim() : "";
    const conversationIdIn: string | null = body.conversation_id ?? null;
    const clientIdIn: string | null = body.client_id ?? null;
    const specifiedAgent: string = body.sub_agent ?? "auto";
    const pdfBase64: string | null = body.pdf_base64 ?? null;
    const pdfName: string | null = body.pdf_name ?? null;

    if (!message && !pdfBase64) {
      return json({ error: "message or pdf_base64 required" }, 400);
    }

    // ── 3. Load active client (if any), enforce ownership ─────────────
    let client: any = null;
    if (clientIdIn) {
      const { data: c, error: cErr } = await admin
        .from("mate_pro_clients")
        .select("*")
        .eq("id", clientIdIn)
        .eq("agent_id", agent.id)
        .maybeSingle();
      if (cErr) return json({ error: cErr.message }, 500);
      if (!c) return json({ error: "Client not found in your roster" }, 404);
      client = c;
    }

    // ── 4. Get or create conversation thread ──────────────────────────
    let conversationId = conversationIdIn;
    let conversation: any = null;
    if (conversationId) {
      const { data: conv, error: convErr } = await admin
        .from("mate_pro_conversations")
        .select("*")
        .eq("id", conversationId)
        .eq("agent_id", agent.id)
        .maybeSingle();
      if (convErr) return json({ error: convErr.message }, 500);
      if (!conv) return json({ error: "Conversation not found" }, 404);
      conversation = conv;
    } else {
      const title = message.slice(0, 60) || (pdfName ? `PDF: ${pdfName}` : "New conversation");
      const { data: newConv, error: newConvErr } = await admin
        .from("mate_pro_conversations")
        .insert({
          agent_id: agent.id,
          client_id: clientIdIn,
          title,
          sub_agent: specifiedAgent,
        })
        .select("*")
        .single();
      if (newConvErr || !newConv) {
        return json({ error: `Could not create conversation: ${newConvErr?.message}` }, 500);
      }
      conversation = newConv;
      conversationId = newConv.id;
    }

    // ── 5. Choose persona ─────────────────────────────────────────────
    const agentType = detectAgentType(message, specifiedAgent);

    // ── 6. Load recent history (most recent N, then reverse) ─────────
    const { data: history } = await admin
      .from("mate_pro_messages")
      .select("role, content")
      .eq("conversation_id", conversationId)
      .order("created_at", { ascending: false })
      .limit(HISTORY_LIMIT);

    const conversationHistory = (history ?? [])
      .reverse()
      .map((m: any) => ({ role: m.role, content: m.content }));

    // ── 7. Persist user message immediately so it appears in history
    //       even if the assistant call fails midway. ─────────────────
    const { data: userMsg, error: userMsgErr } = await admin
      .from("mate_pro_messages")
      .insert({
        conversation_id: conversationId,
        agent_id: agent.id,
        role: "user",
        content: message + (pdfName ? ` [PDF: ${pdfName}]` : ""),
        sub_agent: agentType,
        attachment_type: pdfBase64 ? "pdf" : null,
        attachment_meta: pdfName ? { filename: pdfName } : null,
      })
      .select("id")
      .single();

    if (userMsgErr || !userMsg) {
      return json({ error: `Could not save user message: ${userMsgErr?.message}` }, 500);
    }

    // ── 8. Build system prompt ────────────────────────────────────────
    const systemPrompt = buildSystemPrompt(agent, client, agentType, !!pdfBase64);

    // ── 9. Build user content for this turn ───────────────────────────
    const userContent: any[] = [];
    if (pdfBase64) {
      userContent.push({
        type: "document",
        source: { type: "base64", media_type: "application/pdf", data: pdfBase64 },
      });
      const txt = message || `Please analyse this contract for ${client ? client.first_name + " " + client.last_name : "this client"}.`;
      userContent.push({ type: "text", text: txt });
    } else {
      userContent.push({ type: "text", text: message });
    }

    const messages: any[] = [
      ...conversationHistory,
      { role: "user", content: userContent },
    ];

    // ── 10. Tool-use agent loop ──────────────────────────────────────
    let iteration = 0;
    let finalText = "";
    let totalInputTokens = 0;
    let totalOutputTokens = 0;
    const toolsUsed: string[] = [];
    let hadToolUse = false;

    while (iteration < MAX_ITERATIONS) {
      const claudeRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "pdfs-2024-09-25",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 4000,
          system: systemPrompt,
          tools: TOOLS,
          messages,
        }),
      });

      if (!claudeRes.ok) {
        const errText = await claudeRes.text();
        console.error("Claude API error:", errText);
        return json({ error: "Claude API error", details: errText }, 500);
      }

      const claudeData = await claudeRes.json();
      totalInputTokens += claudeData.usage?.input_tokens ?? 0;
      totalOutputTokens += claudeData.usage?.output_tokens ?? 0;

      const content = claudeData.content ?? [];
      const toolUseBlocks = content.filter((c: any) => c.type === "tool_use");

      if (toolUseBlocks.length === 0 || claudeData.stop_reason === "end_turn") {
        finalText = content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
        break;
      }

      hadToolUse = true;
      const toolResults = await Promise.all(
        toolUseBlocks.map(async (tu: any) => {
          toolsUsed.push(tu.name);
          const result = await executeTool(tu.name, tu.input, admin, agent.id);
          console.log(`[TOOL] ${tu.name}`, JSON.stringify(tu.input).slice(0, 200), "→", typeof result === "string" ? result.slice(0, 200) : "?");
          return {
            type: "tool_result",
            tool_use_id: tu.id,
            content: result,
          };
        })
      );

      messages.push({ role: "assistant", content });
      messages.push({ role: "user", content: toolResults });
      iteration++;
    }

    // ── 11. Force one final synthesis if we hit MAX_ITERATIONS ───────
    if (!finalText) {
      const synthRes = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": ANTHROPIC_KEY,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 2000,
          system: systemPrompt,
          tool_choice: { type: "none" },
          tools: TOOLS,
          messages: [
            ...messages,
            {
              role: "user",
              content:
                "Based on everything you have researched above, give your best complete answer now. Do not call any more tools.",
            },
          ],
        }),
      });

      if (synthRes.ok) {
        const synthData = await synthRes.json();
        totalInputTokens += synthData.usage?.input_tokens ?? 0;
        totalOutputTokens += synthData.usage?.output_tokens ?? 0;
        finalText = (synthData.content ?? [])
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")
          .trim();
      }

      if (!finalText) {
        finalText =
          "I researched this thoroughly but couldn't compile a complete answer. Try rephrasing or breaking it into smaller questions.";
      }
    }

    // ── 12. Persist assistant message ────────────────────────────────
    const { data: assistantMsg, error: assistantErr } = await admin
      .from("mate_pro_messages")
      .insert({
        conversation_id: conversationId,
        agent_id: agent.id,
        role: "assistant",
        content: finalText,
        sub_agent: agentType,
      })
      .select("id")
      .single();

    if (assistantErr || !assistantMsg) {
      // The user message is already saved; return the text anyway so the
      // dashboard can render it. Log the persistence failure for ops.
      console.error("Failed to persist assistant message:", assistantErr);
    }

    return json({
      conversation_id: conversationId,
      message_id: assistantMsg?.id ?? null,
      sub_agent: agentType,
      response: finalText,
      tools_used: toolsUsed,
      iterations: iteration,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      had_pdf: !!pdfBase64,
      had_tool_use: hadToolUse,
    });
  } catch (err) {
    console.error("mate-pro-chat error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  // Defensive: walk JSON.stringify output and force-escape any control char
  // (U+0000-U+001F, U+007F-U+009F) as \uXXXX. A 2026-06-23 smoke test in
  // prod showed raw 0x0a bytes intermittently surviving in the response
  // field, breaking strict JSON.parse on the frontend. JSON.stringify alone
  // produces correctly escaped output in standalone Node; this loop is a
  // no-op in that case but keeps the wire output strict-RFC8259 either way.
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
