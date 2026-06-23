// ────────────────────────────────────────────────────────────────────────────
// mate-pro-register — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy mate-pro-register \
//            --project-ref zlkzjeaojpxzccpovygk --no-verify-jwt
//
// What it does
// ────────────
// Atomic agent registration for MATE Pro. Public, pre-auth endpoint.
//
//   1. Validates the 6-field body (email, password, first_name, last_name,
//      ffar_licence, ffar_country). FFAR country must match a FIFA member
//      from the static list in _shared/fifa-countries.ts.
//   2. Creates the auth.users row via supabase.auth.admin.createUser with
//      email_confirm:true (no confirmation email — manual FFAR verification
//      will be the trust gate, per spec § 9 open question 3 decision).
//   3. Calls the security-definer RPC mate_pro_assign_founding_number()
//      which atomically returns 1..100 or NULL once the cap is reached.
//   4. Inserts the mate_pro_agents row carrying the assigned number.
//   5. Signs the user in via signInWithPassword to return a fresh session
//      pair (access_token + refresh_token) the dashboard can persist with
//      supabase.auth.setSession().
//
// Failure recovery
// ────────────────
// If any step after createUser fails, the auth.users row is DELETED so the
// email is not orphaned. Without this the user could never re-register
// (createUser would 422 with "User already registered").
//
// Why --no-verify-jwt
// ───────────────────
// This endpoint is called by anonymous visitors who don't have a session
// yet. Supabase's edge gateway would 401 their request before our code
// ran. The Authorization header still carries the project anon key
// (required by the gateway), but we don't act on it.
//
// Request body
// ────────────
//   {
//     "email":        "agent@example.com",
//     "password":     "min8chars",
//     "first_name":   "Vitalii",
//     "last_name":    "Lomov",
//     "ffar_licence": "FFAR-2024-UA-0847",
//     "ffar_country": "Ukraine"
//   }
//
// Response
// ────────
//   200 { agent_id, founding_number, is_founding, session: { access_token, refresh_token } }
//   400 { error, field? }   — validation failure
//   409 { error, field: "email" }  — email already registered
//   500 { error }            — Supabase / unexpected
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";
import { isFifaMember } from "../_shared/fifa-countries.ts";

const MAX_NAME_LEN = 100;
const MAX_FFAR_LEN = 50;
const MIN_PASSWORD_LEN = 8;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return json({ error: "Method not allowed" }, 405);
  }

  try {
    const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
    const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;
    const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    // ── Body validation ──────────────────────────────────────────────────
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be valid JSON" }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const password = typeof body.password === "string" ? body.password : "";
    const firstName = typeof body.first_name === "string" ? body.first_name.trim() : "";
    const lastName = typeof body.last_name === "string" ? body.last_name.trim() : "";
    const ffarLicence = typeof body.ffar_licence === "string" ? body.ffar_licence.trim() : "";
    const ffarCountry = typeof body.ffar_country === "string" ? body.ffar_country.trim() : "";

    if (!email || !EMAIL_RE.test(email)) {
      return json({ error: "Valid email required", field: "email" }, 400);
    }
    if (password.length < MIN_PASSWORD_LEN) {
      return json({
        error: `Password must be at least ${MIN_PASSWORD_LEN} characters`,
        field: "password",
      }, 400);
    }
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

    // ── Service-role client for admin ops ────────────────────────────────
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── 1. Create auth user ──────────────────────────────────────────────
    const { data: created, error: createErr } = await admin.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
      user_metadata: {
        first_name: firstName,
        last_name: lastName,
        kind: "mate_pro_agent",
      },
    });

    if (createErr || !created.user) {
      // Supabase returns 422 with code 'email_exists' for duplicates.
      const message = (createErr?.message ?? "").toLowerCase();
      if (message.includes("already registered") || message.includes("already been registered") || message.includes("email_exists")) {
        return json({
          error: "This email is already registered. Sign in or use a different email.",
          field: "email",
        }, 409);
      }
      return json({ error: createErr?.message ?? "Failed to create user" }, 500);
    }

    const newUserId = created.user.id;

    // From here on, any failure must roll back the auth.users row.

    // ── 2. Atomic Founding 100 assignment ────────────────────────────────
    const { data: foundingRaw, error: rpcErr } = await admin.rpc("mate_pro_assign_founding_number");

    if (rpcErr) {
      await admin.auth.admin.deleteUser(newUserId);
      return json({ error: `Counter assignment failed: ${rpcErr.message}` }, 500);
    }

    // RPC returns int or null; supabase-js wraps it as the bare value.
    const foundingNumber: number | null = typeof foundingRaw === "number" ? foundingRaw : null;

    // ── 3. Insert mate_pro_agents row ────────────────────────────────────
    const { data: agentRow, error: insertErr } = await admin
      .from("mate_pro_agents")
      .insert({
        user_id: newUserId,
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
      await admin.auth.admin.deleteUser(newUserId);
      // We do not roll back the counter — a single skipped number out of 100
      // is acceptable and avoids a second RPC race window. The UNIQUE
      // constraint on founding_number still guarantees no duplicates.
      return json({ error: `Agent insert failed: ${insertErr?.message ?? "unknown"}` }, 500);
    }

    // ── 4. Sign the user in to return a fresh session ────────────────────
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: signInData, error: signInErr } = await anon.auth.signInWithPassword({
      email,
      password,
    });

    if (signInErr || !signInData.session) {
      // The account was created successfully — the dashboard can fall back to
      // a manual sign-in on the auth page. We do NOT delete the user here.
      return json({
        agent_id: agentRow.id,
        founding_number: foundingNumber,
        is_founding: foundingNumber !== null,
        session: null,
        warning: "Account created but auto-sign-in failed. Please sign in manually.",
      });
    }

    return json({
      agent_id: agentRow.id,
      founding_number: foundingNumber,
      is_founding: foundingNumber !== null,
      session: {
        access_token: signInData.session.access_token,
        refresh_token: signInData.session.refresh_token,
      },
    });
  } catch (err) {
    console.error("mate-pro-register error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
