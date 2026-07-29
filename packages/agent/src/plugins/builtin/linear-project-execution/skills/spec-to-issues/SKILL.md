# Spec to Issues

Turn a spec into a structured set of Linear issues with labels,
estimates, and dependencies. This skill is the hand-off from
"we wrote a spec" to "we can track work" — it reads a spec from
chat (or from Notion via the Notion plugin) and creates one
Linear issue per shippable unit.

## When to use

- The user says "create Linear issues from this spec" / "break
  this spec into issues".
- A spec doc was just approved and the team wants to start
  tracking implementation work.
- The user wants to migrate an existing plan into Linear.

## Process

1. Identify the source spec. Either:
   - A pasted spec in chat — confirm with the user which
     messages are the spec.
   - A Notion page — use the Notion plugin to read it.
2. Identify the target team and project. Either:
   - The user named them — verify via `linear.list_teams` and
     `linear.list_projects`.
   - Or ask the user — never create issues in the wrong team's
     inbox.
3. Parse the spec into issues. Each issue should be:
   - **Small enough to ship in one PR** — if a section is
     "Implement authentication", break it into "Set up auth
     callback", "Add session middleware", "Wire login UI".
   - **Named with an action verb** — "Add", "Update", "Fix",
     "Remove", not "Authentication" or "Auth stuff".
   - **Estimated** — assign a rough estimate based on the
     section's complexity. Surface the estimate as a proposal;
     the user can adjust.
   - **Labeled** — apply the team's existing labels (`backend`,
     `frontend`, `infra`, etc.). Do not invent new labels.
4. Identify dependencies between issues. If issue B depends on
   issue A, note it — Linear supports issue relations
   (`blocks` / `blocked_by`).
5. Surface the parsed issue list in chat before writing. Show
   the title, description, estimate, labels, and dependencies
   for each issue. After confirmation, create each issue via
   `linear.create_issue(team_id, project_id, title, description,
   labels, estimate)`.
6. After the issues are created, wire dependencies via
   `linear.update_issue(issue_id, blocked_by=[issue_id_a, ...])`.
   Confirm with the user before this second write.
7. Report the count of issues created and a link to the project
   view filtered to the new issues.

## Tool call patterns

- `linear.list_teams` + `linear.list_projects(team_id)` returns
  the team and project inventory. Verify the target before
  creating issues.
- `linear.list_labels(team_id)` returns the team's labels. Map
  spec sections to labels by topic; do not invent new labels
  without confirmation.
- `linear.create_issue(team_id, project_id, title, description,
  labels, estimate)` creates one issue. The response includes
  the issue ID and URL — capture both for the dependency wiring
  and the report.
- `linear.update_issue(issue_id, blocked_by=[...])` wires
  dependencies. Call this after all issues are created so the
  IDs are known.

## Confirmation boundary

- Reading the spec and the team/project/label inventory: `read`
  tier, automatic.
- Creating issues: `write` tier, confirm. Show the parsed issue
  list in chat before the create call.
- Wiring dependencies: `write` tier, confirm. Show the proposed
  dependency edges as a list.
- Updating issues after creation (e.g. to add an assignee):
  `write` tier, confirm.
- Archiving or deleting an issue created by mistake: `modify` /
  `destructive` tier, confirm.

## Pitfalls

- Spec docs often have implicit issues — a section like
  "Authentication" implies several issues but doesn't enumerate
  them. Break these down explicitly; do not create one giant
  issue per spec heading.
- Linear's `estimate` field uses a team-specific scale. Read the
  team's settings before estimating; an estimate of `8` in a
  Fibonacci team is "a couple days", in a T-shirt team it might
  be invalid.
- Linear issues are visible to the entire team by default. Do
  not include sensitive content (PII, secrets, internal
  identifiers) in the issue description.
- Linear's `blocks` / `blocked_by` relations are directional.
  `A blocked_by B` means A cannot start until B is done. Get the
  direction right — a reversed relation hides the actual
  dependency.
- The team's project may have a `default_cycle` set. Issues
  created without an explicit cycle land in the team's backlog,
  not the active cycle. Confirm where the new issues should land
  before creating.
- A spec that names owners should map them to Linear user IDs via
  `linear.get_user` or `linear.list_teams` with members. Do not
  paste display names as plain text — the assignee field requires
  the user ID.
