// creators-get-posts
// -------------------------------------------------------------
// Returns posts that belong to the authenticated creator, newest first.
// Optionally filter by competitor_id (?competitor_id=<uuid>).
//
// Request:
//   GET /functions/v1/creators-get-posts
//   GET /functions/v1/creators-get-posts?competitor_id=<uuid>
//   Headers:
//     Authorization: Bearer <Supabase access_token>
//
// Response (200): { posts: Post[] }
// Response (401): { error: "..." }
// Response (500): { error: "..." }
//
// RLS handles user_id = auth.uid() automatically.
// -------------------------------------------------------------

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "GET") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return json({ error: "Missing Authorization header" }, 401);
    }

    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    // getUser() must receive the token explicitly — global headers
    // are forwarded to PostgREST, not to the Auth endpoint.
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    const url = new URL(req.url);
    const competitorId = url.searchParams.get("competitor_id");

    let query = supabase
      .from("posts")
      .select("id, competitor_id, apify_id, source_url, content, new_post, posted_at, platform, created_at")
      .order("created_at", { ascending: false })
      .limit(200);

    if (competitorId) {
      // Validate UUID-ish shape to avoid PostgREST 400s
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(competitorId)) {
        return json({ error: "competitor_id must be a UUID" }, 400);
      }
      query = query.eq("competitor_id", competitorId);
    }

    const { data, error } = await query;

    if (error) {
      console.error("[creators-get-posts] query error:", error);
      return json({ error: error.message }, 500);
    }

    return json({ posts: data ?? [] }, 200);
  } catch (err) {
    console.error("[creators-get-posts] unexpected error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
