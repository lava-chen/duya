# Fix and Verify

Implement the fix for a Sentry issue, write a regression test, open
a PR, and watch the post-deploy error rate. This skill is the
write path for Sentry debugging — every other skill is read-only.

## When to use

- The user says "fix this Sentry issue" / "ship a fix for #N and
  verify".
- `stacktrace-analysis` produced a concrete fix proposal and the
  user wants it landed.
- A regression was detected and you need to revert or patch.

## Process

1. Read the diagnosis from `stacktrace-analysis`. Confirm the
   target file, line, and proposed diff are in context.
2. Implement the fix in the workspace. Keep the diff minimal — a
   fix that touches unrelated code is harder to review and harder
   to revert if it makes things worse.
3. Write a regression test that:
   - Reproduces the original failure (the test fails on the
     pre-fix code).
   - Passes on the post-fix code.
   - Is named after the Sentry issue (e.g.
     `test_issue_12345_null_user_payload`) so future maintainers
     can trace it back.
4. Run the test locally. Run the project's typecheck and lint.
   Surface any failures in chat before opening a PR.
5. Open a PR with the GitHub Development plugin
   (`github-development`). The PR body must:
   - Reference the Sentry issue (`Fixes SENTRY-<short-id>` or the
     issue URL).
   - Summarize the root cause in one sentence.
   - List the test added and how it reproduces the original
     failure.
6. After merge and deploy, run the `regression-detection` skill to
   confirm the issue's event count dropped. Do not resolve the
   Sentry issue manually until the regression check confirms it —
   an early "resolve" hides the issue if the fix didn't actually
   work.

## Tool call patterns

- Use the workspace file edit tools for the fix and the test.
- Use the GitHub Development plugin (`pull_requests.create`) to
  open the PR. Do not push directly to `main`.
- After deploy, use `sentry.get_issue` to read the post-deploy
  stats. Compare with the pre-deploy stats from
  `regression-detection`.

## Confirmation boundary

- Reading Sentry context and the local codebase: `read` tier,
  automatic.
- Writing the fix and the test: `write` tier, confirm with the
  user before the first write. Show the proposed diff.
- Opening the PR: `write` tier, confirm. Show the PR title and
  body before submitting.
- Resolving or ignoring the Sentry issue: `destructive` tier,
  strong explicit confirmation. Always wait for the post-deploy
  regression check before resolving — a premature "resolve" hides
  a regression.

## Pitfalls

- A fix that adds a try/catch around the failing code is not a
  fix — it's a suppression. The Sentry issue will close but the
  user-visible bug remains. Always fix the root cause; suppress
  only when the user explicitly asks for a hotfix.
- A test that mocks the Sentry SDK is testing the mock, not the
  fix. The regression test must reproduce the original failure
  mode, not just assert the new code path is reached.
- After a fix ships, Sentry may continue to receive events from
  old clients (mobile apps, long-lived browser sessions). Wait
  for the event count to drop meaningfully (typically 24h) before
  resolving.
- A "fix" that resolves the issue on `production` but not on
  `staging` (or vice versa) is a partial fix. Check every
  environment the issue was seen in.
- Do not delete the Sentry issue after resolving. Resolved issues
  are the audit trail — deleting them removes the history needed
  to detect future regressions of the same signature.
