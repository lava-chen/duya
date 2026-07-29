# Database Maintenance

Keep a Notion database tidy: schema updates, dedup, archived-item
cleanup, and bulk property fixes. This skill is the maintenance
path for databases that accumulate drift over time.

## When to use

- The user says "clean up the tasks database" / "find duplicates
  in ..." / "the X database schema is out of date".
- A database has accumulated archived items that should be
  permanently trashed or moved.
- A property rename or type change needs to be applied across
  every row.

## Process

1. Identify the target database via `notion.list_databases` or
   `notion.search(filter=database)`. Read its schema via
   `notion.get_database(database_id)` — properties, types, and
   options for select/multi-select.
2. For schema updates:
   - Read the current schema. Identify the property to add,
     rename, or retype.
   - Draft the new schema in chat. Notion allows adding and
     renaming properties via `notion.update_database`, but
     re-typing a property (e.g. `text` → `select`) is
     destructive — the existing values may be lost. Surface
     this to the user before applying.
   - After confirmation, call `notion.update_database(database_id,
     properties)` with the new schema.
3. For dedup:
   - Query the database via `notion.query_database(database_id,
     filter, sorts)`. Sort by the property most likely to
     identify duplicates (usually `title`).
   - Iterate the result, grouping by the dedup key. For each
     group with more than one item, pick the canonical item
     (usually the most recently edited) and propose merging.
   - Surface the dup groups to the user before any write. Do
     not auto-merge — the user may want to keep both items
     with different parents.
4. For archived-item cleanup:
   - Query with `filter: { archived: true }`. Read the result.
   - For each archived item, propose either permanent delete
     (`destructive`) or restore (`modify`). Confirm with the
     user before applying either.
5. For bulk property fixes:
   - Query the rows that need the fix. Draft the new property
     value per row.
   - Surface the proposed updates as a table. After
     confirmation, apply via
     `notion.update_page_properties(page_id, properties)` per
     row. Batch in groups of 10 — Notion's API is rate-limited.

## Tool call patterns

- `notion.get_database(database_id)` returns the schema. Read
  the `properties` field for the property map; each property has
  a `type` and type-specific config (e.g. `select.options`).
- `notion.query_database(database_id, filter, sorts, page_size)`
  returns rows. Use a `page_size` of 100 (the max) for bulk
  operations; iterate via `start_cursor` for larger datasets.
- `notion.update_database(database_id, properties)` updates the
  schema. Adding a property is non-destructive; renaming is
  non-destructive; retyping is destructive — confirm before
  retyping.
- `notion.update_page_properties(page_id, properties)` updates a
  row's properties. Batch in groups of 10 to stay within
  Notion's rate limit.

## Confirmation boundary

- Reading the database schema and rows: `read` tier, automatic.
- Adding or renaming a property: `write` tier, confirm. Show
  the proposed schema diff.
- Retyping a property (potentially destructive): `destructive`
  tier, strong explicit confirmation. Surface the rows whose
  values will be lost.
- Bulk property fixes: `write` tier, confirm. Show the proposed
  updates as a table.
- Archiving a row: `modify` tier, confirm.
- Permanently deleting (trashing) a row: `destructive` tier,
  strong explicit confirmation. Surface the row count before
  applying.

## Pitfalls

- Notion's `query_database` paginates at 100 rows. A database
  with thousands of rows requires multiple `start_cursor`
  iterations — do not assume the first page is the full dataset.
- Retyping a property is destructive in Notion's API even when
  the values look compatible. A `text` → `select` retype loses
  values that don't match a select option; a `number` → `text`
  retype may preserve the value but lose type-specific sorts.
  Always confirm before retyping.
- The `archived` filter on `query_database` returns archived
  rows by default. To get only live rows, filter
  `archived: false` explicitly.
- Bulk updates are rate-limited (~3 requests/second on
  Notion's hosted API). A bulk fix across 1000 rows takes
  ~5 minutes; surface this to the user before starting.
- Database schema changes propagate to every view that uses the
  database. A property rename can break filters and sorts in
  saved views — surface this risk before renaming.
- Notion does not support undo on schema changes. A misapplied
  rename or retype is permanent; the only recovery is manual
  fix per row.
