// ────────────────────────────────────────────────────────────────────────────
// mate-pro-delete-account — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-delete-account \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// What it does
// ────────────
// Hard-delete an agent's account on their explicit request (GDPR Article 17,
// right to erasure). Wipes everything we hold:
//   - auth.users row (cascades via FK on mate_pro_agents → cascades again
//     to mate_pro_clients, mate_pro_conversations, mate_pro_messages,
//     mate_pro_video_analyses thanks to ON DELETE CASCADE in migration 0005)
//   - Storage objects under the agent's folder in both mate-pro-frames and
//     mate-pro-videos buckets (storage does NOT cascade from auth.users —
//     we list and delete explicitly)
//
// Not touched
// ───────────
//   - mate_pro_founding_counter (the founding slot stays consumed; we do
//     not return the number to the pool because that would let bad actors
//     game the Founding 100 promotion via delete-and-reregister loops)
//
// Auth
// ────
// Caller must present a valid JWT for the same user_id being deleted. The
// function refuses to delete any other account.
//
// Request body
// ────────────
//   none (user_id is derived from the JWT)
//
// Response
// ────────
//   200 { ok: true, deleted_agent_id, deleted_clients, deleted_conversations,
//                   deleted_frames, deleted_videos }
//   401 { error }    — missing/invalid JWT
//   500 { error }    — Supabase error during deletion
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
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

    // ── 1. Authenticate ────────────────────────────────────────────────
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: "Invalid or expired token" }, 401);
    }
    const userId = userData.user.id;

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── 2. Resolve agent_id (if any) for accurate counts + storage prefix
    const { data: agent } = await admin
      .from("mate_pro_agents")
      .select("id")
      .eq("user_id", userId)
      .maybeSingle();

    const agentId = agent?.id ?? null;
    let deletedClients = 0;
    let deletedConversations = 0;
    let deletedFrames = 0;
    let deletedVideos = 0;

    if (agentId) {
      // Pre-counts (for the response summary; cascade does the actual work)
      const { count: clientCount } = await admin
        .from("mate_pro_clients")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agentId);
      deletedClients = clientCount ?? 0;

      const { count: convCount } = await admin
        .from("mate_pro_conversations")
        .select("id", { count: "exact", head: true })
        .eq("agent_id", agentId);
      deletedConversations = convCount ?? 0;

      // ── 3. Storage cleanup (storage does NOT cascade from auth.users)
      for (const bucket of ["mate-pro-frames", "mate-pro-videos"]) {
        try {
          // Recursive list under the agent_id prefix
          const all = await listAll(admin, bucket, agentId);
          if (all.length > 0) {
            const { error: rmErr } = await admin.storage.from(bucket).remove(all);
            if (!rmErr) {
              if (bucket === "mate-pro-frames") deletedFrames = all.length;
              else deletedVideos = all.length;
            } else {
              console.error(`Storage cleanup failed for ${bucket}:`, rmErr);
            }
          }
        } catch (e) {
          console.error(`Storage list failed for ${bucket}:`, e);
        }
      }
    }

    // ── 4. Delete the auth user — cascades through all mate_pro_* tables
    const { error: delErr } = await admin.auth.admin.deleteUser(userId);
    if (delErr) {
      return json({ error: `Could not delete auth user: ${delErr.message}` }, 500);
    }

    return json({
      ok: true,
      deleted_agent_id: agentId,
      deleted_clients: deletedClients,
      deleted_conversations: deletedConversations,
      deleted_frames: deletedFrames,
      deleted_videos: deletedVideos,
    });
  } catch (err) {
    console.error("mate-pro-delete-account error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

// Recursively list every object under {agentId}/... in the given bucket.
// Supabase storage list() is non-recursive; we walk one level at a time.
async function listAll(
  admin: any,
  bucket: string,
  agentId: string,
): Promise<string[]> {
  const out: string[] = [];
  const queue: string[] = [agentId];
  while (queue.length > 0) {
    const prefix = queue.shift()!;
    const { data, error } = await admin.storage.from(bucket).list(prefix, {
      limit: 1000,
      offset: 0,
    });
    if (error || !data) continue;
    for (const item of data) {
      const fullPath = prefix + "/" + item.name;
      // Files in Supabase storage have an id; "folders" have id === null
      if (item.id) {
        out.push(fullPath);
      } else {
        queue.push(fullPath);
      }
    }
  }
  return out;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
