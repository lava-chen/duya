# Sprint Planning

Propose a cycle (sprint) load based on team capacity and issue
estimates. This skill is the pre-planning step before the team
commits to a cycle — it surfaces over-commitment and under-load
before the cycle starts.

## When to use

- The user says "plan the next sprint" / "what should we load
  into cycle N?".
- A cycle just ended and the next one needs to be loaded.
- The user wants to check whether the proposed cycle load is
  realistic given the team's capacity.

## Process

1. Identify the target cycle. Either:
   - The user named one — read it via `linear.get_cycle`.
   - Or pick the next upcoming cycle via
     `linear.list_cycles(team_id, status="upcoming", limit=1)`.
2. Compute team capacity:
   - Read the team's members via `linear.list_teams` with
     members. For each member, ask the user for their capacity
     in the cycle (Linear does not track capacity natively).
   - If the user has not provided capacity, assume each member
     contributes `~5` estimate points per week (a common
     starting point for Fibonacci-scale teams). Surface this
     assumption explicitly.
3. Read the candidate issues:
   - `linear.list_issues(team_id, state="backlog", priority<=2,
     limit=50)` — high-priority backlog items.
   - `linear.list_issues(team_id, state="started",
     cycle="current")` — issues that rolled over from the
     previous cycle.
4. Compute the proposed load:
   - Sum the estimates of the candidate issues.
   - Compare against the team capacity.
   - If the sum exceeds capacity, drop the lowest-priority
     items until it fits.
   - If the sum is below capacity, surface the gap and suggest
     pulling more from the backlog.
5. Surface the proposed load in chat:
   - Per-issue: title, estimate, assignee (if set), priority.
   - Total: estimate sum, team capacity, delta.
   - Risks: unestimated issues, unassigned high-priority items,
     dependencies that block start.
6. After the user confirms (or adjusts), apply via
   `linear.update_issue(issue_id, cycle_id=<target_cycle>)` per
   issue. Batch the writes.

## Tool call patterns

- `linear.list_cycles(team_id, status, limit)` returns cycles.
  Pick the next upcoming cycle as the target.
- `linear.list_issues(team_id, state, priority, cycle, limit)`
  returns the candidate set. Filter by priority and state to
  avoid pulling in low-priority or already-done items.
- `linear.update_issue(issue_id, cycle_id)` moves an issue into
  the cycle. Batch the writes — one call per issue is fine, but
  confirm the proposed load before applying any.

## Confirmation boundary

- Reading cycles, issues, and team members: `read` tier,
  automatic.
- Moving issues into the cycle: `write` tier, confirm. Show the
  proposed load (per-issue list + total + delta) before
  applying.
- Updating an issue's estimate or assignee during planning:
  `write` tier, confirm.
- Archiving or deleting an issue during planning: `modify` /
  `destructive` tier, confirm.

## Pitfalls

- Linear's `priority` field is `0` (no priority) by default and
  the numeric scale is reversed (`1=Urgent`, `4=Low`). A filter
  `priority<=2` keeps Urgent + High; verify the direction before
  relying on the filter.
- Linear's `estimate` field is per-team and optional. Issues
  without an estimate count as `0` in the load sum but consume
  real capacity. Always surface unestimated issues in the report.
- A cycle's `startsAt` and `endsAt` are fixed once the cycle is
  created. A load proposal that exceeds capacity cannot be solved
  by extending the cycle — the only options are to drop items or
  add capacity (more members, more time per member).
- Cross-team dependencies (team A's issue blocked by team B's
  issue) are not visible in `linear.list_issues(team_id=A)`.
  Surface cross-team dependencies when known; do not assume the
  cycle is self-contained.
- Rollover issues (started in a previous cycle, not done) consume
  the current cycle's capacity if moved into the new cycle. Always
  surface the rollover count and estimate sum separately from the
  new load.
- A member's capacity can change mid-cycle (PTO, reassignment,
  incident response). The plan is a snapshot; surface this so the
  user knows to revisit if circumstances change.
