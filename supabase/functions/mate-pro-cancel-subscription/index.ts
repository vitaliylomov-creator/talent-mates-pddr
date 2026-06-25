// ────────────────────────────────────────────────────────────────────────────
// mate-pro-cancel-subscription — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-cancel-subscription \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// What it does
// ────────────
// Soft-cancels the caller's active subscription on Stripe by setting
// cancel_at_period_end=true. The agent keeps access until the end of
// the current paid period; no immediate refund. Our DB is updated via
// the customer.subscription.updated webhook event that Stripe fires
// in response to this change — we do not write to the DB here.
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

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
    if (!STRIPE_SECRET_KEY) return json({ error: "Server missing STRIPE_SECRET_KEY" }, 500);

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json({ error: "Invalid or expired token" }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: agent } = await admin
      .from("mate_pro_agents")
      .select("id")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (!agent) return json({ error: "Caller is not a registered MATE Pro agent" }, 403);

    const { data: sub } = await admin
      .from("mate_pro_subscriptions")
      .select("stripe_subscription_id, status, cancel_at, current_period_end")
      .eq("agent_id", agent.id)
      .in("status", ["trialing", "active", "past_due"])
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (!sub) return json({ error: "No active subscription found" }, 404);
    if (sub.cancel_at) {
      return json({ ok: true, cancel_at: sub.cancel_at, already_cancelled: true });
    }

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
    if (!res.ok) {
      console.error("Stripe cancel error:", data);
      return json({ error: `Stripe error: ${data.error?.message ?? "unknown"}` }, 500);
    }

    const cancelAt = data.cancel_at
      ? new Date(data.cancel_at * 1000).toISOString()
      : (data.current_period_end ? new Date(data.current_period_end * 1000).toISOString() : null);

    return json({ ok: true, cancel_at: cancelAt });
  } catch (err) {
    console.error("mate-pro-cancel-subscription error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
