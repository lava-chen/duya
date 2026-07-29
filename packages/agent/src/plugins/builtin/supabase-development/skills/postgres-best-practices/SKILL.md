# Postgres Best Practices

Schema design, indexing, and RLS policy patterns tuned for Supabase's
hosted Postgres. Use this skill before writing any migration — the
decisions made here (data types, indexes, RLS shape) propagate
through every downstream skill.

## When to use

- The user is designing a new table or restructuring an existing one
  on Supabase.
- A query is slow and you need to reason about indexes and row
  estimates before tuning.
- A migration is about to add a column that will be exposed via the
  auto-generated PostgREST API — the RLS and exposure decisions
  matter.

## Process

1. Read the current schema via `supabase.list_tables` and
   `supabase.describe_table`. Build a mental map of the affected
   tables and their relationships before proposing changes.
2. Pick data types appropriate for the column's actual usage:
   - `uuid` for primary keys when Supabase Auth is the source (use
     `gen_random_uuid()` defaults, not app-generated IDs).
   - `timestamptz` for all timestamps (never `timestamp without time
     zone`).
   - `jsonb` for semi-structured data (never `json` — `jsonb` is
     indexable).
   - `text` over `varchar(N)` unless there is a hard length
     constraint; Postgres performance is identical.
3. Define indexes for every foreign key and for the columns that
   appear in `WHERE` / `ORDER BY` clauses of known queries. Prefer
   partial indexes (`WHERE deleted_at IS NULL`) over full indexes
   for soft-delete patterns.
4. For every table that exposes data via the PostgREST API, define
   an RLS policy. The default should be "no access" — every policy
   must explicitly grant the operation to a role.
5. Surface the proposed schema as a SQL snippet in chat before
   handing off to `migration-workflow`. Do not run the SQL directly
   via `supabase.query` — schema changes go through migrations.

## Tool call patterns

- `supabase.list_tables` is faster than `supabase.query.select` on
  `information_schema.tables` — use the dedicated tool.
- `supabase.list_policies` returns RLS policies by table. Pair with
  `supabase.list_indexes` to verify the policy predicates have
  supporting indexes.
- For row estimates on large tables, query `pg_class.reltuples` via
  `supabase.query.select` rather than `COUNT(*)` — the latter can
  block on hot tables.

## Confirmation boundary

All activity in this skill is `read` tier because it only inspects
the schema and proposes SQL in chat. Applying the proposed SQL is
the `migration-workflow` skill's responsibility and follows the
`modify` confirmation rule.

## Pitfalls

- Supabase applies RLS only when `ALTER TABLE ... ENABLE ROW LEVEL
  SECURITY` is set. A policy without RLS enabled is a no-op —
  always verify the table's RLS state.
- `auth.uid()` in an RLS policy returns NULL for the `anon` and
  `service_role` keys. Policies that don't account for this leak
  data to anonymous callers.
- `jsonb` GIN indexes are large. Only add them when the query
  pattern actually uses JSONB containment (`@>`) or key lookups.
- The PostgREST API exposes every table by default. If a table
  should not be API-visible, revoke the `anon` and `authenticated`
  role grants — RLS alone is not enough.
- Supabase's hosted Postgres does not allow `superuser` operations.
  Extensions must come from the allowed list (PostGIS, pg_cron,
  pgvector, etc.); check the dashboard before assuming one is
  available.
