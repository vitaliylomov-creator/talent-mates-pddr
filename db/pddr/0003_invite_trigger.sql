-- ────────────────────────────────────────────────────────────────────────────
-- PDDR · Migration 0003 — Auto-link invited coaches to auth.users
-- ────────────────────────────────────────────────────────────────────────────
--
-- Target project: Mate AI Supabase (zlkzjeaojpxzccpovygk)
-- Apply via:      Supabase Dashboard → SQL Editor
-- Depends on:     0001_schema.sql, 0002_rls.sql
--
-- What this does
-- ──────────────
-- The invite-coach edge function (Session 3) inserts a pddr_coaches row
-- with status='pending' and auth_user_id=NULL, then calls
-- supabase.auth.admin.inviteUserByEmail(). Supabase creates the auth.users
-- row immediately (email_confirmed_at NULL until the user clicks the
-- invite link in their email).
--
-- This trigger watches auth.users for the moment email_confirmed_at
-- transitions from NULL to a timestamp (= user accepted invite + set
-- password) and links the pending pddr_coaches row by matching email.
--
-- SECURITY DEFINER lets the trigger update pddr_coaches without being
-- blocked by RLS. search_path is pinned to public to avoid any
-- function-shadowing attack from a user schema.
--
-- ────────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION pddr_link_invited_coach()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Only act once the user has confirmed their email (post-invite-accept).
  -- For INSERT path: a hand-crafted user row might already arrive confirmed.
  -- For UPDATE path: typical invite flow flips email_confirmed_at NULL → now().
  IF NEW.email_confirmed_at IS NOT NULL THEN
    UPDATE pddr_coaches
       SET auth_user_id = NEW.id,
           status       = 'active',
           updated_at   = now()
     WHERE lower(email) = lower(NEW.email)
       AND auth_user_id IS NULL
       AND status = 'pending';
  END IF;
  RETURN NEW;
END;
$$;

-- One trigger handles both INSERT-with-already-confirmed and the more
-- common UPDATE that flips email_confirmed_at.
DROP TRIGGER IF EXISTS pddr_link_coach_on_auth_confirm ON auth.users;

CREATE TRIGGER pddr_link_coach_on_auth_confirm
  AFTER INSERT OR UPDATE OF email_confirmed_at ON auth.users
  FOR EACH ROW
  EXECUTE FUNCTION pddr_link_invited_coach();

-- ────────────────────────────────────────────────────────────────────────────
-- Rollback:
--
--   DROP TRIGGER IF EXISTS pddr_link_coach_on_auth_confirm ON auth.users;
--   DROP FUNCTION IF EXISTS pddr_link_invited_coach();
--
-- ────────────────────────────────────────────────────────────────────────────
