-- ════════════════════════════════════════════════════════════════════════════
-- MATE Pro · Schema migration 0005 — agents product (B2B for football agents)
-- ════════════════════════════════════════════════════════════════════════════
--
-- Target project:    Mate AI Supabase (zlkzjeaojpxzccpovygk · eu-central-1)
-- Apply via:         Supabase Dashboard → SQL Editor → paste → Run
--                    (do NOT run `supabase db push` from this repo — the
--                    linked CLI project is `cwoedvxltgtwmjazekal`/creators)
--
-- What this file does
-- ───────────────────
--   1. Creates six `mate_pro_*` tables for the agent dashboard product.
--   2. Creates six enum types prefixed `mate_pro_*` so they cannot
--      collide with future enums in the same Postgres database.
--   3. Adds the indexes RLS will need (every agent_id, every FK).
--   4. Adds three helper functions:
--        - mate_pro_set_updated_at()        trigger fn for touch
--        - mate_pro_assign_founding_number() atomic counter bump
--        - mate_pro_bump_conversation_counter() trigger fn
--   5. Attaches triggers for updated_at and the messages → conv counter.
--   6. Enables Row-Level Security on every table with policies per
--      Section 1.3 of MATE_PRO_SUPABASE_SPEC_v1.md.
--   7. Seeds a single row in mate_pro_founding_counter (id=1).
--
-- Why the `mate_pro_` prefix
-- ──────────────────────────
-- This database is shared with MATE for Players (which already owns
-- `conversations`, `messages`, `players`, `subscriptions`, `profiles`,
-- `training_logs`) and with PDDR (which owns `pddr_*`). Bare
-- `conversations` / `messages` would silently merge MATE Pro chat with
-- Players chat — a catastrophic data leak across products. Every
-- MATE Pro table, enum, function, trigger and index is prefixed.
--
-- Once MATE Pro ever moves to its own Supabase project we can drop the
-- prefix in a renaming migration; until then prefix is non-negotiable.
--
-- Naming conventions (consistent with 0001_schema.sql)
-- ────────────────────────────────────────────────────
--   • tables    — lower_snake plural, prefix `mate_pro_`
--   • enums     — lower_snake, prefix `mate_pro_`
--   • columns   — lower_snake
--   • uuid PKs  — `id`, default `gen_random_uuid()`
--   • FKs       — `<entity>_id`
--   • check constraints kept inline so the values are visible at table-def
--
-- Idempotency
-- ───────────
-- Every CREATE uses IF NOT EXISTS. Re-running the file on a database
-- that already has these objects is a no-op. RLS policies are also
-- guarded so re-applying does not error.
--
-- ════════════════════════════════════════════════════════════════════════════

-- pgcrypto for gen_random_uuid() — pre-enabled on Supabase but safe to assert.
CREATE EXTENSION IF NOT EXISTS pgcrypto;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 1 — Enum types
-- ════════════════════════════════════════════════════════════════════════════
-- Postgres has no CREATE TYPE ... IF NOT EXISTS, so we DO blocks instead.

DO $$ BEGIN
  CREATE TYPE mate_pro_client_status AS ENUM ('active','prospect','dormant');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mate_pro_player_position AS ENUM (
    'Goalkeeper','Centre Back','Right Back','Left Back',
    'Defensive Midfielder','Central Midfielder','Attacking Midfielder',
    'Right Winger','Left Winger','Striker','Centre Forward'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mate_pro_dominant_foot AS ENUM ('Right','Left','Both');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mate_pro_message_role AS ENUM ('user','assistant','system');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mate_pro_video_focus AS ENUM (
    'positioning','technical','decisions','physical'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mate_pro_analysis_status AS ENUM (
    'pending','extracting','analysing','complete','failed'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 2 — Shared trigger function: updated_at
-- ════════════════════════════════════════════════════════════════════════════
-- Mirrors pddr_set_updated_at() for the MATE Pro namespace.

CREATE OR REPLACE FUNCTION mate_pro_set_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 3 — Tables
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1. mate_pro_agents — the licensed football agent's identity + FFAR
-- ────────────────────────────────────────────────────────────────────────────
-- One row per authenticated MATE Pro user. The FFAR licence is the
-- non-negotiable gate — empty value is rejected by check constraint.
-- Founding 100 number is assigned at registration via the atomic
-- mate_pro_assign_founding_number() RPC (NULL after cap reached).
CREATE TABLE IF NOT EXISTS public.mate_pro_agents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Identity
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  email            text NOT NULL,

  -- FFAR licence (required at registration, format not validated — varies by federation)
  ffar_licence     text NOT NULL,
  ffar_country     text NOT NULL,
  ffar_verified    boolean NOT NULL DEFAULT false,
  ffar_verified_at timestamptz,

  -- Practice (nullable — filled later from Agent Profile modal)
  agency_name          text,
  country_of_operation text,
  years_experience     int,
  specialisation       text,

  -- Founding 100
  founding_number  int UNIQUE,                          -- 1..100, NULL after cap
  is_founding      boolean GENERATED ALWAYS AS (founding_number IS NOT NULL) STORED,

  -- Lifecycle
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT mate_pro_agents_ffar_not_empty CHECK (length(trim(ffar_licence)) > 0)
);

CREATE INDEX IF NOT EXISTS idx_mate_pro_agents_user_id  ON public.mate_pro_agents(user_id);
CREATE INDEX IF NOT EXISTS idx_mate_pro_agents_founding ON public.mate_pro_agents(founding_number)
  WHERE founding_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mate_pro_agents_ffar     ON public.mate_pro_agents(ffar_licence);

DROP TRIGGER IF EXISTS trg_mate_pro_agents_touch ON public.mate_pro_agents;
CREATE TRIGGER trg_mate_pro_agents_touch
  BEFORE UPDATE ON public.mate_pro_agents
  FOR EACH ROW EXECUTE FUNCTION mate_pro_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 2. mate_pro_clients — the agent's player clients
-- ────────────────────────────────────────────────────────────────────────────
-- One client belongs to exactly one agent (the agent who entered them).
-- No cross-agent visibility, enforced by RLS in SECTION 5.
CREATE TABLE IF NOT EXISTS public.mate_pro_clients (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id             uuid NOT NULL REFERENCES public.mate_pro_agents(id) ON DELETE CASCADE,

  -- Identity
  first_name           text NOT NULL,
  last_name            text NOT NULL,
  date_of_birth        date,
  nationality          text,

  -- Football profile
  position_primary     mate_pro_player_position,
  dominant_foot        mate_pro_dominant_foot,
  current_club         text,
  current_league       text,
  height_cm            int,
  weight_kg            int,

  -- Contract & representation
  contract_expires     date,
  status               mate_pro_client_status NOT NULL DEFAULT 'active',
  representation_notes text,
  commission_pct       numeric(4,2),                      -- e.g. 3.00 = 3%

  -- Notes for MATE prompt context
  career_history       text,
  notes_for_mate       text,

  -- Lifecycle
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mate_pro_clients_agent_id ON public.mate_pro_clients(agent_id);
CREATE INDEX IF NOT EXISTS idx_mate_pro_clients_status   ON public.mate_pro_clients(agent_id, status);

DROP TRIGGER IF EXISTS trg_mate_pro_clients_touch ON public.mate_pro_clients;
CREATE TRIGGER trg_mate_pro_clients_touch
  BEFORE UPDATE ON public.mate_pro_clients
  FOR EACH ROW EXECUTE FUNCTION mate_pro_set_updated_at();


-- ────────────────────────────────────────────────────────────────────────────
-- 3. mate_pro_conversations — one chat thread
-- ────────────────────────────────────────────────────────────────────────────
-- Linked to an agent and optionally to one client (the active client
-- when the conversation started). When the agent switches active
-- client, the dashboard filters history by client_id (Section 4.2).
CREATE TABLE IF NOT EXISTS public.mate_pro_conversations (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        uuid NOT NULL REFERENCES public.mate_pro_agents(id) ON DELETE CASCADE,
  client_id       uuid REFERENCES public.mate_pro_clients(id) ON DELETE SET NULL,

  title           text,                                  -- auto-generated from first message
  sub_agent       text,                                  -- 'auto'|'legal'|'coach'|'analyst'|'concierge'

  message_count   int NOT NULL DEFAULT 0,
  last_message_at timestamptz NOT NULL DEFAULT now(),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mate_pro_conv_agent
  ON public.mate_pro_conversations(agent_id, last_message_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_pro_conv_client
  ON public.mate_pro_conversations(client_id)
  WHERE client_id IS NOT NULL;


-- ────────────────────────────────────────────────────────────────────────────
-- 4. mate_pro_messages — chat messages
-- ────────────────────────────────────────────────────────────────────────────
-- One row per message. Carries optional attachment metadata; for
-- video analyses the attachment_ref points to mate_pro_video_analyses.id.
CREATE TABLE IF NOT EXISTS public.mate_pro_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id uuid NOT NULL REFERENCES public.mate_pro_conversations(id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES public.mate_pro_agents(id) ON DELETE CASCADE,

  role            mate_pro_message_role NOT NULL,
  content         text NOT NULL,
  sub_agent       text,                                  -- which sub-agent answered

  -- Attachments
  attachment_type text,                                  -- 'pdf'|'video_analysis'|NULL
  attachment_ref  uuid,                                  -- → mate_pro_video_analyses.id when type='video_analysis'
  attachment_meta jsonb,

  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mate_pro_messages_conv
  ON public.mate_pro_messages(conversation_id, created_at);
CREATE INDEX IF NOT EXISTS idx_mate_pro_messages_agent
  ON public.mate_pro_messages(agent_id, created_at DESC);


-- ────────────────────────────────────────────────────────────────────────────
-- 5. mate_pro_video_analyses — video analysis records
-- ────────────────────────────────────────────────────────────────────────────
-- Kept independent of conversation deletes (analyses are heavy work
-- and the agent may want to retain history after deleting a thread).
-- A mate_pro_messages row references this table via attachment_ref.
CREATE TABLE IF NOT EXISTS public.mate_pro_video_analyses (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id         uuid NOT NULL REFERENCES public.mate_pro_agents(id) ON DELETE CASCADE,
  client_id        uuid REFERENCES public.mate_pro_clients(id) ON DELETE SET NULL,
  conversation_id  uuid REFERENCES public.mate_pro_conversations(id) ON DELETE SET NULL,

  -- Upload
  storage_path     text NOT NULL,                        -- path of original clip in mate-pro-videos bucket
  filename         text,
  size_bytes       int,
  duration_sec     numeric(5,2),

  -- Analysis parameters
  focus            mate_pro_video_focus NOT NULL DEFAULT 'positioning',
  question         text,

  -- Result
  frames_extracted int DEFAULT 0,
  frame_paths      text[],                               -- storage paths of extracted frames
  result_text      text,
  status           mate_pro_analysis_status NOT NULL DEFAULT 'pending',
  error_message    text,

  -- Lifecycle
  created_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz
);

CREATE INDEX IF NOT EXISTS idx_mate_pro_va_agent
  ON public.mate_pro_video_analyses(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_pro_va_client
  ON public.mate_pro_video_analyses(client_id)
  WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_mate_pro_va_status
  ON public.mate_pro_video_analyses(status)
  WHERE status IN ('pending','extracting','analysing');


-- ────────────────────────────────────────────────────────────────────────────
-- 6. mate_pro_founding_counter — single-row atomic counter for Founding 100
-- ────────────────────────────────────────────────────────────────────────────
-- Constraint single_row ensures only id=1 ever exists. The counter is
-- bumped exclusively by mate_pro_assign_founding_number() (SECTION 4).
CREATE TABLE IF NOT EXISTS public.mate_pro_founding_counter (
  id          int PRIMARY KEY DEFAULT 1,
  next_number int NOT NULL DEFAULT 1,
  cap         int NOT NULL DEFAULT 100,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mate_pro_founding_counter_single_row CHECK (id = 1)
);

INSERT INTO public.mate_pro_founding_counter (id, next_number, cap)
VALUES (1, 1, 100)
ON CONFLICT (id) DO NOTHING;


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 4 — Functions
-- ════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- mate_pro_assign_founding_number() — atomic Founding 100 assignment
-- ────────────────────────────────────────────────────────────────────────────
-- Called by the mate-pro-register edge function. Returns the assigned
-- number (1..100) or NULL if the cap has already been reached.
--
-- Atomicity: the UPDATE ... WHERE next_number <= cap RETURNING is
-- evaluated as one statement under row-level lock — Postgres
-- serialises concurrent updates on the same row. Two simultaneous
-- registrations cannot receive the same number.
--
-- SECURITY DEFINER + EXECUTE granted only to service_role: clients
-- can never call this directly to claim numbers.
CREATE OR REPLACE FUNCTION public.mate_pro_assign_founding_number()
RETURNS int
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  assigned int;
BEGIN
  UPDATE public.mate_pro_founding_counter
     SET next_number = next_number + 1,
         updated_at  = now()
   WHERE id = 1
     AND next_number <= cap
  RETURNING next_number - 1 INTO assigned;

  RETURN assigned;       -- NULL if cap already reached
END;
$$;

REVOKE ALL ON FUNCTION public.mate_pro_assign_founding_number() FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.mate_pro_assign_founding_number() TO service_role;


-- ────────────────────────────────────────────────────────────────────────────
-- mate_pro_bump_conversation_counter() — trigger fn on mate_pro_messages
-- ────────────────────────────────────────────────────────────────────────────
-- Keeps mate_pro_conversations.message_count and last_message_at in
-- sync without a second client roundtrip after every insert.
CREATE OR REPLACE FUNCTION public.mate_pro_bump_conversation_counter()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  UPDATE public.mate_pro_conversations
     SET message_count   = message_count + 1,
         last_message_at = NEW.created_at
   WHERE id = NEW.conversation_id;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mate_pro_msg_bump_conv ON public.mate_pro_messages;
CREATE TRIGGER trg_mate_pro_msg_bump_conv
  AFTER INSERT ON public.mate_pro_messages
  FOR EACH ROW EXECUTE FUNCTION public.mate_pro_bump_conversation_counter();


-- ════════════════════════════════════════════════════════════════════════════
-- SECTION 5 — Row Level Security
-- ════════════════════════════════════════════════════════════════════════════
-- Every table is RLS-enabled. Policies are recreated idempotently
-- (DROP + CREATE) so re-applying the file does not error.

ALTER TABLE public.mate_pro_agents             ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mate_pro_clients            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mate_pro_conversations      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mate_pro_messages           ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mate_pro_video_analyses     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.mate_pro_founding_counter   ENABLE ROW LEVEL SECURITY;


-- ── mate_pro_agents ──
-- Agents read and update only their own row. INSERT is service-role
-- only (handled by mate-pro-register edge function so the Founding
-- number assignment stays atomic and the FFAR check is enforced).
DROP POLICY IF EXISTS mate_pro_agents_select_self ON public.mate_pro_agents;
CREATE POLICY mate_pro_agents_select_self
  ON public.mate_pro_agents FOR SELECT TO authenticated
  USING (user_id = auth.uid());

DROP POLICY IF EXISTS mate_pro_agents_update_self ON public.mate_pro_agents;
CREATE POLICY mate_pro_agents_update_self
  ON public.mate_pro_agents FOR UPDATE TO authenticated
  USING      (user_id = auth.uid())
  WITH CHECK (user_id = auth.uid());


-- ── mate_pro_clients ──
-- Agent has full CRUD on their own clients, zero visibility into
-- anyone else's. The subselect pattern matches Section 1.3 of the spec.
DROP POLICY IF EXISTS mate_pro_clients_select_own ON public.mate_pro_clients;
CREATE POLICY mate_pro_clients_select_own
  ON public.mate_pro_clients FOR SELECT TO authenticated
  USING (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS mate_pro_clients_insert_own ON public.mate_pro_clients;
CREATE POLICY mate_pro_clients_insert_own
  ON public.mate_pro_clients FOR INSERT TO authenticated
  WITH CHECK (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS mate_pro_clients_update_own ON public.mate_pro_clients;
CREATE POLICY mate_pro_clients_update_own
  ON public.mate_pro_clients FOR UPDATE TO authenticated
  USING      (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()))
  WITH CHECK (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS mate_pro_clients_delete_own ON public.mate_pro_clients;
CREATE POLICY mate_pro_clients_delete_own
  ON public.mate_pro_clients FOR DELETE TO authenticated
  USING (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));


-- ── mate_pro_conversations ──
-- Agent has full access to their own conversation rows; cross-agent
-- read/write is impossible.
DROP POLICY IF EXISTS mate_pro_conv_select_own ON public.mate_pro_conversations;
CREATE POLICY mate_pro_conv_select_own
  ON public.mate_pro_conversations FOR SELECT TO authenticated
  USING (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS mate_pro_conv_all_own ON public.mate_pro_conversations;
CREATE POLICY mate_pro_conv_all_own
  ON public.mate_pro_conversations FOR ALL TO authenticated
  USING      (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()))
  WITH CHECK (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));


-- ── mate_pro_messages ──
-- Agent can read all their own messages and insert new ones tagged
-- with their own agent_id. No UPDATE/DELETE policies — chat history
-- is append-only for the agent. Service role can still cleanup.
DROP POLICY IF EXISTS mate_pro_messages_select_own ON public.mate_pro_messages;
CREATE POLICY mate_pro_messages_select_own
  ON public.mate_pro_messages FOR SELECT TO authenticated
  USING (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS mate_pro_messages_insert_own ON public.mate_pro_messages;
CREATE POLICY mate_pro_messages_insert_own
  ON public.mate_pro_messages FOR INSERT TO authenticated
  WITH CHECK (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));


-- ── mate_pro_video_analyses ──
-- Agent reads and inserts own rows. Updates come from the
-- mate-pro-video-analyse edge function (service role), so no UPDATE
-- policy for authenticated users.
DROP POLICY IF EXISTS mate_pro_va_select_own ON public.mate_pro_video_analyses;
CREATE POLICY mate_pro_va_select_own
  ON public.mate_pro_video_analyses FOR SELECT TO authenticated
  USING (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));

DROP POLICY IF EXISTS mate_pro_va_insert_own ON public.mate_pro_video_analyses;
CREATE POLICY mate_pro_va_insert_own
  ON public.mate_pro_video_analyses FOR INSERT TO authenticated
  WITH CHECK (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));


-- ── mate_pro_founding_counter ──
-- Authenticated users may read the counter (so a public-ish
-- "X of 100 admitted" stat can be shown on the dashboard). Writes
-- only via mate_pro_assign_founding_number() under service_role.
DROP POLICY IF EXISTS mate_pro_founding_counter_read_all ON public.mate_pro_founding_counter;
CREATE POLICY mate_pro_founding_counter_read_all
  ON public.mate_pro_founding_counter FOR SELECT TO authenticated
  USING (true);


-- ════════════════════════════════════════════════════════════════════════════
-- End of migration 0005_mate_pro_init.sql
-- ════════════════════════════════════════════════════════════════════════════
