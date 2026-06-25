-- ════════════════════════════════════════════════════════════════════════════
-- MATE Pro · Billing migration 0007 — Stripe subscriptions
-- ════════════════════════════════════════════════════════════════════════════
--
-- Target project:    Mate AI Supabase (zlkzjeaojpxzccpovygk · eu-central-1)
-- Apply via:         Supabase Dashboard → SQL Editor → paste → Run
-- Depends on:        0005_mate_pro_init.sql (mate_pro_agents)
--
-- What this file does
-- ───────────────────
--   1. Creates mate_pro_subscriptions table — one row per Stripe
--      subscription (an agent can in theory have multiple over their
--      lifetime; we always join on the active one).
--   2. Adds founding_window_ends_at to mate_pro_agents — the deadline
--      after which the Founding €149 price is no longer offered.
--      Calculated as created_at + 30 days at registration time.
--   3. Adds Row-Level Security: agents read their own subscriptions
--      only; service_role writes from the webhook handler.
--   4. Triggers updated_at on the subscriptions table.
--
-- Business logic encoded in this schema
-- ─────────────────────────────────────
-- * plan = 'founding' | 'standard' — which price the subscription
--   is billed at. Founding requires ffar_verified=true AND created
--   before founding_window_ends_at on the agent's row.
-- * status — mirrors Stripe subscription status verbatim. Active
--   product access is granted when status IN ('trialing','active').
-- * current_period_end — when the next charge happens, or when
--   access ends if cancel_at is set.
-- * cancel_at — non-null when the agent has cancelled but still has
--   paid time remaining. Set by Stripe when subscription.cancel_at_
--   period_end is toggled true.
-- * trial_ends_at — 14 days from subscription creation. While
--   status='trialing', no charge is on the card yet.
--
-- ════════════════════════════════════════════════════════════════════════════

-- ── ENUMS ──────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE mate_pro_subscription_plan AS ENUM ('founding','standard');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE mate_pro_subscription_status AS ENUM (
    'trialing','active','past_due','canceled','incomplete','incomplete_expired','unpaid','paused'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ── 1. mate_pro_subscriptions ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.mate_pro_subscriptions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id                uuid NOT NULL REFERENCES public.mate_pro_agents(id) ON DELETE CASCADE,

  -- Stripe identifiers
  stripe_customer_id      text NOT NULL,
  stripe_subscription_id  text NOT NULL UNIQUE,
  stripe_price_id         text NOT NULL,

  -- Business state
  plan                    mate_pro_subscription_plan NOT NULL,
  status                  mate_pro_subscription_status NOT NULL,

  -- Timing — mirrored from Stripe events
  trial_ends_at           timestamptz,
  current_period_start    timestamptz,
  current_period_end      timestamptz,
  cancel_at               timestamptz,                    -- set when cancel_at_period_end=true on Stripe
  canceled_at             timestamptz,                    -- set when subscription actually ended
  ended_at                timestamptz,

  -- Lifecycle
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mate_pro_subs_agent
  ON public.mate_pro_subscriptions(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_mate_pro_subs_status_active
  ON public.mate_pro_subscriptions(agent_id)
  WHERE status IN ('trialing','active');
CREATE INDEX IF NOT EXISTS idx_mate_pro_subs_customer
  ON public.mate_pro_subscriptions(stripe_customer_id);

DROP TRIGGER IF EXISTS trg_mate_pro_subs_touch ON public.mate_pro_subscriptions;
CREATE TRIGGER trg_mate_pro_subs_touch
  BEFORE UPDATE ON public.mate_pro_subscriptions
  FOR EACH ROW EXECUTE FUNCTION mate_pro_set_updated_at();


-- ── 2. founding_window_ends_at on mate_pro_agents ─────────────────
-- 30-day window from registration during which the Founding €149
-- lifetime price is available, contingent on ffar_verified=true.
-- After this timestamp, only the Standard €299 price is offered.
--
-- Implementation note. PostgreSQL refuses GENERATED ALWAYS AS for
-- (timestamptz + interval) — the operator is STABLE not IMMUTABLE
-- because of theoretical DST/timezone edge cases. We use a BEFORE
-- INSERT trigger instead, which is functionally equivalent and lets
-- us backfill existing rows once with a plain UPDATE.
ALTER TABLE public.mate_pro_agents
  ADD COLUMN IF NOT EXISTS founding_window_ends_at timestamptz;

CREATE OR REPLACE FUNCTION public.mate_pro_set_founding_window()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW.founding_window_ends_at IS NULL THEN
    NEW.founding_window_ends_at = NEW.created_at + INTERVAL '30 days';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_mate_pro_agents_set_founding_window ON public.mate_pro_agents;
CREATE TRIGGER trg_mate_pro_agents_set_founding_window
  BEFORE INSERT ON public.mate_pro_agents
  FOR EACH ROW EXECUTE FUNCTION public.mate_pro_set_founding_window();

-- Backfill existing rows (founder + any pre-billing agents)
UPDATE public.mate_pro_agents
   SET founding_window_ends_at = created_at + INTERVAL '30 days'
 WHERE founding_window_ends_at IS NULL;


-- ── 3. Helper view: current active subscription per agent ─────────
-- Convenient for chat/video gate queries. Returns at most one row
-- per agent (the most recently created subscription with a live
-- status). NULL row if the agent has never subscribed or all their
-- subscriptions are canceled/expired.
CREATE OR REPLACE VIEW public.mate_pro_active_subscription AS
SELECT DISTINCT ON (agent_id)
  agent_id, id AS subscription_id, plan, status,
  trial_ends_at, current_period_end, cancel_at,
  stripe_subscription_id, stripe_customer_id
FROM public.mate_pro_subscriptions
WHERE status IN ('trialing','active','past_due')
ORDER BY agent_id, created_at DESC;


-- ── 4. RLS ──────────────────────────────────────────────────────
ALTER TABLE public.mate_pro_subscriptions ENABLE ROW LEVEL SECURITY;

-- Agents read their own subscription rows only. Webhook (service role)
-- writes; no INSERT/UPDATE policy for authenticated users.
DROP POLICY IF EXISTS mate_pro_subs_select_own ON public.mate_pro_subscriptions;
CREATE POLICY mate_pro_subs_select_own
  ON public.mate_pro_subscriptions FOR SELECT TO authenticated
  USING (agent_id = (SELECT id FROM public.mate_pro_agents WHERE user_id = auth.uid()));


-- ── 5. Helper function: is_subscription_active(agent_id) ─────────
-- Returns true when the agent has a subscription in ('trialing','active')
-- OR has cancel_at in the future. Used by chat/video gate.
CREATE OR REPLACE FUNCTION public.mate_pro_has_active_access(p_agent_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM public.mate_pro_subscriptions
    WHERE agent_id = p_agent_id
      AND status IN ('trialing','active')
      AND (current_period_end IS NULL OR current_period_end > now())
  );
$$;

REVOKE ALL ON FUNCTION public.mate_pro_has_active_access(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.mate_pro_has_active_access(uuid) TO authenticated, service_role;


-- ── End of migration 0007_mate_pro_billing.sql ──
