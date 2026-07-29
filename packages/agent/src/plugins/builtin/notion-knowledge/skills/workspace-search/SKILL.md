# Workspace Search

Full-text search across the Notion workspace, scoped to the pages
the integration is shared with. This skill is the entry point for
every Notion investigation — `research-documentation`,
`meeting-knowledge-capture`, and `spec-to-task` all assume the
search returned the relevant pages.

## When to use

- The user says "what do we have on X in Notion?" / "search the
  workspace for ...".
- A downstream skill needs the relevant page IDs before it can
  read or update them.
- The user wants a quick "do we already have a doc on this?"
  check before creating a new page.

## Process

1. Confirm the integration's shared scope. Notion internal
   integrations only see pages explicitly shared with them —
   verify the user has shared the relevant top-level pages with
   the integration in Notion's share dialog. A search that
   returns zero results may be a scope issue, not a missing doc.
2. Call `notion.search(query, filter)` with a `filter` that
   matches the question:
   - `page` for content pages.
   - `database` for databases.
   - Leave unfiltered only when the user asked for "everything".
3. The search returns up to 100 results ranked by relevance. Read
   the top 5–10 results' titles and snippets. For each, call
   `notion.get_page(page_id)` to read the parent and properties
   when the snippet is ambiguous.
4. For content lookups, call `notion.get_block_children(page_id)`
   on the top result to confirm it actually contains the
   information the user asked about. Search snippets can be
   misleading — a page that mentions the query in a comment but
   not in the body is not a real match.
5. Report the matches as a list: title, parent page, last edited
   time, and a one-line relevance note. Surface the top 3–5;
   the rest are noise unless the user asks for them.

## Tool call patterns

- `notion.search(query, page_size)` is the canonical entry point.
  Use a small `page_size` (5–10) — the full payload per result
  is large and the agent rarely needs more than the top results.
- `notion.get_page(page_id)` returns the page's properties and
  parent. Use it after `search` narrowed the candidate, not
  instead of it.
- `notion.get_block_children(page_id)` returns the page's
  content blocks. Use it to confirm a match before reporting;
  do not paste raw block JSON — summarize the content.

## Confirmation boundary

All tools in this skill are `read` tier and run automatically. If
the user asks to update a found page, that is a `write` action —
confirm with the user before applying.

## Pitfalls

- Notion's search is case-insensitive but does not support
  wildcards or regex. A query like `"Sentry bug"` matches
  pages containing both words; a query like `Sentry*` does not
  work.
- Search results are scoped to the integration's shared pages. A
  page the user can see in Notion may not appear in search if it
  hasn't been shared with the integration. Always check the
  integration's share scope before declaring "no results".
- `notion.search` returns results in order of relevance, which
  weights recent edits heavily. An old but authoritative page may
  rank below a recently-edited but shallow page. Sort by
  `last_edited_time` when recency matters more than relevance.
- The `archived` flag on a page is true when the page is in the
  trash. `search` returns archived pages by default — filter
  them out unless the user explicitly asked for archived content.
- Database items (rows) appear in `search` results as pages with
  a `parent.database_id`. They are not databases themselves;
  don't try to query them as databases.
