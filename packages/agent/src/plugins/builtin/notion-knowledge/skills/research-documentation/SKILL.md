# Research Documentation

Turn a chat thread or research notes into a structured Notion doc.
This skill is the write path for research work — it composes a
hierarchy of headings, body paragraphs, callouts, and references
under a parent page the user names.

## When to use

- The user says "save this conversation as a Notion doc" / "write
  this up in Notion".
- A research thread in chat needs to be persisted for the team.
- The user wants a meeting or investigation thread summarized
  into a Notion page with a stable link.

## Process

1. Identify the source material. Confirm with the user which
   messages or notes should be included — do not assume the
   entire chat thread is the source.
2. Identify the target parent page. Either:
   - The user named one (a Notion page ID or URL) — verify it
     via `notion.get_page`.
   - Or ask the user to pick a parent — never create a top-level
     page without explicit confirmation.
3. Structure the document:
   - Title (one sentence, action-oriented for investigations:
     "Investigation: X failed because Y").
   - TL;DR callout (1–3 sentences, the answer up top).
   - Background section (the question and why it matters).
   - Findings section (one sub-heading per finding, with
     evidence).
   - Decisions section (only if decisions were made; otherwise
     omit).
   - Open questions section (only if any; otherwise omit).
   - References section (links to source pages, commits, PRs,
     external docs).
4. Draft the full block tree in chat before writing. Show the
   user the proposed title, parent, and section outline. After
   confirmation, call `notion.create_page(parent_id, properties,
   children)` with the full block list.
5. After the page is created, report the permalink back to chat
   so the user can jump to it.
6. Do not edit the parent page's properties — only its children.
   Editing the parent's properties is a different action and
   requires separate confirmation.

## Tool call patterns

- `notion.create_page(parent_id, properties, children)` creates
  the page in one call. The `children` array is the initial
  block tree; keep it under 100 blocks (Notion's per-call limit).
  For longer docs, create the page with the first 100 blocks,
  then call `notion.append_block_children(page_id, ...)` for the
  rest.
- `notion.append_block_children(page_id, blocks)` appends blocks
  to an existing page. Use it for incremental updates after the
  initial create.
- For block shapes, use the official Notion block types:
  `heading_1`, `heading_2`, `heading_3`, `paragraph`,
  `callout`, `bulleted_list_item`, `numbered_list_item`, `divider`,
  `bookmark`. Avoid custom block types unless the workspace uses
  them.

## Confirmation boundary

- Reading the source chat and any reference pages: `read` tier,
  automatic.
- Creating the new page: `write` tier, confirm. Always show the
  proposed title, parent, and section outline before the create
  call.
- Appending to an existing page (e.g. adding a new finding to a
  running investigation doc): `write` tier, confirm. Show the
  proposed appended block tree.
- Updating the page's properties (rename, retag): `write` tier,
  confirm.
- Archiving the page: `modify` tier, confirm.

## Pitfalls

- Notion's `children` array on `create_page` is capped at 100
  blocks. A long research doc will exceed this — split into a
  create + append sequence.
- The `paragraph` block's `rich_text` array is capped at 100
  items. A paragraph with many inline mentions / links will hit
  this limit. Split into multiple paragraphs.
- The page's `properties` must match the parent's schema when
  the parent is a database. A page parent accepts only the
  `title` property; a database parent requires every required
  property. Verify the parent type before constructing
  `properties`.
- Notion does not version blocks by default. An update to a
  block overwrites the previous content. Surface the diff to the
  user before updating — there is no undo.
- The permalink returned by `create_page` is the page's URL in
  the workspace. It is shareable with anyone who has workspace
  access; do not include sensitive content (PII, secrets) in the
  doc.
