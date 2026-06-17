-- ────────────────────────────────────────────────────────────────────────────
-- PDDR · Seed 0001 — Talent Mates Demo academy
-- ────────────────────────────────────────────────────────────────────────────
--
-- Run AFTER 0001_schema.sql in the same Supabase Dashboard SQL Editor.
--
-- Creates one academy ("Talent Mates Demo") with two teams (U19, U21) and
-- links vitaliylomov@gmail.com as the Sporting Director — but only if that
-- email already exists in auth.users (i.e. you've signed in via
-- fibonacci.html at least once on this Supabase project). If the user is
-- not found the script raises a warning and skips the coach insert; you
-- can run the snippet at the bottom after signing up.
--
-- Safe to re-run: blocks if academy slug already exists.
-- ────────────────────────────────────────────────────────────────────────────

DO $$
DECLARE
  v_academy_id uuid;
  v_team_u19   uuid;
  v_team_u21   uuid;
  v_coach_id   uuid;
  v_user_id    uuid;
BEGIN
  -- Guard: skip if academy already seeded
  IF EXISTS (SELECT 1 FROM pddr_academies WHERE slug = 'talent-mates-demo') THEN
    RAISE NOTICE 'Academy "talent-mates-demo" already exists. Skipping seed.';
    RETURN;
  END IF;

  -- 1. Academy
  INSERT INTO pddr_academies (name, slug, country, city, subscription_status, notes)
  VALUES (
    'Talent Mates Demo',
    'talent-mates-demo',
    'United Kingdom',
    'London',
    'trial',
    'Founder demo academy. Used for product testing and live demos.'
  )
  RETURNING id INTO v_academy_id;

  -- 2. Teams
  INSERT INTO pddr_teams (academy_id, name, age_group, season)
  VALUES (v_academy_id, 'U19', 'U19', '2025/26')
  RETURNING id INTO v_team_u19;

  INSERT INTO pddr_teams (academy_id, name, age_group, season)
  VALUES (v_academy_id, 'U21', 'U21', '2025/26')
  RETURNING id INTO v_team_u21;

  -- 3. Founder coach (Sporting Director, gets full academy access in RLS v2)
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE lower(email) = 'vitaliylomov@gmail.com'
  LIMIT 1;

  IF v_user_id IS NOT NULL THEN
    INSERT INTO pddr_coaches
      (auth_user_id, academy_id, full_name, email, role, status)
    VALUES
      (v_user_id, v_academy_id, 'Vitalii Lomov',
       'vitaliylomov@gmail.com', 'sporting_director', 'active')
    RETURNING id INTO v_coach_id;

    -- Sporting Directors don't *need* team assignments (RLS will grant
    -- access via role), but seeding both teams here means the dashboard
    -- can pre-select a default team when adding the first player.
    INSERT INTO pddr_coach_team_assignments (coach_id, team_id, role_on_team)
    VALUES
      (v_coach_id, v_team_u19, 'head'),
      (v_coach_id, v_team_u21, 'head');

    RAISE NOTICE 'Seeded academy % with Sporting Director coach %', v_academy_id, v_coach_id;
  ELSE
    RAISE WARNING 'auth.users row for vitaliylomov@gmail.com not found. Sign in via fibonacci.html first, then run the coach-link snippet at the bottom of this file.';
  END IF;
END
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- Manual coach-link snippet — run only if the seed warned above.
-- Uncomment, paste your auth.users.id into the WHERE clause if needed,
-- and execute.
-- ────────────────────────────────────────────────────────────────────────────
--
-- WITH academy AS (
--   SELECT id FROM pddr_academies WHERE slug = 'talent-mates-demo'
-- ),
-- usr AS (
--   SELECT id FROM auth.users WHERE lower(email) = 'vitaliylomov@gmail.com'
-- ),
-- new_coach AS (
--   INSERT INTO pddr_coaches (auth_user_id, academy_id, full_name, email, role, status)
--   SELECT usr.id, academy.id, 'Vitalii Lomov',
--          'vitaliylomov@gmail.com', 'sporting_director', 'active'
--   FROM academy, usr
--   RETURNING id
-- )
-- INSERT INTO pddr_coach_team_assignments (coach_id, team_id, role_on_team)
-- SELECT new_coach.id, t.id, 'head'
-- FROM new_coach, pddr_teams t
-- WHERE t.academy_id = (SELECT id FROM academy);
