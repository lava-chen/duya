# Implementation Status

Read the current state of in-flight Linear issues and surface
blockers. This skill is the daily-standup and weekly-status path
— it answers "where are we?" without writing anything.

## When to use

- The user says "what's the status of the project?" / "what's
  blocking us?".
- A daily or weekly status report needs to be generated from the
  current Linear state.
- The user wants to verify the cycle is on track before a
  milestone review.

## Process

1. Identify the target scope. Either:
   - A specific project — read it via `linear.get_project`.
   - The current cycle — read it via `linear.get_cycle`.
   - The team's in-flight work — `linear.list_issues(state=
     "started")`.
2. For each in-flight issue, read:
   - State (`Started`, `In Review`, `In Progress`).
   - Assignee.
   - Estimate.
   - Last update time and the last comment.
   - Linked PRs (if the issue body or comments reference a PR
     URL).
3. Classify each issue:
   - **On track** — `In Progress` with recent activity (last
     update < 2 days ago).
   - **Stale** — `In Progress` with no activity for > 3 days.
   - **Blocked** — has a `blocked_by` relation, or the last
     comment explicitly says "blocked".
   - **In review** — `In Review` state.
   - **Done** — `Done` state in the cycle window.
4. Aggregate the status:
   - Count of issues per state.
   - Sum of estimates per state.
   - List of blockers (with the blocking issue).
   - List of stale issues (with the last update time).
5. Surface the report as:
   - Top-level summary (cycle or project name, completion %,
     days remaining if a cycle).
   - Per-state breakdown (count + estimate sum).
   - Blockers section (each blocker + the blocking issue).
   - Stale issues section (each stale issue + last update).
   - One-sentence health call ("on track", "at risk", "behind").

## Tool call patterns

- `linear.list_issues(team_id, state="started", cycle_id,
  limit=100)` returns the in-flight set. Use a high limit; a
  cycle can have 50+ issues.
- `linear.get_issue(issue_id)` returns the full issue detail
  including `blocked_by` relations. Use it for the issues flagged
  as blocked.
- `linear.list_comments(issue_id)` returns the comments. Read
  the most recent 2–3 to detect "blocked" mentions; do not
  ingest the entire comment history.
- For linked PRs, parse the issue description and comments for
  GitHub URLs. The Linear MCP does not return a structured
  `linked_prs` field; use the GitHub Development plugin to
  verify the PR state.

## Confirmation boundary

All activity in this skill is `read` tier because it reads
issues, comments, and project state. Updating issue state based
on the report is `write` — confirm with the user first.

## Pitfalls

- Linear's `state` field is per-team and customizable. A team
  may have a `Blocked` state instead of using `blocked_by`
  relations; read the team's workflow before assuming the state
  names.
- A `Done` state does not mean the PR is merged. The developer
  may have marked the issue done before the PR landed; cross-
  reference with the GitHub Development plugin for a true
  completion signal.
- Linear's `updatedAt` field updates on any change, including
  label edits and re-assigns. A stale `updatedAt` is a strong
  signal, but a recent `updatedAt` does not guarantee progress
  on the actual work.
- Cross-project dependencies (project A's milestone blocked by
  project B's issue) are not visible in a single
  `list_issues(project_id=A)` call. Surface cross-project
  dependencies when known; do not assume the project is
  self-contained.
- A high `estimate` sum in `In Progress` does not mean high
  throughput. A single 13-point issue in `In Progress` for a
  week is a stale item, not a productive cycle. Always pair the
  estimate sum with the staleness check.
- The "health call" is a judgment, not a metric. Surface the
  underlying numbers (completion %, blocker count, stale count)
  so the user can validate the call.
