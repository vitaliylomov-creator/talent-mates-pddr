// ────────────────────────────────────────────────────────────────────────────
// invite-coach — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy invite-coach \
//            --project-ref zlkzjeaojpxzccpovygk \
//            --no-verify-jwt=false
//
// What it does
// ────────────
// Sporting Director POSTs { email, full_name, role, team_ids?, redirect_to? }.
// Function:
//   1. Validates caller's JWT — must be a Sporting Director.
//   2. Inserts a pending pddr_coaches row in the SD's academy.
//   3. (optionally) Inserts pddr_coach_team_assignments rows.
//   4. Calls supabase.auth.admin.inviteUserByEmail() to send the email.
//   5. On invite failure, rolls back the coach insert.
//
// The trigger from migration 0003 links auth_user_id and flips status
// to 'active' as soon as the invited coach accepts and confirms email.
//
// Request body
// ────────────
//   {
//     "email":       "newcoach@arsenal.com",        // required
//     "full_name":   "John Smith",                  // required
//     "role":        "head_coach"|"assistant_coach"|"analyst",
//     "team_ids":    ["uuid", "uuid"],              // optional
//     "redirect_to": "https://app.talent-mates.com/coach_welcome.html"
//   }
//
// Response
// ────────
//   200 { ok: true, coach_id: "uuid" }
//   400 { error: "..." }  — bad input
//   401 { error: "..." }  — missing/invalid JWT
//   403 { error: "..." }  — caller is not a Sporting Director
//   409 { error: "..." }  — email already in academy
//   500 { error: "..." }  — Supabase / unexpected
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

const ALLOWED_ROLES = new Set([
  "head_coach",
  "assistant_coach",
  "analyst",
]);

const ALLOWED_TEAM_ROLES = new Set(["head", "assistant", "analyst"]);

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

    // ── User-context client: validates JWT and respects RLS ──
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
      auth: { persistSession: false, autoRefreshToken: false },
    });

    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) {
      return json({ error: "Invalid or expired token" }, 401);
    }
    const callerUserId = userData.user.id;

    // ── Caller must be an active Sporting Director ──
    const { data: meCoach, error: meErr } = await userClient
      .from("pddr_coaches")
      .select("id, academy_id, role")
      .eq("auth_user_id", callerUserId)
      .eq("status", "active")
      .maybeSingle();

    if (meErr) return json({ error: meErr.message }, 500);
    if (!meCoach) return json({ error: "Caller is not a registered coach" }, 403);
    if (meCoach.role !== "sporting_director") {
      return json({ error: "Only a Sporting Director can invite coaches" }, 403);
    }

    // ── Body validation ──
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be valid JSON" }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const role = typeof body.role === "string" ? body.role : "";
    const teamIds = Array.isArray(body.team_ids) ? body.team_ids.filter(t => typeof t === "string") : [];
    const teamRole = typeof body.team_role === "string" ? body.team_role : "head";
    const redirectTo = typeof body.redirect_to === "string"
      ? body.redirect_to
      : "https://app.talent-mates.com/coach_welcome.html";

    if (!email || !email.includes("@")) return json({ error: "Valid email required" }, 400);
    if (!fullName) return json({ error: "full_name required" }, 400);
    if (!ALLOWED_ROLES.has(role)) {
      return json({ error: `Invalid role. Allowed: ${[...ALLOWED_ROLES].join(", ")}` }, 400);
    }
    if (!ALLOWED_TEAM_ROLES.has(teamRole)) {
      return json({ error: `Invalid team_role. Allowed: ${[...ALLOWED_TEAM_ROLES].join(", ")}` }, 400);
    }

    // ── Admin client for the privileged inserts + invite ──
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // Verify provided team_ids actually belong to the SD's academy. Without
    // this check the SD could (via crafted request) attach a coach to a team
    // in another academy.
    if (teamIds.length > 0) {
      const { data: teams, error: teamsErr } = await admin
        .from("pddr_teams")
        .select("id, academy_id")
        .in("id", teamIds);
      if (teamsErr) return json({ error: teamsErr.message }, 500);
      const bad = (teams || []).filter(t => t.academy_id !== meCoach.academy_id);
      if (bad.length > 0 || (teams || []).length !== teamIds.length) {
        return json({ error: "One or more team_ids are not in your academy" }, 400);
      }
    }

    // ── Insert pending coach ──
    const { data: newCoach, error: insErr } = await admin
      .from("pddr_coaches")
      .insert({
        academy_id: meCoach.academy_id,
        full_name: fullName,
        email,
        role,
        status: "pending",
        invited_by_coach_id: meCoach.id,
      })
      .select("id")
      .single();

    if (insErr) {
      // 23505 = unique_violation (academy_id, email)
      if ((insErr as any).code === "23505") {
        return json({ error: "A coach with this email already exists in your academy" }, 409);
      }
      return json({ error: insErr.message }, 500);
    }

    const newCoachId = newCoach.id;

    // ── Team assignments (best-effort; rollback on any failure) ──
    if (teamIds.length > 0) {
      const assignments = teamIds.map((tid) => ({
        coach_id: newCoachId,
        team_id: tid,
        role_on_team: teamRole,
      }));
      const { error: ctaErr } = await admin
        .from("pddr_coach_team_assignments")
        .insert(assignments);
      if (ctaErr) {
        await admin.from("pddr_coaches").delete().eq("id", newCoachId);
        return json({ error: `Team assignment failed: ${ctaErr.message}` }, 500);
      }
    }

    // ── Send the invite email ──
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: {
        full_name: fullName,
        role,
        academy_id: meCoach.academy_id,
        pddr_coach_id: newCoachId,
        invited_by: callerUserId,
      },
    });

    if (inviteErr) {
      // Roll back everything we created so the SD can retry cleanly.
      await admin.from("pddr_coach_team_assignments").delete().eq("coach_id", newCoachId);
      await admin.from("pddr_coaches").delete().eq("id", newCoachId);
      return json({ error: `Invite email failed: ${inviteErr.message}` }, 500);
    }

    return json({ ok: true, coach_id: newCoachId });
  } catch (err) {
    console.error("invite-coach error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
