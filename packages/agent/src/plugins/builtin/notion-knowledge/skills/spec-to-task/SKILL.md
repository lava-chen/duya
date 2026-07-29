# Spec to Task

Turn a spec doc into a database of tasks. This skill is the
hand-off from "we wrote a spec" to "we can track work" — it reads
a spec from Notion (or from chat) and creates a row per task in
the project's Tasks database.

## When to use

- The user says "turn this spec into tasks" / "create Linear
  issues from this" (Notion flavor; for Linear, use the Linear
  plugin).
- A spec doc was just approved and the team wants to start
  tracking implementation work.
- The user wants to migrate an existing plan into a Notion
  Tasks database.

## Process

1. Identify the source spec. Either:
   - A Notion page (URL or ID) — read it via
     `notion.get_page` and `notion.get_block_children`.
   - A pasted spec in chat — confirm with the user which
     messages are the spec.
2. Identify the target Tasks database. Either:
   - The user named one — verify via `notion.get_database`.
   - Or ask the user to pick one — never create a new database
     without explicit confirmation.
3. Read the database's schema via `notion.get_database`. Map
   the spec's structure to the database's properties:
   - Spec heading → task `Title`.
   - Spec sub-heading → task `Description` (or a separate
     `Details` property).
   - Spec section owner → task `Assignee` (if mentioned).
   - Spec section phase → task `Status` (if the database uses a
     status property).
   - Spec section dependencies → task `Blocked by` (if a
     relation property exists).
4. Parse the spec into a task list. Each task should be:
   - **Small enough to ship in one PR** — if a section is
     "Implement authentication", break it into "Set up auth
     callback", "Add session middleware", "Wire login UI".
   - **Named with an action verb** — "Add", "Update", "Fix",
     "Remove", not "Authentication" or "Auth stuff".
   - **Owned** — if the spec names an owner, include it; if not,
     leave the assignee unset and flag it.
5. Surface the parsed task list in chat before writing. Show
   the title, assignee, status, and dependencies for each task.
   After confirmation, create each task via
   `notion.create_database_item(database_id, properties)`.
   Batch in groups of 10 to respect Notion's rate limit.
6. After the tasks are created, report the count and a link to
   the database view filtered to the new tasks.

## Tool call patterns

- `notion.get_page(page_id)` + `notion.get_block_children(page_id)`
  reads the spec from Notion. Iterate the block tree depth-first;
  headings map to task titles, body paragraphs map to descriptions.
- `notion.get_database(database_id)` reads the target schema.
  Identify the property names and types before constructing the
  `properties` payload — a mismatch (e.g. assigning a string to a
  `person` property) fails the create.
- `notion.create_database_item(database_id, properties)` creates
  one task. Batch in groups of 10; Notion's API rate-limits at
  ~3 requests/second.
- For dependencies between tasks, use a `relation` property if
  the schema has one. After creating all tasks, update each
  task's `Blocked by` relation with the page IDs of its
  dependencies (a second pass).

## Confirmation boundary

- Reading the spec and the database schema: `read` tier,
  automatic.
- Creating tasks: `write` tier, confirm. Show the parsed task
  list in chat before the create call.
- Updating tasks after creation (e.g. to wire dependencies):
  `write` tier, confirm. Show the proposed relation updates.
- Archiving or deleting tasks: `modify` / `destructive` tier,
  confirm.

## Pitfalls

- Spec docs often have implicit tasks — a section like
  "Authentication" implies several tasks but doesn't enumerate
  them. Break these down explicitly; do not create one giant
  task per spec heading.
- The Tasks database's schema may not match the spec's shape.
  A spec with "Owner: Alice" can't assign a task if the database
  has no `Assignee` property — surface the gap and ask the user
  whether to add the property or skip the assignment.
- Notion's `relation` property requires the related database to
  be the same database (self-relation) or a separately configured
  related database. Verify the relation exists before trying to
  wire dependencies.
- A task list created without owners is rarely actionable.
  Always flag unassigned tasks in the report; do not silently
  leave them unassigned.
- The order of task creation matters for relation wiring. Create
  dependencies first, then dependents, so the relation can be
  set on the dependent's create call. Otherwise a second pass is
  needed.
- Pastable spec content (code blocks, blockquotes) does not
  translate cleanly to Notion's `rich_text`. Strip formatting
  that doesn't fit (`text` with `code: true` is fine; nested
  blockquotes are not).
