# Schema Inspection

Inspect the structure of a PostgreSQL database — databases, schemas,
tables, columns, indexes, and views — without issuing any write
statements.

## When to use

- The user asks "what tables are in this database?" or "describe the
  schema for X".
- You need to ground a downstream query in the actual column names and
  types instead of guessing.
- A migration or ORM change is suspected of drifting from the live
  schema.

## Process

1. List databases / schemas first, then narrow to the relevant
   `schema.table`. Avoid `SELECT *` on large tables during inspection.
2. Use the MCP `query` tool with read-only catalog queries:
   - `SELECT table_name FROM information_schema.tables WHERE table_schema = '<schema>'`
   - `SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = '<table>'`
3. For indexes, query `pg_indexes` rather than `\di`-style psql escapes,
   which the MCP server does not understand.
4. Report the structure as a compact tree or table in chat; do not
   paste raw JSON unless the user asks.

## Tool call patterns

- Prefer the smallest query that answers the question — `COUNT(*)`,
   `MIN`/`MAX` of a timestamp column, or `DISTINCT` on a key — instead
   of dumping rows.
- Wrap identifiers in double quotes; the MCP server does not
   auto-quote.
- Never run `EXPLAIN ANALYZE` on a query that mutates data — it
   executes the statement.

## Confirmation boundary

All catalog queries are `read` tier and run automatically. If a
query needs to touch a view backed by a writable function, treat it as
`modify` and confirm with the user first.

## Pitfalls

- `information_schema` is the canonical cross-version source. `pg_catalog`
  is faster but its column names vary across major versions.
- Views may hide volatile functions. Inspect `pg_views.definition` before
  querying a view for the first time.
