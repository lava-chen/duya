# Meeting Knowledge Capture

Produce meeting notes with decisions, action items, and owners.
This skill consumes the meeting transcript or the user's bullet
notes and writes a structured Notion page that the team can act
on.

## When to use

- The user says "take notes for the meeting" / "write up the
  standup".
- A meeting just ended and the user pastes the transcript or
  raw notes into chat.
- The user wants the action items from a meeting pushed into a
  Notion database for tracking.

## Process

1. Identify the source material. Confirm with the user:
   - The meeting title, date, and attendees.
   - The source (transcript, raw notes, or chat thread).
   - The target Notion parent (a "Meeting Notes" database or a
     parent page).
2. Parse the source into the canonical meeting structure:
   - **Context** — meeting title, date, attendees, link to
     agenda.
   - **Summary** — 1–3 sentence TL;DR.
   - **Decisions** — bullets, each with the decision and who
     made it.
   - **Action items** — bullets, each with the owner, due date
     (if mentioned), and the action.
   - **Open questions** — bullets, things that need follow-up.
   - **References** — links to docs, PRs, tickets mentioned.
3. Identify owners explicitly. If an action item's owner is
   ambiguous ("someone should ..."), flag it and ask the user
   to assign before writing.
4. Identify due dates explicitly. If an action item has a due
   date, include it. If not, leave it unset — do not guess.
5. Draft the full page in chat before writing. Show the user
   the title, parent, and the action-items checklist. After
   confirmation, call `notion.create_page(parent_id,
   properties, children)`.
6. If the target is a database (e.g. "Meetings" with properties
   for date, attendees, status), fill the properties from the
   parsed metadata. If the target is a plain page parent, set
   only the title.
7. After the page is created, optionally push action items to
   a separate "Tasks" database via
   `notion.create_database_item(database_id, properties)`.
   Confirm with the user before doing this — pushing to a
   separate database is a second write.

## Tool call patterns

- `notion.create_page(parent_id, properties, children)` creates
  the meeting notes page. Use the `callout` block for the
  summary, `heading_2` for sections, `to_do` blocks for action
  items, `bulleted_list_item` for decisions and open questions.
- `notion.create_database_item(database_id, properties)`
  creates a row in a database. Use it to push action items to
  a separate "Tasks" database when the user wants the items
  tracked individually.
- For attendee mentions, use the `mention` rich text type with
  `user_id`. Notion resolves the mention to the user's display
  name; do not paste display names as plain text.

## Confirmation boundary

- Reading the source transcript or notes: `read` tier,
  automatic.
- Creating the meeting notes page: `write` tier, confirm. Show
  the proposed title, parent, and the action-items checklist
  before the create call.
- Pushing action items to a separate Tasks database: `write`
  tier, separate confirmation. The user may want the items in
  the notes page only, not in a tracking database.
- Updating an existing meeting notes page (e.g. adding a
  follow-up): `write` tier, confirm.
- Archiving a meeting notes page: `modify` tier, confirm.

## Pitfalls

- Meeting transcripts often contain off-topic chatter. Filter
  to the decisions and actions before writing — a verbatim
  transcript in Notion is rarely useful.
- Owners and due dates are easy to misattribute. Always surface
  the parsed action items in chat before writing — the user
  will catch a misattributed owner faster than the agent.
- The `to_do` block has a `checked` state. Create action items
  as `checked: false`; do not pre-check items the user hasn't
  done.
- Notion's user mentions require a `user_id`, which is only
  available via `notion.list_users` or the search result. Do
  not paste display names as plain text — the mention link is
  what makes the user get notified.
- A meeting notes page created under a database parent must
  fill the database's required properties. If the database
  requires a "Status" property, set it ("Draft" or "Ready");
  do not leave it unset.
- Action items pushed to a separate Tasks database should
  reference the meeting notes page (a relation property or a
  URL in the description). Without the back-link, the action
  item loses its context.
