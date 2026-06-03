// creators-save-post
// -------------------------------------------------------------
// Server-to-server endpoint called by Make.com after the AI agent generates
// a "new_post" from a scraped competitor post. Inserts (or updates) a row
// in public.posts on behalf of the target user.
//
// Why a function instead of Make's native Supabase module:
//   1. Centralised validation + field normalisation (LinkedIn/Instagram).
//   2. Idempotent upsert on (user_id, apify_id) — re-scrapes don't duplicate.
//   3. Single audit trail (Edge logs) for every AI-generated post.
//
// Auth model:
//   This function is NOT called from the browser. It's called by Make with
//   a shared secret in the X-Webhook-Secret header. The function then uses
//   the Supabase SERVICE_ROLE key to bypass RLS and insert on behalf of any
//   user_id passed in the body.
//
// Request:
//   POST /functions/v1/creators-save-post
//   Headers:
//     X-Webhook-Secret: <WEBHOOK_SECRET env var>
//     Content-Type: application/json
//   Body:
//     {
//       "user_id":       string (uuid),   // required
//       "competitor_id": string (uuid),   // optional
//       "apify_id":      string,          // optional but recommended (idempotency)
//       "source_url":    string,
//       "content":       string,          // original scraped post text
//       "new_post":      string,          // AI-generated rewrite
//       "posted_at":     string (ISO),
//       "platform":      "linkedin" | "instagram"
//     }
//
// Response (200): { post: Post, created: boolean }
// Response (401): { error: "Invalid webhook secret" }
// Response (400): { error: "<validation message>" }
// Response (500): { error: "..." }
// -------------------------------------------------------------

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from "../_shared/cors.ts";

interface SavePostBody {
  user_id?: string;
  competitor_id?: string;
  apify_id?: string;
  source_url?: string;
  content?: string;
  new_post?: string;
  posted_at?: string;
  platform?: string;
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    // ── Shared-secret auth ──────────────────────────────────
    const expectedSecret = Deno.env.get("WEBHOOK_SECRET");
    if (!expectedSecret) {
      console.error("[creators-save-post] WEBHOOK_SECRET env var is not set");
      return json({ error: "Server misconfigured" }, 500);
    }
    const presentedSecret = req.headers.get("X-Webhook-Secret");
    if (presentedSecret !== expectedSecret) {
      return json({ error: "Invalid webhook secret" }, 401);
    }

    // ── Parse + validate ────────────────────────────────────
    let body: SavePostBody;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const user_id = body.user_id?.trim();
    if (!user_id) return json({ error: "user_id is required" }, 400);
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(user_id)) {
      return json({ error: "user_id must be a UUID" }, 400);
    }

    const platform = (body.platform ?? "linkedin").toLowerCase();
    if (!["linkedin", "instagram"].includes(platform)) {
      return json({ error: "platform must be 'linkedin' or 'instagram'" }, 400);
    }

    // ── Service-role client (bypasses RLS) ──────────────────
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    );

    const row = {
      user_id,
      competitor_id: body.competitor_id ?? null,
      apify_id: body.apify_id ?? null,
      source_url: body.source_url ?? null,
      content: body.content ?? null,
      new_post: body.new_post ?? null,
      posted_at: body.posted_at ?? null,
      platform,
    };

    // Upsert on (user_id, apify_id) if apify_id is provided; otherwise plain insert.
    // The unique partial index posts_user_apify_id_uniq enforces idempotency.
    let result;
    let created = true;

    if (row.apify_id) {
      // Check if it already exists so we can report created vs updated
      const { data: existing } = await supabase
        .from("posts")
        .select("id")
        .eq("user_id", row.user_id)
        .eq("apify_id", row.apify_id)
        .maybeSingle();

      if (existing) {
        created = false;
        const { data, error } = await supabase
          .from("posts")
          .update(row)
          .eq("id", existing.id)
          .select()
          .single();
        if (error) {
          console.error("[creators-save-post] update error:", error);
          return json({ error: error.message }, 500);
        }
        result = data;
      } else {
        const { data, error } = await supabase
          .from("posts")
          .insert(row)
          .select()
          .single();
        if (error) {
          console.error("[creators-save-post] insert error:", error);
          return json({ error: error.message }, 500);
        }
        result = data;
      }
    } else {
      const { data, error } = await supabase
        .from("posts")
        .insert(row)
        .select()
        .single();
      if (error) {
        console.error("[creators-save-post] insert error:", error);
        return json({ error: error.message }, 500);
      }
      result = data;
    }

    return json({ post: result, created }, 200);
  } catch (err) {
    console.error("[creators-save-post] unexpected error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
