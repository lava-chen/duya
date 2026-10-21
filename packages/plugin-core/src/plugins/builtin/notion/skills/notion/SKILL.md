---
name: notion
description: Use duya against a connected Notion workspace via the official Notion remote MCP endpoint. Search pages and databases, read Notion content, and create or update pages and records. Trigger on any mention of Notion, a Notion page/database link, or requests to search, read, summarize, or edit Notion content. Requires the Notion app connection to be authorized.
---

# Notion

Work with the user's connected Notion workspace. All operations go through the
official Notion remote MCP tools, which are exposed to the agent as
`remote_notion_*` (e.g. `remote_notion_search`, `remote_notion_fetch`,
`remote_notion_create_pages`, `remote_notion_update_page`). These tools only
appear when the Notion app connection is authorized.

## Duya capability binding

- The connector is the official Notion remote MCP endpoint
  (`https://mcp.notion.com/mcp`) managed by duya's app-connection system.
- Tools are named `remote_notion_<tool>` and are discoverable via `tool_catalog`.
- If no `remote_notion_*` tool is available, the Notion connection is not
  authorized — tell the user to connect Notion in the app connection settings.

## Connect first

If the `remote_notion_*` tools are absent, do not guess. Ask the user to
authorize the Notion connection (app connection settings → Notion → Connect),
then retry. Tools appear after the connection is established.

## Workflow

1. **Search first.** Use `remote_notion_search` with a single literal query to
   locate the target page or database. If multiple hits, ask the user which to
   use before proceeding.
2. **Read before edit.** Fetch the page or database with `remote_notion_fetch`
   before modifying, so you understand structure, existing content, and
   required properties. For database-backed pages, the fetch returns the data
   source id (`collection://...`) that create/update calls expect.
3. **Create or update.** Use `remote_notion_create_pages` with an explicit
   `parent` and a `pages` array; use `remote_notion_update_page` for edits (see
   guardrails for the command schema). For task databases, confirm the data
   source and required properties first.
4. **Verify.** After a write, fetch the page again to confirm the change landed
   correctly.

## Tool-call guardrails

- Notion tool availability can vary per workspace/token. If a tool call returns
  `Tool <name> not found`, treat that tool as unavailable for the rest of the
  task; use `remote_notion_search` and `remote_notion_fetch` where sufficient.
- Use one literal search query per search call and pass `filters: {}`
  explicitly when no narrower filter applies; run separate searches for
  alternate phrasings instead of combining them with `or` or `+` in one query.
- Only send Notion page/database/data-source URLs or IDs to fetch tools. Search
  can also surface external connected-source URLs — use those as context or
  citations, but do not feed them into fetch.
- Send explicit page/database IDs where the schema requires them; do not rely
  on the active/selected page.
- Edit page content via `remote_notion_update_page` with
  `command: "update_content"` and exact `old_str` / full-replacement `new_str`
  pairs. For property-only edits use `command: "update_properties"` with
  `content_updates: []`. The deployed schema expects both top-level fields even
  when one is unused; do not invent insertion-only commands.

## Output standards

- For search/fetch, return the page title, page id, and a concise summary of
  the relevant content.
- For writes, report what was created/updated and the resulting page id or URL.
- If the connection is unauthorized, name that exact gate and ask the user to
  connect Notion.
