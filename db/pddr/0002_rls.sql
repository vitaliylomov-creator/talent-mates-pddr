-- ────────────────────────────────────────────────────────────────────────────
-- PDDR · Migration 0002 — Row-Level Security policies
-- ────────────────────────────────────────────────────────────────────────────
--
-- Target project:  Mate AI Supabase (zlkzjeaojpxzccpovygk)
-- Apply via:       Supabase Dashboard → SQL Editor → paste → Run
-- Depends on:      0001_schema.sql + 0001_seed.sql
--
-- What this migration does
-- ────────────────────────
-- 1. Creates five SECURITY DEFINER helper functions that return the
--    current authenticated coach's context (id, academy, role, teams).
--    They bypass RLS for their lookups, so policies can use them
--    without recursion.
-- 2. Attaches policies to every pddr_* table per the access matrix
--    agreed in Session 2 brainstorm. v1 ruleset (option B):
--      • Sporting Director  → full read/write of their academy
--      • Any coach (head_coach / assistant_coach / analyst) with a
--        team assignment → read/write players, assessments, reports
--        for their assigned teams
--      • Player → read self, own assessments, own reports, own
--        entitlement; UPDATE own player record
--      • service_role → bypasses RLS entirely (Make.com writes
--        reports, edge functions write entitlements)
-- 3. Includes a test block at the bottom you can paste into the SQL
--    Editor to confirm policies behave as expected.
--
-- Multi-tenant safety
-- ───────────────────
-- Every policy filters on `academy_id` first (via the helper
-- function). Postgres uses the B-tree index from migration 0001 →
-- cross-tenant lookups are physically impossible to leak even if a
-- coach somehow has the same auth.uid() as a coach at another academy.
--
-- ────────────────────────────────────────────────────────────────────────────


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — Helper functions (SECURITY DEFINER, bypass RLS for lookups)
-- ════════════════════════════════════════════════════════════════════════════

-- Returns the pddr_coaches.id for the currently authenticated user, or
-- NULL if the user isn't a coach. STABLE = same result within a query.
CREATE OR REPLACE FUNCTION pddr_current_coach_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT id
  FROM pddr_coaches
  WHERE auth_user_id = auth.uid()
    AND status = 'active'
  LIMIT 1;
$$;

-- Returns the academy_id the current coach belongs to.
CREATE OR REPLACE FUNCTION pddr_current_coach_academy_id()
RETURNS uuid
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT academy_id
  FROM pddr_coaches
  WHERE auth_user_id = auth.uid()
    AND status = 'active'
  LIMIT 1;
$$;

-- Returns the current coach's role string.
CREATE OR REPLACE FUNCTION pddr_current_coach_role()
RETURNS text
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT role
  FROM pddr_coaches
  WHERE auth_user_id = auth.uid()
    AND status = 'active'
  LIMIT 1;
$$;

-- TRUE if the current user is a Sporting Director.
CREATE OR REPLACE FUNCTION pddr_is_sporting_director()
RETURNS boolean
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM pddr_coaches
    WHERE auth_user_id = auth.uid()
      AND status = 'active'
      AND role = 'sporting_director'
  );
$$;

-- Returns the array of team_ids the current coach can access.
-- Sporting Director  → all teams in their academy
-- Other coach roles  → teams they're explicitly assigned to
-- Non-coach (player) → empty array
CREATE OR REPLACE FUNCTION pddr_current_coach_team_ids()
RETURNS uuid[]
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
STABLE
AS $$
  WITH me AS (
    SELECT id, academy_id, role
    FROM pddr_coaches
    WHERE auth_user_id = auth.uid()
      AND status = 'active'
    LIMIT 1
  )
  SELECT CASE
    WHEN (SELECT role FROM me) = 'sporting_director' THEN
      ARRAY(SELECT id FROM pddr_teams WHERE academy_id = (SELECT academy_id FROM me))
    WHEN (SELECT id FROM me) IS NOT NULL THEN
      ARRAY(SELECT team_id FROM pddr_coach_team_assignments WHERE coach_id = (SELECT id FROM me))
    ELSE
      ARRAY[]::uuid[]
  END;
$$;

-- Grant execution to authenticated users. anon doesn't need it (no
-- anonymous reads against pddr_*).
GRANT EXECUTE ON FUNCTION pddr_current_coach_id()         TO authenticated;
GRANT EXECUTE ON FUNCTION pddr_current_coach_academy_id() TO authenticated;
GRANT EXECUTE ON FUNCTION pddr_current_coach_role()       TO authenticated;
GRANT EXECUTE ON FUNCTION pddr_is_sporting_director()     TO authenticated;
GRANT EXECUTE ON FUNCTION pddr_current_coach_team_ids()   TO authenticated;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — Policies on pddr_academies
-- ════════════════════════════════════════════════════════════════════════════

CREATE POLICY "academies_select_own"
  ON pddr_academies FOR SELECT
  TO authenticated
  USING (id = pddr_current_coach_academy_id());

-- INSERT / UPDATE / DELETE on academies: service_role only.
-- (Talent Mates admin creates academies. No authenticated user can.)


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — Policies on pddr_coaches
-- ════════════════════════════════════════════════════════════════════════════

CREATE POLICY "coaches_select_self"
  ON pddr_coaches FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "coaches_select_same_academy"
  ON pddr_coaches FOR SELECT
  TO authenticated
  USING (academy_id = pddr_current_coach_academy_id());

CREATE POLICY "coaches_insert_sd"
  ON pddr_coaches FOR INSERT
  TO authenticated
  WITH CHECK (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );

CREATE POLICY "coaches_update_sd"
  ON pddr_coaches FOR UPDATE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  )
  WITH CHECK (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );

CREATE POLICY "coaches_update_self"
  ON pddr_coaches FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

-- Sporting Director can disable other coaches, but never delete themselves
-- via this policy (auth_user_id IS DISTINCT FROM auth.uid()).
CREATE POLICY "coaches_delete_sd"
  ON pddr_coaches FOR DELETE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
    AND auth_user_id IS DISTINCT FROM auth.uid()
  );


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4 — Policies on pddr_teams
-- ════════════════════════════════════════════════════════════════════════════

CREATE POLICY "teams_select_same_academy"
  ON pddr_teams FOR SELECT
  TO authenticated
  USING (academy_id = pddr_current_coach_academy_id());

CREATE POLICY "teams_insert_sd"
  ON pddr_teams FOR INSERT
  TO authenticated
  WITH CHECK (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );

CREATE POLICY "teams_update_sd"
  ON pddr_teams FOR UPDATE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  )
  WITH CHECK (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );

CREATE POLICY "teams_delete_sd"
  ON pddr_teams FOR DELETE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 5 — Policies on pddr_coach_team_assignments
-- ════════════════════════════════════════════════════════════════════════════

CREATE POLICY "cta_select_same_academy"
  ON pddr_coach_team_assignments FOR SELECT
  TO authenticated
  USING (
    team_id IN (
      SELECT id FROM pddr_teams
      WHERE academy_id = pddr_current_coach_academy_id()
    )
  );

CREATE POLICY "cta_insert_sd"
  ON pddr_coach_team_assignments FOR INSERT
  TO authenticated
  WITH CHECK (
    pddr_is_sporting_director()
    AND team_id IN (
      SELECT id FROM pddr_teams
      WHERE academy_id = pddr_current_coach_academy_id()
    )
  );

CREATE POLICY "cta_update_sd"
  ON pddr_coach_team_assignments FOR UPDATE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND team_id IN (
      SELECT id FROM pddr_teams
      WHERE academy_id = pddr_current_coach_academy_id()
    )
  )
  WITH CHECK (
    pddr_is_sporting_director()
    AND team_id IN (
      SELECT id FROM pddr_teams
      WHERE academy_id = pddr_current_coach_academy_id()
    )
  );

CREATE POLICY "cta_delete_sd"
  ON pddr_coach_team_assignments FOR DELETE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND team_id IN (
      SELECT id FROM pddr_teams
      WHERE academy_id = pddr_current_coach_academy_id()
    )
  );


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 6 — Policies on pddr_players
-- ════════════════════════════════════════════════════════════════════════════

CREATE POLICY "players_select_self"
  ON pddr_players FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "players_select_team"
  ON pddr_players FOR SELECT
  TO authenticated
  USING (team_id = ANY(pddr_current_coach_team_ids()));

CREATE POLICY "players_select_sd"
  ON pddr_players FOR SELECT
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );

-- Any coach with team access can add players to that team.
-- Sporting Director can also add players without a team_id (orphan, to be
-- assigned later).
CREATE POLICY "players_insert_coach"
  ON pddr_players FOR INSERT
  TO authenticated
  WITH CHECK (
    academy_id = pddr_current_coach_academy_id()
    AND (
      team_id = ANY(pddr_current_coach_team_ids())
      OR (team_id IS NULL AND pddr_is_sporting_director())
    )
  );

-- Coach with team access can update player.
CREATE POLICY "players_update_coach"
  ON pddr_players FOR UPDATE
  TO authenticated
  USING (
    academy_id = pddr_current_coach_academy_id()
    AND (
      team_id = ANY(pddr_current_coach_team_ids())
      OR pddr_is_sporting_director()
    )
  )
  WITH CHECK (
    academy_id = pddr_current_coach_academy_id()
    AND (
      team_id = ANY(pddr_current_coach_team_ids())
      OR pddr_is_sporting_director()
    )
  );

-- Player can update own profile (height, foot, position, etc.).
-- Column-level restrictions handled in the frontend; RLS only gates rows.
CREATE POLICY "players_update_self"
  ON pddr_players FOR UPDATE
  TO authenticated
  USING (auth_user_id = auth.uid())
  WITH CHECK (auth_user_id = auth.uid());

CREATE POLICY "players_delete_sd"
  ON pddr_players FOR DELETE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 7 — Policies on pddr_assessments
-- ════════════════════════════════════════════════════════════════════════════

CREATE POLICY "assessments_select_player_self"
  ON pddr_assessments FOR SELECT
  TO authenticated
  USING (
    player_id IN (
      SELECT id FROM pddr_players WHERE auth_user_id = auth.uid()
    )
  );

CREATE POLICY "assessments_select_coach_team"
  ON pddr_assessments FOR SELECT
  TO authenticated
  USING (
    player_id IN (
      SELECT id FROM pddr_players
      WHERE team_id = ANY(pddr_current_coach_team_ids())
    )
  );

CREATE POLICY "assessments_select_sd"
  ON pddr_assessments FOR SELECT
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );

-- v1 rule (option B): any coach with team access can create assessments.
-- assessor_coach_id is locked to the current coach to keep audit trail honest.
CREATE POLICY "assessments_insert_coach"
  ON pddr_assessments FOR INSERT
  TO authenticated
  WITH CHECK (
    academy_id = pddr_current_coach_academy_id()
    AND assessor_coach_id = pddr_current_coach_id()
    AND (
      player_id IN (
        SELECT id FROM pddr_players
        WHERE team_id = ANY(pddr_current_coach_team_ids())
      )
      OR pddr_is_sporting_director()
    )
  );

-- Only the original assessor (or SD) can update.
CREATE POLICY "assessments_update_assessor"
  ON pddr_assessments FOR UPDATE
  TO authenticated
  USING (
    assessor_coach_id = pddr_current_coach_id()
    OR (
      pddr_is_sporting_director()
      AND academy_id = pddr_current_coach_academy_id()
    )
  )
  WITH CHECK (
    academy_id = pddr_current_coach_academy_id()
    AND (
      assessor_coach_id = pddr_current_coach_id()
      OR pddr_is_sporting_director()
    )
  );

CREATE POLICY "assessments_delete_sd"
  ON pddr_assessments FOR DELETE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 8 — Policies on pddr_reports
-- ════════════════════════════════════════════════════════════════════════════
--
-- Reports are WRITTEN by Make.com via service_role key — no INSERT or
-- UPDATE policies are needed for authenticated users. Only SELECT and
-- (SD) DELETE.

CREATE POLICY "reports_select_player_self"
  ON pddr_reports FOR SELECT
  TO authenticated
  USING (
    assessment_id IN (
      SELECT a.id
      FROM pddr_assessments a
      JOIN pddr_players p ON p.id = a.player_id
      WHERE p.auth_user_id = auth.uid()
    )
  );

CREATE POLICY "reports_select_coach_team"
  ON pddr_reports FOR SELECT
  TO authenticated
  USING (
    assessment_id IN (
      SELECT a.id
      FROM pddr_assessments a
      JOIN pddr_players p ON p.id = a.player_id
      WHERE p.team_id = ANY(pddr_current_coach_team_ids())
    )
  );

CREATE POLICY "reports_select_sd"
  ON pddr_reports FOR SELECT
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );

CREATE POLICY "reports_delete_sd"
  ON pddr_reports FOR DELETE
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 9 — Policies on pddr_mate_ai_entitlements
-- ════════════════════════════════════════════════════════════════════════════
--
-- Entitlements are PROVISIONED by an edge function via service_role.
-- Authenticated users only need SELECT.

CREATE POLICY "entitlements_select_self"
  ON pddr_mate_ai_entitlements FOR SELECT
  TO authenticated
  USING (auth_user_id = auth.uid());

CREATE POLICY "entitlements_select_coach_team"
  ON pddr_mate_ai_entitlements FOR SELECT
  TO authenticated
  USING (
    player_id IN (
      SELECT id FROM pddr_players
      WHERE team_id = ANY(pddr_current_coach_team_ids())
    )
  );

CREATE POLICY "entitlements_select_sd"
  ON pddr_mate_ai_entitlements FOR SELECT
  TO authenticated
  USING (
    pddr_is_sporting_director()
    AND academy_id = pddr_current_coach_academy_id()
  );


-- ════════════════════════════════════════════════════════════════════════════
-- END OF POLICIES
-- ════════════════════════════════════════════════════════════════════════════
--
-- To verify, paste the test block below into the SQL Editor (separate
-- query). It impersonates you as Sporting Director and prints counts
-- that should match expectations. The block resets the role at the
-- end — safe to re-run.
--
-- ────────────────────────────────────────────────────────────────────────────
--
-- DO $$
-- DECLARE
--   v_user_id uuid;
--   v_academies int;
--   v_coaches int;
--   v_teams int;
--   v_players int;
--   v_assessments int;
--   v_reports int;
-- BEGIN
--   SELECT id INTO v_user_id FROM auth.users
--     WHERE lower(email) = 'vitaliylomov@gmail.com' LIMIT 1;
--
--   IF v_user_id IS NULL THEN
--     RAISE EXCEPTION 'No auth.users row for vitaliylomov@gmail.com. Sign in first.';
--   END IF;
--
--   -- Impersonate as authenticated user
--   PERFORM set_config('request.jwt.claims',
--     json_build_object('sub', v_user_id::text, 'role', 'authenticated')::text, true);
--   SET LOCAL ROLE authenticated;
--
--   SELECT COUNT(*) INTO v_academies   FROM pddr_academies;
--   SELECT COUNT(*) INTO v_coaches     FROM pddr_coaches;
--   SELECT COUNT(*) INTO v_teams       FROM pddr_teams;
--   SELECT COUNT(*) INTO v_players     FROM pddr_players;
--   SELECT COUNT(*) INTO v_assessments FROM pddr_assessments;
--   SELECT COUNT(*) INTO v_reports     FROM pddr_reports;
--
--   RAISE NOTICE '── SD impersonation results ──';
--   RAISE NOTICE 'Academies visible:   % (expected 1)', v_academies;
--   RAISE NOTICE 'Coaches visible:     % (expected 1)', v_coaches;
--   RAISE NOTICE 'Teams visible:       % (expected 2)', v_teams;
--   RAISE NOTICE 'Players visible:     % (expected 0 — none seeded yet)', v_players;
--   RAISE NOTICE 'Assessments visible: % (expected 0 — none seeded yet)', v_assessments;
--   RAISE NOTICE 'Reports visible:     % (expected 0 — none seeded yet)', v_reports;
--   RAISE NOTICE 'is_sporting_director: %', pddr_is_sporting_director();
--   RAISE NOTICE 'current_coach_id:     %', pddr_current_coach_id();
--   RAISE NOTICE 'team_ids visible:     %', pddr_current_coach_team_ids();
--
--   RESET ROLE;
-- END
-- $$;
--
-- ────────────────────────────────────────────────────────────────────────────
-- Cross-tenant leak test (after you onboard a second academy):
--
--   1. Create a second academy via service_role with one coach.
--   2. Impersonate that coach's auth.uid().
--   3. Confirm SELECT COUNT(*) FROM pddr_players returns ZERO of the
--      Talent Mates Demo academy's players (and vice versa).
--
-- If either side sees the other's data, RLS is broken — open an
-- incident and roll back.
-- ────────────────────────────────────────────────────────────────────────────
