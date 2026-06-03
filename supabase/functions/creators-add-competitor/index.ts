// creators-add-competitor
// -------------------------------------------------------------
// Creates a new competitor for the authenticated creator and (optionally)
// triggers a Make webhook that kicks off an Apify scrape.
//
// Request:
//   POST /functions/v1/creators-add-competitor
//   Headers:
//     Authorization: Bearer <Supabase access_token>
//     Content-Type: application/json
//   Body:
//     {
//       "name":        string,          // required — display name
//       "profile_url": string,          // required — LinkedIn or Instagram URL
//       "platform":    "linkedin" | "instagram",  // optional, default "linkedin"
//       "niche_tags":  string[]         // optional
//     }
//
// Response (201): { competitor: Competitor, scrape_triggered: boolean }
// Response (400): { error: "<validation message>" }
// Response (401): { error: "..." }
// Response (409): { error: "Competitor with this profile URL already exists" }
// Response (500): { error: "..." }
//
// Apify trigger:
//   If env var APIFY_TRIGGER_WEBHOOK_URL is set, this function POSTs the new
//   competitor to that webhook so a Make scenario can fire the right Apify
//   actor (LinkedIn or Instagram). Failure of the trigger does NOT roll back
//   the DB insert — the row stays, scrape_triggered will be false, and the
//   user can retry from the UI.
// -------------------------------------------------------------

import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.39.3";
import { corsHeaders } from "../_shared/cors.ts";

interface AddCompetitorBody {
  name?: string;
  profile_url?: string;
  platform?: string;
  niche_tags?: string[];
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
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

    // ── Parse + validate ────────────────────────────────────
    let body: AddCompetitorBody;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const name = body.name?.trim();
    const profile_url = body.profile_url?.trim();
    const platform = (body.platform ?? "linkedin").toLowerCase();
    const niche_tags = Array.isArray(body.niche_tags) ? body.niche_tags : [];

    if (!name) return json({ error: "name is required" }, 400);
    if (!profile_url) return json({ error: "profile_url is required" }, 400);
    if (!["linkedin", "instagram"].includes(platform)) {
      return json({ error: "platform must be 'linkedin' or 'instagram'" }, 400);
    }

    // ── Insert (RLS sets user_id check via WITH CHECK policy) ──
    const { data: competitor, error: insertError } = await supabase
      .from("competitors")
      .insert({
        user_id: user.id,
        name,
        profile_url,
        platform,
        niche_tags,
        status: "active",
      })
      .select()
      .single();

    if (insertError) {
      // Unique violation on (user_id, profile_url)
      if (insertError.code === "23505") {
        return json({ error: "Competitor with this profile URL already exists" }, 409);
      }
      console.error("[creators-add-competitor] insert error:", insertError);
      return json({ error: insertError.message }, 500);
    }

    // ── Trigger Apify via Make webhook (best-effort) ──────────
    let scrape_triggered = false;
    const triggerUrl = Deno.env.get("APIFY_TRIGGER_WEBHOOK_URL");
    if (triggerUrl) {
      try {
        const triggerRes = await fetch(triggerUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            competitor_id: competitor.id,
            user_id: user.id,
            name: competitor.name,
            profile_url: competitor.profile_url,
            platform: competitor.platform,
          }),
        });
        scrape_triggered = triggerRes.ok;
        if (!triggerRes.ok) {
          console.warn("[creators-add-competitor] trigger non-2xx:", triggerRes.status);
        }
      } catch (e) {
        console.warn("[creators-add-competitor] trigger failed:", e);
      }
    }

    return json({ competitor, scrape_triggered }, 201);
  } catch (err) {
    console.error("[creators-add-competitor] unexpected error:", err);
    return json({ error: (err as Error).message }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
