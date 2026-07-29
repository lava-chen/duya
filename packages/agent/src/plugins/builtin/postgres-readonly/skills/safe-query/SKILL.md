# Safe Query

Run SELECT queries against PostgreSQL with explicit read-only guards.
This skill is the default path for any data-retrieval request — never
issue raw SQL through a generic `query` tool without the checks below.

## When to use

- The user asks for row-level data: "show me the last 10 orders", "how
  many signups per day?".
- A downstream skill (e.g. `data-analysis`) needs a result set to
  summarize.
- You need to verify a hypothesis about table contents before
  suggesting a schema change.

## Process

1. Confirm the target table exists and the column names are correct by
   running the `schema-inspection` skill first if you have not already
   in this session.
2. Add an explicit `LIMIT` to every SELECT. Start with `LIMIT 100` and
   widen only if the user asks for more.
3. Prefer projecting specific columns over `SELECT *`. `SELECT *` on
   wide tables blows up the MCP response buffer.
4. For aggregate questions, compute in SQL (`COUNT`, `GROUP BY`,
   window functions) instead of pulling rows into chat.
5. Parameterize via `WHERE` predicates; do not concatenate user input
   into the query string.

## Tool call patterns

- Always use `query` with a single SELECT statement. Do not chain
  multiple statements separated by `;` — the MCP server executes them
  as one transaction and the error surface is worse.
- For time-bounded questions, use `BETWEEN` on an indexed timestamp
  column rather than `>=`/`<=` plus `ORDER BY` when an index exists.
- Wrap the query in a CTE when you need to compose multiple stages;
   CTEs are read-only and keep the top-level statement simple.

## Confirmation boundary

Plain SELECT is `read` tier and runs automatically. The following
SELECT-adjacent statements are NOT read and must be confirmed:
- `SELECT ... FOR UPDATE` — takes a row lock, treat as `modify`.
- `EXPLAIN ANALYZE` on a write-bearing statement — executes the write,
  treat as `destructive`.
- `COPY ... TO PROGRAM` — shells out, treat as `destructive`.

## Pitfalls

- The MCP server runs every statement in a single transaction and rolls
  back on error. A long-running SELECT blocks vacuuming on hot tables.
- `LIMIT` without `ORDER BY` returns non-deterministic rows; always
  order by a stable key.
- `COUNT(*)` on very large tables can be slow; prefer
  `reltuples` from `pg_class` for an approximate count first.
