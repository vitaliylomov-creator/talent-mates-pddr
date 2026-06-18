# PDDR Supabase migrations

SQL migrations for the Fibonacci PDDR multi-tenant academy product.
Applied **manually** via the Supabase Dashboard SQL Editor against the
**MATE AI** project (`zlkzjeaojpxzccpovygk` · eu-central-1).

> ⚠️ Do **not** run `supabase db push` from this repo. The local
> Supabase CLI in `../supabase/` is linked to the **creators** project
> (`cwoedvxltgtwmjazekal`). Running migrations through it would land
> them in the wrong project. Always paste the SQL into the MATE AI
> project's Dashboard SQL Editor instead.

## Project routing

| URL hardcoded in | Supabase project | Project ref |
|---|---|---|
| `fibonacci.html` · `player_report_sign.html` · `coach_dashboard.html` · `player_dashboard.html` | **Mate AI** | `zlkzjeaojpxzccpovygk` |
| `creators-*.html` + `supabase/functions/creators-*` | **talent-mates-creators** | `cwoedvxltgtwmjazekal` |

PDDR shares Postgres with MATE AI by design — same `auth.users`, so a
coach who is also a MATE AI individual subscriber gets one identity.
All PDDR tables are prefixed `pddr_` to keep the namespace clean.

## How to apply

1. Open Supabase Dashboard → switch to the **Mate AI** project.
2. SQL Editor → New query → paste contents of `0001_schema.sql` → Run.
3. New query → paste contents of `0001_seed.sql` → Run.
4. Table Editor → confirm eight `pddr_*` tables exist.
5. Run this sanity query:

```sql
SELECT a.name AS academy, t.name AS team,
       c.full_name AS coach, c.role
FROM pddr_academies a
JOIN pddr_teams t  ON t.academy_id = a.id
LEFT JOIN pddr_coach_team_assignments cta ON cta.team_id = t.id
LEFT JOIN pddr_coaches c ON c.id = cta.coach_id
WHERE a.slug = 'talent-mates-demo'
ORDER BY t.name;
```

You should see two rows (U19, U21) both linked to Vitalii Lomov as
Sporting Director. If the coach name is NULL, run the manual snippet
at the bottom of `0001_seed.sql` after signing in via fibonacci.html
once (so your `auth.users` row exists).

## What's in scope for migration 0001

- 8 tables with the multi-tenancy and ageing-group hierarchy agreed
  in the Phase 1 brainstorm: `pddr_academies`, `pddr_coaches`,
  `pddr_teams`, `pddr_coach_team_assignments`, `pddr_players`,
  `pddr_assessments`, `pddr_reports`, `pddr_mate_ai_entitlements`.
- Indexes on every foreign key and every `academy_id` (RLS will
  filter on these constantly).
- `updated_at` trigger on the tables that mutate.
- Row-Level Security **enabled** on every table, with **zero
  policies**. Until 0002 ships, only `service_role` can read/write.

## What's in scope for migration 0002

- 5 SECURITY DEFINER helper functions:
  `pddr_current_coach_id`, `pddr_current_coach_academy_id`,
  `pddr_current_coach_role`, `pddr_is_sporting_director`,
  `pddr_current_coach_team_ids`. These return the authenticated
  coach's context without recursing through RLS.
- Policies on every `pddr_*` table per the v1 access matrix
  (Session 2 brainstorm, option B — any coach with team access
  can read/write players, assessments, reports for their teams).
- Players read self, own assessments, own reports, own entitlement
  and may update their own player record.
- Reports and entitlements are written only by `service_role`
  (Make.com webhook for reports; edge function for entitlements).
  No INSERT/UPDATE policies for authenticated users on those.

A test block at the bottom of `0002_rls.sql` (kept commented out)
impersonates you as Sporting Director and prints counts that must
match expectations — paste it into the SQL Editor after applying
the migration to confirm policies behave as designed.

## What's in scope for migration 0003

- One trigger on `auth.users` that auto-links a `pddr_coaches` row
  with `status='pending'` and matching email to the new auth user
  once they confirm the invite (i.e. set a password). After link:
  `auth_user_id = NEW.id`, `status = 'active'`.
- Companion edge function `supabase/functions/invite-coach/index.ts`
  that the Sporting Director's dashboard POSTs to. It validates SD
  role via the caller's JWT, inserts the pending `pddr_coaches`
  row, optionally adds `pddr_coach_team_assignments`, then calls
  `supabase.auth.admin.inviteUserByEmail()`. Rolls back inserts on
  any invite failure.
- Companion HTML at `coach_welcome.html` (repo root) that consumes
  the invite link, asks the user for a password, and forwards to
  `coach_dashboard.html` once activated.

### Apply order

1. `db/pddr/0003_invite_trigger.sql` → Supabase Dashboard SQL Editor.
2. Deploy the edge function:
   ```bash
   cd /path/to/talent-mates-pddr
   supabase functions deploy invite-coach \
     --project-ref zlkzjeaojpxzccpovygk
   ```
   The CLI may warn that this folder is linked to the creators
   project — the `--project-ref` flag overrides the link for this
   single deploy. It will not affect the creators functions.
3. Set required environment variables (already populated for any
   Supabase project, but verify):
   - `SUPABASE_URL`
   - `SUPABASE_ANON_KEY`
   - `SUPABASE_SERVICE_ROLE_KEY`
4. Push `coach_welcome.html` to `main` so GitHub Pages serves it
   at `https://app.talent-mates.com/coach_welcome.html`.

### Test plan

Once 0003 + edge function + welcome page are live, exercise the
flow end-to-end:

1. Get the Supabase access token for Vitalii (already SD of Talent
   Mates Demo). The easiest path: open `fibonacci.html` in DevTools
   console after signing in and run
   ```js
   (await supabase.auth.getSession()).data.session.access_token
   ```
2. Get a U19 team UUID from the SQL Editor:
   ```sql
   SELECT id FROM pddr_teams WHERE name = 'U19';
   ```
3. POST to the edge function with curl (replace placeholders):
   ```bash
   curl -X POST \
     "https://zlkzjeaojpxzccpovygk.supabase.co/functions/v1/invite-coach" \
     -H "Authorization: Bearer <vitalii_access_token>" \
     -H "Content-Type: application/json" \
     -d '{
       "email": "test-coach+u19@example.com",
       "full_name": "Test U19 Coach",
       "role": "head_coach",
       "team_ids": ["<u19_team_uuid>"]
     }'
   ```
   Expected: `200 { ok: true, coach_id: "..." }`.
4. Verify the row in SQL Editor:
   ```sql
   SELECT id, email, role, status, auth_user_id
   FROM pddr_coaches
   WHERE email = 'test-coach+u19@example.com';
   ```
   Expected: one row, `status='pending'`, `auth_user_id IS NULL`.
5. Use a real email you control for the actual invite-accept test.
   The invited user clicks the email link → lands on
   `coach_welcome.html` → sets password → redirects to
   `coach_dashboard.html`.
6. Re-check the same SQL — `status` should now be `'active'` and
   `auth_user_id` should be the new user's `auth.users.id`.

### Cleanup of test rows

```sql
-- Removes the test coach AND auth.users row.
WITH del AS (
  DELETE FROM pddr_coaches
   WHERE email = 'test-coach+u19@example.com'
   RETURNING auth_user_id
)
DELETE FROM auth.users WHERE id IN (SELECT auth_user_id FROM del WHERE auth_user_id IS NOT NULL);
```

## What's NOT in scope yet

- **Coach Dashboard UI modal** for inviting (Session 3.5 — small)
- **Player invite + MATE AI auto-provision** → Session 4
- **Make.com dual-write** → Session 5
- **Frontend cut over** → Session 6
- **Airtable retirement** → end of Session 6

## Rollback

### Roll back 0002 (drop policies + helpers only, keep schema)

```sql
-- Drop all policies (Postgres has no DROP POLICY IF EXISTS for a
-- whole table, so list each table — the table-level DROP also
-- removes its policies, but here we keep the tables and rip
-- policies one by one for safety):
DROP POLICY IF EXISTS academies_select_own ON pddr_academies;
DROP POLICY IF EXISTS coaches_select_self                ON pddr_coaches;
DROP POLICY IF EXISTS coaches_select_same_academy        ON pddr_coaches;
DROP POLICY IF EXISTS coaches_insert_sd                  ON pddr_coaches;
DROP POLICY IF EXISTS coaches_update_sd                  ON pddr_coaches;
DROP POLICY IF EXISTS coaches_update_self                ON pddr_coaches;
DROP POLICY IF EXISTS coaches_delete_sd                  ON pddr_coaches;
DROP POLICY IF EXISTS teams_select_same_academy          ON pddr_teams;
DROP POLICY IF EXISTS teams_insert_sd                    ON pddr_teams;
DROP POLICY IF EXISTS teams_update_sd                    ON pddr_teams;
DROP POLICY IF EXISTS teams_delete_sd                    ON pddr_teams;
DROP POLICY IF EXISTS cta_select_same_academy            ON pddr_coach_team_assignments;
DROP POLICY IF EXISTS cta_insert_sd                      ON pddr_coach_team_assignments;
DROP POLICY IF EXISTS cta_update_sd                      ON pddr_coach_team_assignments;
DROP POLICY IF EXISTS cta_delete_sd                      ON pddr_coach_team_assignments;
DROP POLICY IF EXISTS players_select_self                ON pddr_players;
DROP POLICY IF EXISTS players_select_team                ON pddr_players;
DROP POLICY IF EXISTS players_select_sd                  ON pddr_players;
DROP POLICY IF EXISTS players_insert_coach               ON pddr_players;
DROP POLICY IF EXISTS players_update_coach               ON pddr_players;
DROP POLICY IF EXISTS players_update_self                ON pddr_players;
DROP POLICY IF EXISTS players_delete_sd                  ON pddr_players;
DROP POLICY IF EXISTS assessments_select_player_self     ON pddr_assessments;
DROP POLICY IF EXISTS assessments_select_coach_team      ON pddr_assessments;
DROP POLICY IF EXISTS assessments_select_sd              ON pddr_assessments;
DROP POLICY IF EXISTS assessments_insert_coach           ON pddr_assessments;
DROP POLICY IF EXISTS assessments_update_assessor        ON pddr_assessments;
DROP POLICY IF EXISTS assessments_delete_sd              ON pddr_assessments;
DROP POLICY IF EXISTS reports_select_player_self         ON pddr_reports;
DROP POLICY IF EXISTS reports_select_coach_team          ON pddr_reports;
DROP POLICY IF EXISTS reports_select_sd                  ON pddr_reports;
DROP POLICY IF EXISTS reports_delete_sd                  ON pddr_reports;
DROP POLICY IF EXISTS entitlements_select_self           ON pddr_mate_ai_entitlements;
DROP POLICY IF EXISTS entitlements_select_coach_team     ON pddr_mate_ai_entitlements;
DROP POLICY IF EXISTS entitlements_select_sd             ON pddr_mate_ai_entitlements;

DROP FUNCTION IF EXISTS pddr_current_coach_team_ids();
DROP FUNCTION IF EXISTS pddr_is_sporting_director();
DROP FUNCTION IF EXISTS pddr_current_coach_role();
DROP FUNCTION IF EXISTS pddr_current_coach_academy_id();
DROP FUNCTION IF EXISTS pddr_current_coach_id();
```

### Roll back 0001 (nuke everything)

Run the 0002 rollback first, then:

```sql
DROP TABLE IF EXISTS pddr_mate_ai_entitlements CASCADE;
DROP TABLE IF EXISTS pddr_reports              CASCADE;
DROP TABLE IF EXISTS pddr_assessments          CASCADE;
DROP TABLE IF EXISTS pddr_players              CASCADE;
DROP TABLE IF EXISTS pddr_coach_team_assignments CASCADE;
DROP TABLE IF EXISTS pddr_teams                CASCADE;
DROP TABLE IF EXISTS pddr_coaches              CASCADE;
DROP TABLE IF EXISTS pddr_academies            CASCADE;
DROP FUNCTION IF EXISTS pddr_set_updated_at();
```
