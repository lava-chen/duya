# Migration Workflow

Write, review, and apply Supabase migrations safely. Supabase
manages schema changes as ordered SQL files in the
`supabase/migrations/` directory; this skill ensures every change
goes through that path — never through the SQL editor or a direct
`ALTER TABLE` against the live database.

## When to use

- The user says "add a column to ..." / "create a new table for ..."
  / "change the type of X".
- The `postgres-best-practices` skill produced a SQL snippet that
  needs to land as a migration.
- An existing migration in the project needs to be amended before
  it is applied (e.g. caught in review before deploy).

## Process

1. Confirm the project's migration directory layout. Standard
   Supabase CLI projects use `supabase/migrations/`; if the project
   uses a different layout, follow the existing convention.
2. Generate a migration file with the canonical filename pattern
   `<timestamp>_<slug>.sql` (e.g. `20260729120000_add_user_profile.sql`).
   Use the Supabase CLI's `supabase migration new <slug>` when
   available; otherwise generate the timestamp locally.
3. Write the SQL using the snippet from `postgres-best-practices`.
   The migration must be idempotent where possible — wrap
   `CREATE TABLE` / `CREATE INDEX` in `IF NOT EXISTS`, but never
   `ALTER TABLE` (it cannot be made idempotent without a guard
   query).
4. If the migration adds a destructive operation (`DROP COLUMN`,
   `DROP TABLE`, `TRUNCATE`), split it into two migrations: the
   first renames or archives, the second drops after a verification
   window. Surface the split to the user before writing.
5. Show the proposed file path and SQL to the user before applying.
   Apply via `supabase.apply_migration` — never via
   `supabase.query` against the live database.
6. After applying, verify with `supabase.list_migrations` that the
   new migration appears at the head. Read back the affected
   `describe_table` to confirm the schema change landed as
   expected.

## Tool call patterns

- `supabase.list_migrations` returns the applied migrations in
  order. Always check it before generating a new file — the
  timestamp must be strictly greater than the latest applied one.
- `supabase.apply_migration(name, sql)` is the canonical apply
  path. It wraps the SQL in a transaction and records the
  migration in the `supabase_migrations.schema_migrations` table.
- For multi-statement migrations, separate statements with `;`
  inside a single SQL string. Do not call `apply_migration`
  repeatedly for one logical change.

## Confirmation boundary

- Reading existing migrations and the schema: `read` tier,
  automatic.
- Drafting the migration SQL in chat: `draft` tier, automatic.
- Writing the migration file to disk: `write` tier, confirm the
  path and the SQL with the user before the first write.
- Applying the migration to the live project: `modify` tier,
  confirm. Show the SQL one more time immediately before the apply
  call.
- Rolling back or deleting a migration: `destructive` tier, strong
  explicit confirmation. Supabase does not support down migrations
  by default — a "rollback" is a forward migration that reverses
  the change, and the original migration file stays in the history.

## Pitfalls

- `ALTER TYPE ... ADD VALUE` cannot run inside a transaction.
  Supabase's `apply_migration` wraps SQL in a transaction; split
  enum changes into a separate non-transactional migration or use
  the Supabase dashboard for enum additions.
- A migration that adds a `NOT NULL` column without a default
  fails on a non-empty table. Either provide a default or add the
  column nullable, backfill, then add the `NOT NULL` constraint in
  a follow-up.
- RLS policies added in the same migration as `CREATE TABLE` must
  come after `ALTER TABLE ... ENABLE ROW LEVEL SECURITY`. Order
  matters within a single migration.
- Do not edit a previously-applied migration file. Supabase tracks
  the file hash; editing it breaks the migration history. Always
  add a new migration.
- Local Supabase CLI (`supabase migration list`) and the MCP
  server (`supabase.list_migrations`) should agree. If they
  diverge, the project's `supabase_migrations.schema_migrations`
  table is the source of truth — investigate before applying.
