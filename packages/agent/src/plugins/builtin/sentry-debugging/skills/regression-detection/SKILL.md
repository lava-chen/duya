# Regression Detection

Compare an issue's event volume before and after a deploy to flag
regressions. Use this skill when a deploy shipped and you need to
verify it didn't make things worse — or to confirm an issue is
genuinely fixed rather than just quiet.

## When to use

- A deploy just shipped and the user says "did this make things
  better or worse?".
- An issue's event count dropped and you need to confirm the fix
  is real, not just a low-traffic period.
- The user wants a regression report across the last N deploys.

## Process

1. Read the deploy list via `sentry.list_releases`. A release is
   the canonical deploy boundary in Sentry — pick the release the
   user asked about, or the most recent one.
2. For each issue that appeared or spiked in the release window:
   - Call `sentry.get_issue` to read the metadata, including
     `first_release`. An issue whose `first_release` matches the
     deploy is a candidate regression.
   - Compare the event count in the 24h before the deploy against
     the 24h after. Sentry's issue stats endpoint returns this
     when given a `statsPeriod`.
3. For each issue that was supposed to be fixed by the deploy:
   - Compare the event count before and after. A 100% drop is a
     clean fix; a partial drop is a partial fix; no change is a
     missed fix.
   - Read the latest event after the deploy to confirm it's the
     same signature, not a new issue that happens to share the
     title.
4. Classify each issue:
   - **New regression** — `first_release` matches the deploy,
     event count growing.
   - **Spiked regression** — `first_release` is older, but the
     event count jumped after the deploy.
   - **Resolved** — event count dropped to zero (or near-zero)
     after the deploy.
   - **Partial fix** — event count dropped but did not reach
     zero.
   - **Unchanged** — event count stable.
5. Report the classifications as a table. For each new regression,
   hand off to `stacktrace-analysis` for the root cause. For each
   partial fix, note what's still leaking.

## Tool call patterns

- `sentry.list_releases(organization, project)` returns releases
  newest-first. Each release has a `version`, `dateCreated`, and
  `dateReleased` — use the latter for the deploy boundary.
- `sentry.search_issues(query="first_release:<version>",
  statsPeriod="14d")` returns issues whose first event was in
  this release.
- For trend comparison, `sentry.get_issue` returns
  `stats.24h`, which is the event count in the last 24h. To
  compare before/after a deploy, fetch the issue at two points in
  time (before and after) and diff the stats — Sentry does not
  expose a direct before/after endpoint via the MCP.

## Confirmation boundary

All activity in this skill is `read` tier because it reads issue
stats and releases. Resolving or ignoring an issue based on the
report is `destructive` — confirm with the user first.

## Pitfalls

- A low-traffic period (weekend, holiday) can look like a fix.
  Always compare against the same day-of-week and time-of-day
  window if the deploy happened near a traffic boundary.
- A new release can mask an existing issue if the release changes
  the error signature (e.g. line numbers shift due to a refactor).
  Compare stacktrace signatures, not just issue titles, before
  declaring a fix.
- Sentry's `first_release` is set when the issue's first event
  carries that release tag. If the SDK is misconfigured and
  doesn't send the release tag, `first_release` is NULL — the
  issue won't show up in a `first_release:<version>` query.
- Deploys that ship simultaneously to multiple environments
  (production + staging) can produce double-counted events. Filter
  by `environment:production` before comparing.
- `sentry.list_releases` may include empty releases (CI built the
  artifact but never deployed). Cross-reference with the deploy
  tool (Vercel, Render, etc.) when available.
