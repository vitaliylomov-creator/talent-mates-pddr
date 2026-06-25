// ────────────────────────────────────────────────────────────────────────────
// mate-pro-stripe-webhook — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-stripe-webhook \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// Webhook endpoint must be registered in Stripe Dashboard at:
//   https://zlkzjeaojpxzccpovygk.supabase.co/functions/v1/mate-pro-stripe-webhook
// with these events subscribed:
//   - customer.subscription.created
//   - customer.subscription.updated
//   - customer.subscription.deleted
//   - customer.subscription.trial_will_end
//   - invoice.payment_succeeded
//   - invoice.payment_failed
//
// The webhook signing secret (whsec_...) must be set as
// MATE_PRO_STRIPE_WEBHOOK_SECRET in Supabase env. The Players webhook
// has its own separate secret in STRIPE_WEBHOOK_SECRET — we do not
// reuse that one because each endpoint has its own signing key.
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";

const PRICE_FOUNDING_ENV = Deno.env.get("MATE_PRO_STRIPE_PRICE_FOUNDING") ?? "";
const PRICE_STANDARD_ENV = Deno.env.get("MATE_PRO_STRIPE_PRICE_STANDARD") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const WEBHOOK_SECRET = Deno.env.get("MATE_PRO_STRIPE_WEBHOOK_SECRET") ?? "";

Deno.serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 });
  }

  const rawBody = await req.text();
  const sigHeader = req.headers.get("stripe-signature") ?? "";

  if (!WEBHOOK_SECRET) {
    console.error("MATE_PRO_STRIPE_WEBHOOK_SECRET not set");
    return new Response("Webhook secret not configured", { status: 500 });
  }
  const verified = await verifyStripeSignature(rawBody, sigHeader, WEBHOOK_SECRET);
  if (!verified) {
    console.error("Invalid Stripe signature");
    return new Response("Invalid signature", { status: 400 });
  }

  let event: any;
  try {
    event = JSON.parse(rawBody);
  } catch {
    return new Response("Bad JSON", { status: 400 });
  }

  const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    console.log(`[STRIPE EVENT] ${event.type} ${event.id}`);
    switch (event.type) {
      case "customer.subscription.created":
      case "customer.subscription.updated":
        await upsertSubscription(admin, event.data.object);
        break;

      case "customer.subscription.deleted":
        await markSubscriptionDeleted(admin, event.data.object);
        break;

      case "customer.subscription.trial_will_end":
        console.log(`[TRIAL ENDING] sub=${event.data.object.id} ends_at=${new Date(event.data.object.trial_end * 1000).toISOString()}`);
        break;

      case "invoice.payment_succeeded":
        console.log(`[PAYMENT OK] customer=${event.data.object.customer} amount=${event.data.object.amount_paid / 100} ${event.data.object.currency}`);
        break;

      case "invoice.payment_failed":
        console.warn(`[PAYMENT FAILED] customer=${event.data.object.customer} amount=${event.data.object.amount_due / 100} ${event.data.object.currency}`);
        break;

      default:
        console.log(`[IGNORED] ${event.type}`);
    }
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (err) {
    console.error(`Webhook handler error on ${event.type}:`, err);
    return new Response("Handler error", { status: 500 });
  }
});

async function upsertSubscription(admin: any, sub: any) {
  let agentId: string | null = sub.metadata?.agent_id ?? null;
  if (!agentId) {
    const { data: existing } = await admin
      .from("mate_pro_subscriptions")
      .select("agent_id")
      .eq("stripe_customer_id", sub.customer)
      .limit(1)
      .maybeSingle();
    agentId = existing?.agent_id ?? null;
  }
  if (!agentId) {
    console.error(`Cannot resolve agent_id for subscription ${sub.id} (customer ${sub.customer})`);
    return;
  }

  const priceId: string = sub.items?.data?.[0]?.price?.id ?? "";
  const plan = priceId === PRICE_FOUNDING_ENV ? "founding"
             : priceId === PRICE_STANDARD_ENV ? "standard"
             : "standard";

  const row = {
    agent_id: agentId,
    stripe_customer_id: sub.customer,
    stripe_subscription_id: sub.id,
    stripe_price_id: priceId,
    plan,
    status: sub.status,
    trial_ends_at: sub.trial_end ? new Date(sub.trial_end * 1000).toISOString() : null,
    current_period_start: sub.current_period_start ? new Date(sub.current_period_start * 1000).toISOString() : null,
    current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
    cancel_at: sub.cancel_at ? new Date(sub.cancel_at * 1000).toISOString() : null,
    canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : null,
    ended_at: sub.ended_at ? new Date(sub.ended_at * 1000).toISOString() : null,
  };

  const { error } = await admin
    .from("mate_pro_subscriptions")
    .upsert(row, { onConflict: "stripe_subscription_id" });
  if (error) {
    console.error(`Upsert failed for sub ${sub.id}:`, error);
    throw error;
  }
}

async function markSubscriptionDeleted(admin: any, sub: any) {
  const { error } = await admin
    .from("mate_pro_subscriptions")
    .update({
      status: "canceled",
      canceled_at: sub.canceled_at ? new Date(sub.canceled_at * 1000).toISOString() : new Date().toISOString(),
      ended_at: sub.ended_at ? new Date(sub.ended_at * 1000).toISOString() : new Date().toISOString(),
    })
    .eq("stripe_subscription_id", sub.id);
  if (error) {
    console.error(`Mark-deleted failed for sub ${sub.id}:`, error);
    throw error;
  }
}

// ─────────────────────────────────────────────
// Stripe signature verification (HMAC-SHA256)
// ─────────────────────────────────────────────

const TOLERANCE_SECONDS = 5 * 60;

async function verifyStripeSignature(
  rawBody: string,
  sigHeader: string,
  secret: string,
): Promise<boolean> {
  if (!sigHeader) return false;
  const parts = Object.fromEntries(
    sigHeader.split(",").map((p) => p.split("=").map((s) => s.trim())),
  ) as Record<string, string>;
  const t = parts.t;
  const v1 = parts.v1;
  if (!t || !v1) return false;

  const tsNum = parseInt(t, 10);
  if (isNaN(tsNum)) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsNum) > TOLERANCE_SECONDS) {
    console.warn(`Stripe webhook timestamp outside tolerance: ${tsNum} vs ${nowSec}`);
    return false;
  }

  const signedPayload = `${t}.${rawBody}`;
  const expectedHex = await hmacSha256Hex(secret, signedPayload);
  return constantTimeEqual(expectedHex, v1);
}

async function hmacSha256Hex(secret: string, data: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(data));
  return Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
