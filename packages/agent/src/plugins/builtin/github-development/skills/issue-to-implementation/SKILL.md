# Issue to Implementation

Turn a GitHub Issue into a working pull request: read the issue,
locate the relevant code, implement the change, and open a PR. This
is the canonical end-to-end skill for "fix issue #N" requests.

## When to use

- The user says "implement issue #42" or "fix the bug described in
  issue #N".
- A follow-up to `repository-exploration` once the layout is known.
- The issue body references code locations you can map to the repo.

## Process

1. Call `issues.get` on the issue number. Read the body, labels, and
   linked PRs carefully — duplicates are common.
2. Run the `repository-exploration` skill if you have not already
   built a layout map in this session.
3. Locate the code that needs to change. Use
   `repos.get_file_contents` to read the candidates; do not guess from
   file names alone.
4. Implement the change locally in the workspace (via the file edit
   tools). Keep the diff minimal and focused on the issue scope.
5. Create a branch with `repos.create_branch` from the default branch
   HEAD. Do not push directly to `main`.
6. Push the commits with `repos.create_or_update_file` (single file)
   or the workspace push flow (multiple files). Use a conventional
   commit message matching the repo's style — read recent
   `repos.list_commits` to learn it.
7. Open a PR with `pull_requests.create`. The PR body must:
   - Reference the issue (`Closes #N`).
   - Summarize what changed and why.
   - Call out anything the reviewer should test manually.

## Tool call patterns

- Use `repos.list_commits` to find the default branch HEAD SHA before
  branching.
- `repos.create_or_update_file` requires the file's current SHA for
  updates; fetch it first with `repos.get_file_contents`.
- For multi-file changes, prefer the workspace git push flow over
  sequential `create_or_update_file` calls — the latter creates one
  commit per file and pollutes history.

## Confirmation boundary

- Reading the issue, code, and commits: `read` tier, automatic.
- Creating a branch and pushing commits: `modify` tier, confirm
  with the user before the first push.
- Opening the PR: `write` tier, confirm. Show the PR title and body
  to the user before submitting.

## Pitfalls

- Issue bodies often contain stale code references. Verify against the
  current `main`, not the issue's date.
- If the issue has a linked PR already, link to it instead of opening
  a duplicate. Read `issues.list` with the issue number filter.
- Do not push secrets, env files, or large binaries. Run
  `npm run typecheck:all` (or the repo equivalent) before opening the
  PR — AGENTS.md mandates this for Duya and most repos mirror the rule.
