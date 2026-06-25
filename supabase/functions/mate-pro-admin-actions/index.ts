// ────────────────────────────────────────────────────────────────────────────
// mate-pro-admin-actions — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-admin-actions \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// What it does
// ────────────
// Single endpoint that backs the founder's admin page (mate-pro-admin.html).
// All four operations gated by email allowlist; only those emails may call.
//
//   { action: "list" }
//     Returns every mate_pro_agents row joined with the active subscription
//     (if any), sorted by creation date desc. Lets the founder eyeball who
//     registered and where each agent stands on verification + billing.
//
//   { action: "verify", agent_id }
//     Sets ffar_verified=true and ffar_verified_at=now() on the row.
//
//   { action: "reject", agent_id }
//     Sets ffar_verified=false (explicit rejection — agent is still in the
//     system but loses the Founding €149 eligibility window).
//
//   { action: "cancel_subscription", agent_id }
//     Calls Stripe to set cancel_at_period_end=true on the agent's active
//     subscription. Founder uses this during the test window to make sure
//     no real charges fire on their own test card.
//
// Allowed admins
// ──────────────
// Edit ADMIN_EMAILS below. For initial launch: founder only.
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const ADMIN_EMAILS = new Set<string>([
  "vitaliylomov@gmail.com",
]);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) return json({ error: "Missing Authorization header" }, 401);

    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY") ?? "";

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Invalid or expired token" }, 401);

    const email = (userData.user.email ?? "").toLowerCase();
    if (!ADMIN_EMAILS.has(email)) {
      return json({ error: "Not authorized" }, 403);
    }

    let body: any;
    try { body = await req.json(); } catch { return json({ error: "Bad JSON" }, 400); }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    switch (body.action) {
      case "list": {
        const { data: agents, error } = await admin
          .from("mate_pro_agents")
          .select(`
            id, user_id, first_name, last_name, email,
            ffar_licence, ffar_country, ffar_verified, ffar_verified_at,
            agency_name, country_of_operation,
            founding_number, founding_window_ends_at,
            created_at
          `)
          .order("created_at", { ascending: false });
        if (error) return json({ error: error.message }, 500);

        // Pull active sub per agent in one query, then attach
        const agentIds = (agents ?? []).map(a => a.id);
        const { data: subs } = agentIds.length > 0
          ? await admin
              .from("mate_pro_subscriptions")
              .select("agent_id, plan, status, trial_ends_at, current_period_end, cancel_at, stripe_subscription_id")
              .in("agent_id", agentIds)
              .in("status", ["trialing", "active", "past_due"])
              .order("created_at", { ascending: false })
          : { data: [] };
        const subMap = new Map<string, any>();
        for (const s of (subs ?? [])) if (!subMap.has(s.agent_id)) subMap.set(s.agent_id, s);

        const enriched = (agents ?? []).map(a => ({
          ...a,
          subscription: subMap.get(a.id) ?? null,
        }));
        return json({ agents: enriched });
      }

      case "verify": {
        if (!body.agent_id) return json({ error: "agent_id required" }, 400);
        const { error } = await admin
          .from("mate_pro_agents")
          .update({ ffar_verified: true, ffar_verified_at: new Date().toISOString() })
          .eq("id", body.agent_id);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }

      case "reject": {
        if (!body.agent_id) return json({ error: "agent_id required" }, 400);
        const { error } = await admin
          .from("mate_pro_agents")
          .update({ ffar_verified: false, ffar_verified_at: null })
          .eq("id", body.agent_id);
        if (error) return json({ error: error.message }, 500);
        return json({ ok: true });
      }

      case "cancel_subscription": {
        if (!body.agent_id) return json({ error: "agent_id required" }, 400);
        if (!STRIPE_SECRET_KEY) return json({ error: "Stripe secret not configured" }, 500);

        const { data: sub } = await admin
          .from("mate_pro_subscriptions")
          .select("stripe_subscription_id, cancel_at")
          .eq("agent_id", body.agent_id)
          .in("status", ["trialing", "active", "past_due"])
          .order("created_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (!sub) return json({ error: "No active subscription found for this agent" }, 404);
        if (sub.cancel_at) return json({ ok: true, already_cancelled: true });

        const form = new URLSearchParams({ "cancel_at_period_end": "true" });
        const res = await fetch(
          `https://api.stripe.com/v1/subscriptions/${sub.stripe_subscription_id}`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
              "Content-Type": "application/x-www-form-urlencoded",
            },
            body: form.toString(),
          },
        );
        const data = await res.json();
        if (!res.ok) return json({ error: `Stripe error: ${data.error?.message ?? "unknown"}` }, 500);
        return json({ ok: true, cancel_at: data.cancel_at ? new Date(data.cancel_at * 1000).toISOString() : null });
      }

      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (err) {
    console.error("mate-pro-admin-actions error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
