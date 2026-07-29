# Issue Triage

Triage the Linear inbox: prioritize, label, assign, and surface the
next 1–3 issues to act on. This skill is the entry point for every
Linear session — `spec-to-issues`, `sprint-planning`, and
`issue-to-code` all assume the inbox has been triaged.

## When to use

- The user says "what should I work on?" / "triage the inbox".
- A new batch of issues came in (e.g. after a release) and the
  user wants the top priorities surfaced.
- The user wants to clear the un-labeled, un-assignable backlog
  before sprint planning.

## Process

1. Call `linear.list_teams` to confirm the team inventory. If the
   user pointed at a specific team, narrow to it; otherwise
   triage runs at the user's default team.
2. Call `linear.list_issues(team_id, state="backlog",
   assignee="unassigned", limit=20)`. Read the title, description
   summary, and created-at for each. Sort by created-at ascending
   (oldest first) — the oldest un-triaged issues are the most
   stale.
3. For each issue, propose a triage action:
   - **Prioritize** — the issue is high-impact; set priority to
     `Urgent` or `High`.
   - **Label** — the issue maps to a known label (`bug`,
     `feature`, `infra`, etc.).
   - **Assign** — the issue maps to a known team member; propose
     the assignee.
   - **Estimate** — the issue is well-scoped enough to estimate
     (Linear uses the Fibonacci-ish T-shirt scale: `1, 2, 3, 5,
     8, 13, 21`).
   - **Defer** — the issue is real but not now; move to a
     `Later` cycle or leave in backlog with a `deferred` label.
   - **Close as duplicate** — the issue duplicates an existing
     one; link the duplicate and close.
   - **Close as wontfix** — the issue is out of scope; close
     with a comment.
4. Surface the top 5–10 triage actions in chat. For each, show
   the issue title, the proposed action, and the rationale.
5. After the user confirms, apply the actions via the appropriate
   `linear.set_issue_*` or `linear.update_issue` calls. Batch
   the writes; confirm before the first write.
6. Surface the next 1–3 issues to act on — these are the
   prioritized, assigned, estimated issues ready for
   `issue-to-code`.

## Tool call patterns

- `linear.list_issues(team_id, state, assignee, limit)` is the
  canonical triage query. Use `state="backlog"` and
  `assignee="unassigned"` for the inbox; use `state="started"`
  for in-flight work.
- `linear.list_labels(team_id)` returns the team's labels. Map
  each issue to a label by reading the title and description;
  do not invent new labels without confirmation.
- `linear.update_issue(issue_id, priority, labels, assignee,
  estimate)` applies the triage action in one call. Batch the
  writes — one call per issue is fine, but confirm the proposed
  actions in chat before applying any.

## Confirmation boundary

- Reading teams, issues, and labels: `read` tier, automatic.
- Applying triage actions (priority, labels, assignee, estimate):
  `write` tier, confirm. Show the proposed actions in chat
  before applying.
- Closing an issue as duplicate or wontfix: `write` tier,
  confirm. Show the proposed closing comment.
- Archiving an issue: `modify` tier, confirm.
- Deleting an issue: `destructive` tier, strong explicit
  confirmation. Prefer archive over delete — Linear's archive is
  recoverable, delete is not.

## Pitfalls

- Linear's `priority` field is `0` (no priority) by default. The
  numeric scale (`1=Urgent`, `2=High`, `3=Medium`, `4=Low`) is
  reversed from intuition — confirm the mapping before setting.
- The same issue can be in multiple projects. `list_issues` with
  a `project_id` filter narrows the scope; without it, the query
  returns every issue in the team, including cross-project ones.
- Linear's `estimate` field uses a team-specific scale. Some
  teams use Fibonacci (`1, 2, 3, 5, 8`); others use T-shirt
  (`XS, S, M, L, XL`). Read the team's settings before estimating.
- Closing as duplicate requires the duplicate's issue ID. Search
  for it via `linear.search_issues` before proposing the close —
  a vague "this is a duplicate" without a link is not actionable.
- A triage action that changes the assignee can notify the new
  assignee. Do not reassign without confirmation — the user may
  be triaging on someone else's behalf.
