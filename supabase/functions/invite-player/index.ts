// ────────────────────────────────────────────────────────────────────────────
// invite-player — Supabase Edge Function
// ────────────────────────────────────────────────────────────────────────────
//
// Project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
// Deploy:  supabase functions deploy invite-player \
//            --project-ref zlkzjeaojpxzccpovygk
//
// What it does
// ────────────
// A coach POSTs { email, full_name, team_id, position?, date_of_birth?,
// nationality?, redirect_to? }. Function:
//   1. Validates caller's JWT — must be an active coach.
//   2. Verifies the target team belongs to the caller's academy.
//   3. For non-SD coaches, verifies the caller is assigned to that team.
//   4. Inserts a pending pddr_players row with status='invited'.
//   5. Calls supabase.auth.admin.inviteUserByEmail() with redirect to
//      player_welcome.html.
//   6. Rolls back the player insert on invite failure.
//
// The trigger from migration 0004 links auth_user_id, flips status to
// 'active', and grants pddr_mate_ai_entitlements automatically as soon
// as the invited player accepts and confirms email.
//
// Request body
// ────────────
//   {
//     "email":         "yegor@arsenal.com",         // required
//     "full_name":     "Yegor Lomov",               // required
//     "team_id":       "<uuid>",                    // required
//     "position":      "CM",                        // optional
//     "date_of_birth": "2006-02-01",                // optional (YYYY-MM-DD)
//     "nationality":   "Ukraine",                   // optional
//     "redirect_to":   "https://app.talent-mates.com/player_welcome.html"
//   }
//
// Response
// ────────
//   200 { ok: true, player_id: "uuid" }
//   400 { error: "..." }  — bad input or wrong academy
//   401 { error: "..." }  — missing/invalid JWT
//   403 { error: "..." }  — caller not a coach / not assigned to team
//   409 { error: "..." }  — email already invited into this academy
//   500 { error: "..." }  — Supabase / unexpected
//
// ────────────────────────────────────────────────────────────────────────────

import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.0";
import { corsHeaders } from "../_shared/cors.ts";

// Open list — positions vary widely. Keep as a string but trim length.
const MAX_POSITION_LEN = 24;

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

    // ── Caller must be an active coach ──
    const { data: meCoach, error: meErr } = await userClient
      .from("pddr_coaches")
      .select("id, academy_id, role")
      .eq("auth_user_id", callerUserId)
      .eq("status", "active")
      .maybeSingle();

    if (meErr) return json({ error: meErr.message }, 500);
    if (!meCoach) return json({ error: "Caller is not a registered active coach" }, 403);

    // ── Body validation ──
    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be valid JSON" }, 400);
    }

    const email = typeof body.email === "string" ? body.email.trim().toLowerCase() : "";
    const fullName = typeof body.full_name === "string" ? body.full_name.trim() : "";
    const teamId = typeof body.team_id === "string" ? body.team_id : "";
    const position = typeof body.position === "string"
      ? body.position.trim().slice(0, MAX_POSITION_LEN)
      : null;
    const dateOfBirth = typeof body.date_of_birth === "string" ? body.date_of_birth : null;
    const nationality = typeof body.nationality === "string"
      ? body.nationality.trim()
      : null;
    const redirectTo = typeof body.redirect_to === "string"
      ? body.redirect_to
      : "https://app.talent-mates.com/player_welcome.html";

    if (!email || !email.includes("@")) return json({ error: "Valid email required" }, 400);
    if (!fullName) return json({ error: "full_name required" }, 400);
    if (!teamId) return json({ error: "team_id required" }, 400);

    if (dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(dateOfBirth)) {
      return json({ error: "date_of_birth must be YYYY-MM-DD" }, 400);
    }

    // ── Admin client for privileged inserts + invite ──
    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
    });

    // ── Team belongs to caller's academy? ──
    const { data: team, error: teamErr } = await admin
      .from("pddr_teams")
      .select("id, academy_id")
      .eq("id", teamId)
      .maybeSingle();
    if (teamErr) return json({ error: teamErr.message }, 500);
    if (!team) return json({ error: "Team not found" }, 400);
    if (team.academy_id !== meCoach.academy_id) {
      return json({ error: "Team is not in your academy" }, 403);
    }

    // ── Non-SD coaches must be assigned to that team ──
    if (meCoach.role !== "sporting_director") {
      const { data: assignment, error: asgnErr } = await admin
        .from("pddr_coach_team_assignments")
        .select("coach_id")
        .eq("coach_id", meCoach.id)
        .eq("team_id", teamId)
        .maybeSingle();
      if (asgnErr) return json({ error: asgnErr.message }, 500);
      if (!assignment) return json({ error: "You are not assigned to this team" }, 403);
    }

    // ── Insert player ──
    const { data: newPlayer, error: insErr } = await admin
      .from("pddr_players")
      .insert({
        academy_id: meCoach.academy_id,
        team_id: teamId,
        full_name: fullName,
        email,
        position,
        date_of_birth: dateOfBirth,
        nationality,
        status: "invited",
        added_by_coach_id: meCoach.id,
      })
      .select("id")
      .single();

    if (insErr) {
      // 23505 = unique_violation (academy_id, lower(email))
      if ((insErr as any).code === "23505") {
        return json({ error: "A player with this email already exists in your academy" }, 409);
      }
      return json({ error: insErr.message }, 500);
    }

    const newPlayerId = newPlayer.id;

    // ── Send the invite email ──
    const { error: inviteErr } = await admin.auth.admin.inviteUserByEmail(email, {
      redirectTo,
      data: {
        full_name: fullName,
        academy_id: meCoach.academy_id,
        pddr_player_id: newPlayerId,
        team_id: teamId,
        invited_by: callerUserId,
        kind: "player",
      },
    });

    if (inviteErr) {
      await admin.from("pddr_players").delete().eq("id", newPlayerId);
      return json({ error: `Invite email failed: ${inviteErr.message}` }, 500);
    }

    return json({ ok: true, player_id: newPlayerId });
  } catch (err) {
    console.error("invite-player error:", err);
    return json({ error: err instanceof Error ? err.message : "Unknown error" }, 500);
  }
});

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}
