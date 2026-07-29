# Stacktrace Analysis

Map a Sentry stacktrace to the project's source files, identify the
root cause, and propose a fix. This skill consumes the event
payload from `issue-investigation` and produces the code-level
diagnosis that `fix-and-verify` will act on.

## When to use

- The user says "this stacktrace points at X, what's actually
  wrong?" / "what line is causing the error?".
- `issue-investigation` produced an event payload and the next
  step is to read the code that the stacktrace points at.
- A stacktrace references a file/line that doesn't match the local
  checkout — usually a stale release mapping.

## Process

1. Read the event's stacktrace from the `issue-investigation`
   output. The `exception.values[0].stacktrace.frames` array is
   ordered outermost-first; the last frame is where the error
   originated.
2. Filter the frames to the project's own code. Drop frames from
   `node_modules/`, vendor directories, and framework internals
   unless they are the only frames. Mark these as "in-app" using
   Sentry's `in_app` flag when available.
3. For each in-app frame, read the file at the referenced line in
   the local checkout. If the file/line doesn't match (e.g. line
   is past EOF, or the file doesn't exist), the release mapping
   is stale — note it and fall back to the most recent version of
   the file.
4. Identify the root cause:
   - **Null deref / undefined access** — read the surrounding code
     to find where the value should have been set.
   - **Type error** — read the function signature and the call
     site; the call site is usually the bug, not the function.
   - **Network / external failure** — read the error handler; the
     unhandled case is usually the bug, not the network.
   - **Assertion / invariant** — read what the assertion was
     protecting and work backwards.
5. Propose a concrete fix in chat. Reference the file and line,
   explain what's wrong, and show the proposed diff. Do not apply
   the fix yet — hand off to `fix-and-verify` for the actual
   code change and PR.

## Tool call patterns

- `sentry.get_event(issue_id, event_id)` returns the full
  stacktrace. Cache the event payload in context — re-fetching is
  rate-limited.
- `sentry.listCommits(organization, project, version)` returns the
  commits in a release. Use it to map the stacktrace's release
  back to the exact commit hash when the local checkout diverges.
- For source file reads, use the workspace file tools, not the
  Sentry MCP. Sentry's `get_event` returns source snippets but
  they may be stale relative to the local checkout.

## Confirmation boundary

All activity in this skill is `read` tier — it reads Sentry events
and local source. The proposed fix in chat is `draft` tier
(automatic). Applying the fix is `fix-and-verify`'s
responsibility and follows its `write` / `modify` confirmation
rules.

## Pitfalls

- Sentry's `filename` field may be an absolute path from the
  build machine (`/home/runner/work/...`). Map it to the project's
  relative path by stripping the build prefix; never assume the
  absolute path exists locally.
- Minified production builds produce useless stacktraces. If the
  frames point at `bundle.js:1:12345`, ask the user to upload
  source maps to Sentry — the analysis cannot proceed without
  them.
- The top frame is not always the bug. An error thrown deep in a
  utility may be triggered by a bad call site higher up the
  stack. Read the full in-app call chain before proposing a fix.
- `sentry.listSuspects` returns Sentry's heuristic for likely
  culprit commits. Use it as a hint, not as ground truth — verify
  by reading the actual diff of the suggested commit.
- A regression across a deploy often shows the same stacktrace
  with a different `release` tag. Cross-reference the release
  commits to find the change that introduced the bug.
