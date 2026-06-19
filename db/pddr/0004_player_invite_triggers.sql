-- ────────────────────────────────────────────────────────────────────────────
-- PDDR · Migration 0004 — Player invite triggers + MATE AI entitlement
-- ────────────────────────────────────────────────────────────────────────────
--
-- Target project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
-- Apply via:      Supabase Dashboard → SQL Editor
-- Depends on:     0001_schema.sql, 0002_rls.sql, 0003_invite_trigger.sql
--
-- What this does
-- ──────────────
-- 1. Adds a UNIQUE INDEX on (academy_id, lower(email)) for pddr_players so
--    a coach cannot accidentally invite the same player email twice into
--    the same academy.
-- 2. Creates pddr_link_invited_player(): trigger function that fires when
--    auth.users.email_confirmed_at flips from NULL to a timestamp. It
--    finds the matching pending pddr_players row by email, links
--    auth_user_id, sets status='active', and ALSO auto-provisions a row
--    in pddr_mate_ai_entitlements (the "academy bonus" the founder agreed
--    in the Phase 1 brainstorm — every academy player gets free MATE AI
--    access on first login).
-- 3. The coach-link trigger from 0003 still runs first; both triggers
--    fire on the same auth.users event and operate on disjoint tables.
--    A given email is either a pending coach OR a pending player — not
--    both — so they never collide.
--
-- SECURITY DEFINER + pinned search_path = public for the same safety
-- properties as 0003.
--
-- ────────────────────────────────────────────────────────────────────────────

-- ── 1. Unique email per academy for invited players ─────────────────────────
CREATE UNIQUE INDEX IF NOT EXISTS uniq_pddr_players_academy_email
  ON pddr_players (academy_id, lower(email))
  WHERE email IS NOT NULL;


-- ── 2. Link + entitlement function ──────────────────────────────────────────
CREATE OR REPLACE FUNCTION pddr_link_invited_player()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_player_id  uuid;
  v_academy_id uuid;
BEGIN
  -- Only act once the user has confirmed (post-invite-accept).
  IF NEW.email_confirmed_at IS NOT NULL THEN

    -- Link any pending player row with this email
    UPDATE pddr_players
       SET auth_user_id = NEW.id,
           status       = 'active',
           updated_at   = now()
     WHERE lower(email) = lower(NEW.email)
       AND auth_user_id IS NULL
       AND status = 'invited'
    RETURNING id, academy_id
        INTO v_player_id, v_academy_id;

    -- If a player was just linked, grant MATE AI bonus access.
    -- ON CONFLICT handles the re-activation case: a previously revoked
    -- entitlement row gets reactivated rather than throwing.
    IF v_player_id IS NOT NULL THEN
      INSERT INTO pddr_mate_ai_entitlements
        (academy_id, player_id, auth_user_id, active, granted_by, activated_at)
      VALUES
        (v_academy_id, v_player_id, NEW.id, true, 'academy_subscription', now())
      ON CONFLICT (player_id) DO UPDATE
        SET auth_user_id = EXCLUDED.auth_user_id,
            active       = true,
            activated_at = COALESCE(pddr_mate_ai_entitlements.activated_at, EXCLUDED.activated_at);
    END IF;
  END IF;

  RETURN NEW;
END;
$$;


-- ── 3. Attach the trigger (alongside the coach-link trigger from 0003) ──────
DROP TRIGGER IF EXISTS pddr_link_player_on_auth_confirm ON auth.users;

CREATE TRIGGER pddr_link_player_on_auth_confirm
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION pddr_link_invited_player();


-- ────────────────────────────────────────────────────────────────────────────
-- Rollback:
--
--   DROP TRIGGER IF EXISTS pddr_link_player_on_auth_confirm ON auth.users;
--   DROP FUNCTION IF EXISTS pddr_link_invited_player();
--   DROP INDEX IF EXISTS uniq_pddr_players_academy_email;
--
-- ────────────────────────────────────────────────────────────────────────────
