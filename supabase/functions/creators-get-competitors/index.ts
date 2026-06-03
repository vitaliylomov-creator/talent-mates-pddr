// creators-get-competitors
// -------------------------------------------------------------
// Returns the list of competitors that belong to the authenticated
// creator, newest first.
//
// Request:
//   GET /functions/v1/creators-get-competitors
//   Headers:
//     Authorization: Bearer <Supabase access_token>
//
// Response (200):
//   { competitors: Competitor[] }
//
// Response (401): { error: "Missing Authorization header" | "Invalid or expired token" }
// Response (500): { error: "<message>" }
//
// Security model:
//   The Supabase client is constructed with the user's JWT, so every query
//   runs as that user. RLS on public.competitors enforces
//   user_id = auth.uid(). No manual user_id filter is needed here — but we
//   keep one client per request so requests can't leak across users.
// -------------------------------------------------------------

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from "../_shared/cors.ts";

serve(async (req) => {
  // CORS preflight
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

    // Per-request client carrying the caller's JWT in the global headers
    // so that PostgREST queries below run as that user and RLS applies.
    // SUPABASE_URL and SUPABASE_ANON_KEY are auto-injected by the Edge runtime.
    const supabase = createClient(
      Deno.env.get("SUPABASE_URL")!,
      Deno.env.get("SUPABASE_ANON_KEY")!,
      { global: { headers: { Authorization: authHeader } } },
    );

    // Verify the token resolves to a real user before querying.
    // getUser() must receive the token explicitly — the global headers
    // are forwarded to PostgREST, not to the Auth endpoint.
    const token = authHeader.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(token);
    if (userError || !user) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    // RLS applies user_id = auth.uid() automatically
    const { data, error } = await supabase
      .from("competitors")
      .select("id, name, profile_url, platform, niche_tags, status, created_at, updated_at")
      .order("created_at", { ascending: false });

    if (error) {
      console.error("[creators-get-competitors] query error:", error);
      return json({ error: error.message }, 500);
    }

    return json({ competitors: data ?? [] }, 200);
  } catch (err) {
    console.error("[creators-get-competitors] unexpected error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
