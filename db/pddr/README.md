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

## What's NOT in scope yet

- **RLS policies** → migration `0002_rls.sql` (Session 2)
- **Coach invite flow** → edge function + migration `0003_invites.sql`
  (Session 3)
- **Player invite + MATE AI auto-provision** → Session 4
- **Make.com dual-write** → Session 5
- **Frontend cut over** → Session 6
- **Airtable retirement** → end of Session 6

## Rollback

`db/pddr/0001_rollback.sql` (not written yet — will add before we
ship anything important. For now the rollback is "drop the eight
`pddr_*` tables" which is trivial because nothing else depends on
them):

```sql
DROP TABLE IF EXISTS pddr_mate_ai_entitlements CASCADE;
DROP TABLE IF EXISTS pddr_reports              CASCADE;
DROP TABLE IF EXISTS pddr_assessments          CASCADE;
DROP TABLE IF EXISTS pddr_players              CASCADE;
DROP TABLE IF EXISTS pddr_coach_team_assignments CASCADE;
DROP TABLE IF EXISTS pddr_teams                CASCADE;
DROP TABLE IF EXISTS pddr_coaches              CASCADE;
DROP TABLE IF EXISTS pddr_academies            CASCADE;
DROP FUNCTION IF EXISTS pddr_set_updated_at;
```
