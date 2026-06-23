// ────────────────────────────────────────────────────────────────────────────
// mate-pro-complete-profile — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-complete-profile \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// What it does
// ────────────
// Completes Agent registration AFTER auth.users already exists. The
// frontend uses sb.auth.signUp() to collect email + password (low
// friction, looks like Players sign-up); this endpoint then:
//   1. Verifies the JWT, derives user_id.
//   2. Validates the 4 remaining fields (first/last name, FFAR licence,
//      FFAR country against the FIFA member list).
//   3. Confirms no mate_pro_agents row exists for this user_id yet
//      (409 if it does — user already an Agent).
//   4. Calls mate_pro_assign_founding_number() RPC atomically.
//   5. INSERTs mate_pro_agents with the assigned number (NULL if cap).
//   6. Returns { agent_id, founding_number, is_founding }.
//
// Why split from the old mate-pro-register flow
// ──────────────────────────────────────────────
// The original mate-pro-register did createUser + counter + INSERT in
// one POST. We replaced it with a two-step UX:
//   Step 1 (frontend, no backend call):  sb.auth.signUp({email, password})
//   Step 2 (this endpoint):              POST { first/last/FFAR/country }
// Net result:
//   - Sign-up feels as light as Players sign-up at the moment of decision
//   - FFAR data only collected when the user is committed (already in)
//   - Founding numbers are spent only on agents who finish profile setup,
//     not on drive-by abandoners
//
// Idempotency / failure
// ─────────────────────
// The 409 check on existing mate_pro_agents row prevents double-spending
// a founding number if the user POSTs twice. If the INSERT fails after
// the counter advanced, we do NOT roll back the counter — one skipped
// number out of 100 is acceptable and avoids a second RPC race window.
// The UNIQUE constraint on founding_number is the actual safety net.
//
// Request body
// ────────────
//   {
//     "first_name":   "Vitalii",
//     "last_name":    "Lomov",
//     "ffar_licence": "FFAR-2024-UA-0847",
//     "ffar_country": "Ukraine"
//   }
//
// Response
// ────────
//   200 { agent_id, founding_number, is_founding, email }
//   400 { error, field? }    — validation failure
//   401 { error }            — missing/invalid JWT
//   409 { error }            — user already has a mate_pro_agents row
//   500 { error }            — counter or DB failure
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { isFifaMember } from "../_shared/fifa-countries.ts";

const MAX_NAME_LEN = 100;
const MAX_FFAR_LEN = 50;

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

    // ── Authenticate via JWT ─────────────────────────────────────────
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: "Invalid or expired token" }, 401);
    }
    const userId = userData.user.id;
    const email = userData.user.email ?? "";

    // ── Body validation ──────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be valid JSON" }, 400);
    }

    const firstName = typeof body.first_name === "string" ? body.first_name.trim() : "";
    const lastName = typeof body.last_name === "string" ? body.last_name.trim() : "";
    const ffarLicence = typeof body.ffar_licence === "string" ? body.ffar_licence.trim() : "";
    const ffarCountry = typeof body.ffar_country === "string" ? body.ffar_country.trim() : "";

    if (!firstName || firstName.length > MAX_NAME_LEN) {
      return json({ error: "First name required", field: "first_name" }, 400);
    }
    if (!lastName || lastName.length > MAX_NAME_LEN) {
      return json({ error: "Last name required", field: "last_name" }, 400);
    }
    if (!ffarLicence) {
      return json({ error: "FFAR licence number is required.", field: "ffar_licence" }, 400);
    }
    if (ffarLicence.length > MAX_FFAR_LEN) {
      return json({ error: "FFAR licence too long", field: "ffar_licence" }, 400);
    }
    if (!ffarCountry) {
      return json({ error: "Country of licence issue required", field: "ffar_country" }, 400);
    }
    if (!isFifaMember(ffarCountry)) {
      return json({
        error: "Country must be a FIFA member association",
        field: "ffar_country",
      }, 400);
    }

    // ── Service-role client for the privileged work ──────────────────
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── 1. Reject if mate_pro_agents row already exists ──────────────
    const { data: existing } = await admin
      .from("mate_pro_agents")
      .select("id, founding_number")
      .eq("user_id", userId)
      .maybeSingle();

    if (existing) {
      return json({
        error: "Agent profile already exists for this account.",
        agent_id: existing.id,
        founding_number: existing.founding_number,
      }, 409);
    }

    // ── 2. Atomic Founding 100 assignment ────────────────────────────
    const { data: foundingRaw, error: rpcErr } = await admin.rpc(
      "mate_pro_assign_founding_number",
    );
    if (rpcErr) {
      return json({ error: `Counter assignment failed: ${rpcErr.message}` }, 500);
    }
    const foundingNumber: number | null =
      typeof foundingRaw === "number" ? foundingRaw : null;

    // ── 3. INSERT mate_pro_agents ───────────────────────────────────
    const { data: agentRow, error: insertErr } = await admin
      .from("mate_pro_agents")
      .insert({
        user_id: userId,
        first_name: firstName,
        last_name: lastName,
        email,
        ffar_licence: ffarLicence,
        ffar_country: ffarCountry,
        founding_number: foundingNumber,
      })
      .select("id")
      .single();

    if (insertErr || !agentRow) {
      // Counter already advanced — that one number is forfeited (acceptable).
      return json(
        { error: `Agent insert failed: ${insertErr?.message ?? "unknown"}` },
        500,
      );
    }

    return json({
      agent_id: agentRow.id,
      founding_number: foundingNumber,
      is_founding: foundingNumber !== null,
      email,
    });
  } catch (err) {
    console.error("mate-pro-complete-profile error:", err);
    return json(
      { error: err instanceof Error ? err.message : "Unknown error" },
      500,
    );
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
