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

## What's NOT in scope yet

- **Coach invite flow** → edge function + migration `0003_invites.sql`
  (Session 3)
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
