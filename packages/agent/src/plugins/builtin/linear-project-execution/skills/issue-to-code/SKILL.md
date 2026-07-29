# Issue to Code

Read a Linear issue, locate the relevant code, implement the
change, and open a PR that closes the issue. This skill is the
canonical end-to-end path for "implement issue X" — it composes
`repository-exploration` and `issue-to-implementation` from the
GitHub Development plugin with the Linear read/write tools.

## When to use

- The user says "implement Linear issue X" / "fix the bug
  described in LIN-123".
- A follow-up to `issue-triage` once the issue is prioritized and
  assigned.
- The issue body references code locations you can map to the
  repo.

## Process

1. Call `linear.get_issue(issue_id)` to read the issue. Read the
   title, description, labels, and linked PRs carefully —
   duplicates are common.
2. Run the GitHub Development plugin's `repository-exploration`
   skill if you have not already built a layout map in this
   session.
3. Locate the code that needs to change. Use
   `repos.get_file_contents` to read the candidates; do not guess
   from file names alone.
4. Implement the change locally in the workspace (via the file
   edit tools). Keep the diff minimal and focused on the issue
   scope.
5. Create a branch with `repos.create_branch` from the default
   branch HEAD. Do not push directly to `main`.
6. Push the commits with `repos.create_or_update_file` (single
   file) or the workspace push flow (multiple files). Use a
   conventional commit message matching the repo's style.
7. Open a PR with `pull_requests.create` via the GitHub
   Development plugin. The PR body must:
   - Reference the Linear issue (`Closes LIN-123` or the issue
     URL — Linear auto-links the PR to the issue when the
     identifier is in the PR body).
   - Summarize what changed and why.
   - Call out anything the reviewer should test manually.
8. After the PR is open, post a comment on the Linear issue via
   `linear.create_comment(issue_id, body=<PR url + summary>)`
   so the issue thread has the link. Confirm with the user before
   posting — this is a `write` action.
9. Optionally, move the Linear issue to `In Review` state via
   `linear.set_issue_status(issue_id, "In Review")`. Confirm
   with the user before applying.

## Tool call patterns

- `linear.get_issue(issue_id)` returns the issue detail. The
  `description` is markdown; the `labels` are objects with
  `name` and `color`.
- For code reads and edits, use the GitHub Development plugin's
  tools (`repos.get_file_contents`, `repos.create_or_update_file`,
  `pull_requests.create`). Do not duplicate them here.
- `linear.create_comment(issue_id, body)` posts a comment. The
  body is markdown; include the PR URL and a one-line summary so
  the issue thread is self-contained.
- `linear.set_issue_status(issue_id, state)` updates the state.
  The state name is team-specific (`In Review` vs `In Review ❏`
  etc.); read the team's workflow before setting.

## Confirmation boundary

- Reading the Linear issue, the GitHub repo, and the codebase:
  `read` tier, automatic.
- Creating a branch and pushing commits: `modify` tier, confirm
  with the user before the first push. Show the diff.
- Opening the PR: `write` tier, confirm. Show the PR title and
  body to the user before submitting.
- Posting a comment on the Linear issue: `write` tier, confirm.
  Show the proposed comment body.
- Moving the issue to `In Review`: `write` tier, confirm. Show
  the proposed state change.
- Closing the Linear issue automatically when the PR merges:
  leave to the Linear-GitHub integration. Do not close the issue
  manually before the PR merges — that hides the issue from the
  active cycle.

## Pitfalls

- Linear issue identifiers (`LIN-123`) are unique within a team
  but not globally. A `linear.get_issue` call with the wrong
  team's identifier may return a different issue. Always verify
  the team in the response.
- The issue body may reference code locations that have moved
  since the issue was filed. Verify against the current `main`,
  not the issue's date.
- If the issue has a linked PR already, link to it instead of
  opening a duplicate. Read `linear.list_comments(issue_id)` to
  find existing PR references.
- Linear's auto-link from PR body (`Closes LIN-123`) requires the
  Linear-GitHub integration to be configured for the repo. If
  the integration is not configured, the PR will merge without
  closing the issue — surface this so the user can close it
  manually.
- Do not push secrets, env files, or large binaries. Run
  `npm run typecheck:all` (or the repo equivalent) before
  opening the PR — AGENTS.md mandates this for Duya and most
  repos mirror the rule.
- A "fix" that just disables a failing test is not a fix.
  Reference the issue body for the actual user-visible bug and
  fix the root cause.
