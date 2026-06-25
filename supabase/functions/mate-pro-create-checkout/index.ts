// ────────────────────────────────────────────────────────────────────────────
// mate-pro-create-checkout — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-create-checkout \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// What it does
// ────────────
// Creates a Stripe Checkout Session for the calling agent and returns the
// hosted-checkout URL. The dashboard redirects the browser to that URL.
//
// Pricing decision logic
// ──────────────────────
// Founding €149 lifetime price is offered ONLY when ALL of the following
// are true at the moment of checkout creation:
//   1. The agent has ffar_verified=true
//   2. The agent has a non-null founding_number (founding slot held)
//   3. now() < founding_window_ends_at on the agent's row (30 days from
//      registration)
// Otherwise the Standard €299 price is used. The decision is final at
// checkout creation time — even if FFAR is verified later, the price is
// locked once the agent subscribes.
//
// Trial
// ─────
// 14 days. Card is required upfront (collected by Stripe Checkout). No
// charge during trial.
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const TRIAL_DAYS = 14;
const SUCCESS_PATH = "mate-pro-dashboard.html?subscribed=1";
const CANCEL_PATH = "mate-pro-dashboard.html?subscription_cancelled=1";

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
    const PRICE_FOUNDING = Deno.env.get("MATE_PRO_STRIPE_PRICE_FOUNDING") ?? "";
    const PRICE_STANDARD = Deno.env.get("MATE_PRO_STRIPE_PRICE_STANDARD") ?? "";

    if (!STRIPE_SECRET_KEY || !PRICE_FOUNDING || !PRICE_STANDARD) {
      return json({ error: "Server missing Stripe configuration" }, 500);
    }

    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: "Invalid or expired token" }, 401);
    }

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: agent, error: agentErr } = await admin
      .from("mate_pro_agents")
      .select("*")
      .eq("user_id", userData.user.id)
      .maybeSingle();
    if (agentErr) return json({ error: agentErr.message }, 500);
    if (!agent) return json({ error: "Caller is not a registered MATE Pro agent" }, 403);

    const { data: existingSub } = await admin
      .from("mate_pro_subscriptions")
      .select("id, status, current_period_end")
      .eq("agent_id", agent.id)
      .in("status", ["trialing", "active", "past_due"])
      .maybeSingle();
    if (existingSub) {
      return json({
        error: "An active subscription already exists for this account.",
        subscription_id: existingSub.id,
        status: existingSub.status,
      }, 409);
    }

    const now = Date.now();
    const foundingDeadline = agent.founding_window_ends_at
      ? new Date(agent.founding_window_ends_at).getTime()
      : 0;
    const eligibleForFounding =
      agent.ffar_verified === true &&
      agent.founding_number !== null &&
      now < foundingDeadline;

    const plan = eligibleForFounding ? "founding" : "standard";
    const priceId = eligibleForFounding ? PRICE_FOUNDING : PRICE_STANDARD;
    const priceEur = eligibleForFounding ? 149 : 299;

    // Resolve or create a Stripe Customer for this agent
    let stripeCustomerId: string | null = null;
    const { data: oldSub } = await admin
      .from("mate_pro_subscriptions")
      .select("stripe_customer_id")
      .eq("agent_id", agent.id)
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (oldSub?.stripe_customer_id) stripeCustomerId = oldSub.stripe_customer_id;

    if (!stripeCustomerId) {
      const customerForm = new URLSearchParams({
        email: agent.email,
        name: `${agent.first_name} ${agent.last_name}`.trim(),
        "metadata[agent_id]": agent.id,
        "metadata[user_id]": userData.user.id,
        "metadata[ffar_licence]": agent.ffar_licence,
        "metadata[ffar_country]": agent.ffar_country,
      });
      const custRes = await fetch("https://api.stripe.com/v1/customers", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: customerForm.toString(),
      });
      const custData = await custRes.json();
      if (!custRes.ok) {
        console.error("Stripe customer create error:", custData);
        return json({ error: `Stripe customer error: ${custData.error?.message ?? "unknown"}` }, 500);
      }
      stripeCustomerId = custData.id;
    }

    const origin = req.headers.get("origin") ?? "https://app.talent-mates.com";
    const form = new URLSearchParams({
      mode: "subscription",
      customer: stripeCustomerId!,
      "line_items[0][price]": priceId,
      "line_items[0][quantity]": "1",
      "subscription_data[trial_period_days]": String(TRIAL_DAYS),
      "subscription_data[metadata][agent_id]": agent.id,
      "subscription_data[metadata][plan]": plan,
      "subscription_data[metadata][founding_number]": String(agent.founding_number ?? ""),
      "payment_method_collection": "always",
      "success_url": `${origin}/${SUCCESS_PATH}`,
      "cancel_url": `${origin}/${CANCEL_PATH}`,
      "automatic_tax[enabled]": "true",
      "tax_id_collection[enabled]": "true",
      "customer_update[address]": "auto",
      "customer_update[name]": "auto",
      "billing_address_collection": "required",
      "locale": "en",
      "allow_promotion_codes": "false",
    });

    const checkoutRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${STRIPE_SECRET_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: form.toString(),
    });
    const checkoutData = await checkoutRes.json();
    if (!checkoutRes.ok) {
      console.error("Stripe checkout error:", checkoutData);
      return json({ error: `Stripe checkout error: ${checkoutData.error?.message ?? "unknown"}` }, 500);
    }

    return json({
      url: checkoutData.url,
      session_id: checkoutData.id,
      plan,
      price_eur: priceEur,
      trial_days: TRIAL_DAYS,
    });
  } catch (err) {
    console.error("mate-pro-create-checkout error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
