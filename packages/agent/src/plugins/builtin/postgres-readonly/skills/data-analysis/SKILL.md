# Data Analysis

Summarize PostgreSQL result sets, compute distributions, and surface
anomalies for inspection. This skill consumes data produced by the
`safe-query` skill and never issues a write statement itself.

## When to use

- The user asks "what does this data look like?" or "are there
  outliers?".
- A query result needs to be turned into a compact summary (counts,
  distributions, top-N) before reporting.
- You need to compare two segments of a table (e.g. this week vs last
  week) without exporting rows.

## Process

1. Pull the smallest result set that answers the question. Prefer
   `GROUP BY` over row-level pulls; the database is faster at
   aggregation than chat.
2. Compute distribution statistics in SQL where possible:
   `percentile_cont(0.5) WITHIN GROUP (ORDER BY x)` for medians,
   `stddev`, `avg`, `min`, `max`.
3. For top-N, use `ORDER BY ... LIMIT N` with a deterministic tiebreaker.
4. For time-series, bucket with `date_trunc('day', ts)` (or hour /
   minute) before aggregating.
5. Report findings as a small table or bullet list. Surface the query
   used alongside the result so the user can audit it.

## Tool call patterns

- Compose with CTEs: one CTE per stage (`base`, `filtered`,
   `aggregated`). Read-only, easy to inspect.
- Use `FILTER (WHERE ...)` inside ` aggregate` for cleaner pivots than
   nested `CASE WHEN`.
- For cardinality checks, `COUNT(DISTINCT col)` is correct but slow on
   wide tables; sample with `TABLESAMPLE SYSTEM (1)` first.

## Confirmation boundary

All activity in this skill is `read` tier because it only issues
SELECTs. If the user asks for a materialized view refresh or a
`CREATE TABLE AS` to cache results, that is `modify` — confirm first,
and consider whether the read-only role even permits it.

## Pitfalls

- `NULL` skews aggregates silently. Always pair `avg(x)` with
  `count(x)` and `count(*)` so the user can spot null-heavy columns.
- Floating-point medians via `percentile_cont` require a `::numeric`
  cast on integer columns.
- `TABLESAMPLE` is not seedable on stock Postgres; results vary between
  runs. Note this when reporting.
