-- ────────────────────────────────────────────────────────────────────────────
-- PDDR · Schema migration 0001
-- ────────────────────────────────────────────────────────────────────────────
--
-- Target project:    Mate AI Supabase (zlkzjeaojpxzccpovygk · eu-central-1)
-- Apply via:         Supabase Dashboard → SQL Editor → paste → Run
--                    (do NOT run `supabase db push` from this repo — the
--                    linked CLI project is `cwoedvxltgtwmjazekal`/creators)
--
-- What this file does:
--   1. Creates eight `pddr_*` tables for the multi-tenant academy product.
--   2. Adds the indexes RLS will need (every academy_id, every foreign key).
--   3. Adds an updated_at trigger function shared by the tables that need it.
--   4. Enables Row-Level Security on every table with ZERO policies.
--      Result: only the service_role key can read/write until migration
--      0002 (RLS policies, Session 2) lands. This is intentional —
--      forces us to design policies before the dashboards talk to it.
--
-- All tables use the `pddr_` prefix to avoid collisions with existing
-- MATE AI tables in the same Postgres database. Once PDDR ever moves to
-- its own project we can drop the prefix.
--
-- Naming conventions:
--   • tables    — lower_snake plural, prefix `pddr_`
--   • columns   — lower_snake
--   • uuid PKs  — `id`, default `gen_random_uuid()`
--   • FKs       — `<entity>_id`
--   • check constraints kept inline so the values are visible at table-def
--
-- ────────────────────────────────────────────────────────────────────────────

-- pgcrypto for gen_random_uuid() — usually pre-enabled on Supabase but
-- safe to assert.
CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- ────────────────────────────────────────────────────────────────────────────
-- updated_at trigger function (shared)
-- ────────────────────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION pddr_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 1. pddr_academies  — tenant root. Subscription lives here.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_academies (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  slug                text NOT NULL UNIQUE,
  country             text,
  city                text,
  subscription_status text NOT NULL DEFAULT 'trial'
    CHECK (subscription_status IN ('trial','active','paused','churned')),
  notes               text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE TRIGGER pddr_academies_set_updated_at
  BEFORE UPDATE ON pddr_academies
  FOR EACH ROW EXECUTE FUNCTION pddr_set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 2. pddr_coaches  — umbrella term for sporting directors, head coaches,
--                   assistants. Linked to auth.users when invite is accepted.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_coaches (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_user_id          uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  academy_id            uuid NOT NULL REFERENCES pddr_academies(id) ON DELETE CASCADE,
  full_name             text NOT NULL,
  email                 text NOT NULL,
  role                  text NOT NULL DEFAULT 'head_coach'
    CHECK (role IN ('sporting_director','head_coach','assistant_coach','analyst')),
  status                text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending','active','disabled')),
  invited_by_coach_id   uuid REFERENCES pddr_coaches(id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academy_id, email)
);

CREATE INDEX idx_pddr_coaches_auth_user ON pddr_coaches(auth_user_id);
CREATE INDEX idx_pddr_coaches_academy   ON pddr_coaches(academy_id);

CREATE TRIGGER pddr_coaches_set_updated_at
  BEFORE UPDATE ON pddr_coaches
  FOR EACH ROW EXECUTE FUNCTION pddr_set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 3. pddr_teams  — U17 / U19 / U21 / First Team etc. inside an academy.
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_teams (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id  uuid NOT NULL REFERENCES pddr_academies(id) ON DELETE CASCADE,
  name        text NOT NULL,
  age_group   text,
  season      text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (academy_id, name)
);

CREATE INDEX idx_pddr_teams_academy ON pddr_teams(academy_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 4. pddr_coach_team_assignments  — many-to-many. A head coach may also be
--                                  an analyst on another team; sporting
--                                  directors have no entries (their access
--                                  is granted by role, not assignment).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_coach_team_assignments (
  coach_id      uuid NOT NULL REFERENCES pddr_coaches(id) ON DELETE CASCADE,
  team_id       uuid NOT NULL REFERENCES pddr_teams(id) ON DELETE CASCADE,
  role_on_team  text NOT NULL DEFAULT 'head'
    CHECK (role_on_team IN ('head','assistant','analyst')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (coach_id, team_id)
);

CREATE INDEX idx_pddr_cta_team ON pddr_coach_team_assignments(team_id);

-- ────────────────────────────────────────────────────────────────────────────
-- 5. pddr_players  — academy_id denormalised so RLS doesn't have to join
--                   through teams to enforce tenancy. team_id may be NULL
--                   briefly (player added before assigned to a team).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_players (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id          uuid NOT NULL REFERENCES pddr_academies(id) ON DELETE CASCADE,
  team_id             uuid REFERENCES pddr_teams(id) ON DELETE SET NULL,
  auth_user_id        uuid REFERENCES auth.users(id) ON DELETE SET NULL,
  full_name           text NOT NULL,
  email               text,
  position            text,
  date_of_birth       date,
  nationality         text,
  height_cm           int,
  preferred_foot      text CHECK (preferred_foot IN ('left','right','both')),
  status              text NOT NULL DEFAULT 'invited'
    CHECK (status IN ('invited','active','archived')),
  added_by_coach_id   uuid REFERENCES pddr_coaches(id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pddr_players_academy   ON pddr_players(academy_id);
CREATE INDEX idx_pddr_players_team      ON pddr_players(team_id);
CREATE INDEX idx_pddr_players_auth_user ON pddr_players(auth_user_id);
CREATE INDEX idx_pddr_players_email     ON pddr_players(lower(email));

CREATE TRIGGER pddr_players_set_updated_at
  BEFORE UPDATE ON pddr_players
  FOR EACH ROW EXECUTE FUNCTION pddr_set_updated_at();

-- ────────────────────────────────────────────────────────────────────────────
-- 6. pddr_assessments  — the input. One row per coach evaluation.
--                       Ratings and levels stay in jsonb (12 + 6 keys) so
--                       we don't ossify column names while the form
--                       evolves. ratings on 0–100 scale (the slider's
--                       native range — see player_report_sign.html).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_assessments (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id              uuid NOT NULL REFERENCES pddr_academies(id) ON DELETE CASCADE,
  player_id               uuid NOT NULL REFERENCES pddr_players(id) ON DELETE CASCADE,
  assessor_coach_id       uuid REFERENCES pddr_coaches(id) ON DELETE SET NULL,
  assessment_date         date NOT NULL DEFAULT current_date,
  ratings_json            jsonb NOT NULL,
  levels_json             jsonb,
  pathway_notes           text,
  per_level_observations  jsonb,
  priority_tags           text[],
  created_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pddr_assessments_academy ON pddr_assessments(academy_id);
CREATE INDEX idx_pddr_assessments_player  ON pddr_assessments(player_id);
CREATE INDEX idx_pddr_assessments_date    ON pddr_assessments(assessment_date DESC);

-- ────────────────────────────────────────────────────────────────────────────
-- 7. pddr_reports  — Claude output + structured fields parsed from it.
--                   One report per assessment (UNIQUE on assessment_id).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_reports (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id      uuid NOT NULL REFERENCES pddr_academies(id) ON DELETE CASCADE,
  assessment_id   uuid NOT NULL UNIQUE REFERENCES pddr_assessments(id) ON DELETE CASCADE,
  verdict         text CHECK (verdict IN ('RECRUIT','DEVELOP','MONITOR','HOLD','REJECT')),
  risk_grade      text CHECK (risk_grade IN ('LOW','MEDIUM','HIGH')),
  diamond_edge    text,
  evidence_class  text NOT NULL DEFAULT 'D'
    CHECK (evidence_class IN ('A','B','C','D','Mixed')),
  report_mode     text NOT NULL DEFAULT 'Bridge v1',
  full_markdown   text NOT NULL,
  status          text NOT NULL DEFAULT 'completed'
    CHECK (status IN ('pending','completed','failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pddr_reports_academy ON pddr_reports(academy_id);
CREATE INDEX idx_pddr_reports_verdict ON pddr_reports(verdict);

-- ────────────────────────────────────────────────────────────────────────────
-- 8. pddr_mate_ai_entitlements  — bonus MATE AI access for academy
--                                 players. MATE AI checks here by
--                                 auth_user_id to flip on the dashboard.
--                                 active=false = paused (kept for history).
-- ────────────────────────────────────────────────────────────────────────────
CREATE TABLE pddr_mate_ai_entitlements (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  academy_id      uuid NOT NULL REFERENCES pddr_academies(id) ON DELETE CASCADE,
  player_id       uuid NOT NULL UNIQUE REFERENCES pddr_players(id) ON DELETE CASCADE,
  auth_user_id    uuid REFERENCES auth.users(id) ON DELETE CASCADE,
  active          boolean NOT NULL DEFAULT true,
  granted_by      text NOT NULL DEFAULT 'academy_subscription',
  activated_at    timestamptz,
  expires_at      timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX idx_pddr_entitlements_auth_user ON pddr_mate_ai_entitlements(auth_user_id);
CREATE INDEX idx_pddr_entitlements_academy   ON pddr_mate_ai_entitlements(academy_id);

-- ────────────────────────────────────────────────────────────────────────────
-- Enable Row-Level Security on every PDDR table. No policies attached yet
-- — that's migration 0002. With RLS on and no policies, only the
-- service_role key can SELECT/INSERT/UPDATE/DELETE. The Dashboard SQL
-- Editor runs as superuser so you can still query/modify rows there.
-- ────────────────────────────────────────────────────────────────────────────
ALTER TABLE pddr_academies              ENABLE ROW LEVEL SECURITY;
ALTER TABLE pddr_coaches                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pddr_teams                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE pddr_coach_team_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE pddr_players                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pddr_assessments            ENABLE ROW LEVEL SECURITY;
ALTER TABLE pddr_reports                ENABLE ROW LEVEL SECURITY;
ALTER TABLE pddr_mate_ai_entitlements   ENABLE ROW LEVEL SECURITY;
