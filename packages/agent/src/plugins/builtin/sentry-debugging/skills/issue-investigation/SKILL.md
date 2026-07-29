# Issue Investigation

Find the highest-impact Sentry issue, read its metadata and recent
events, and surface the user-visible impact. This skill is the entry
point for every Sentry debugging session — `stacktrace-analysis`,
`regression-detection`, and `fix-and-verify` all assume the issue
context is already in the conversation.

## When to use

- The user says "what's going on in production?" / "look at the
  latest Sentry error".
- An alert fired (Slack, email, PagerDuty) and you need to triage
  the corresponding Sentry issue.
- The user wants a weekly digest of the top issues by event count
  or affected user count.

## Process

1. Call `sentry.list_projects` to confirm the project inventory.
   If the user pointed at a specific project, narrow to it;
   otherwise the investigation runs at the org level.
2. Call `sentry.search_issues` with a sort that matches the
   question:
   - `freq` for "most events in the last 24h".
   - `user_count` for "most users affected".
   - `last_seen` for "most recent".
   Set `statsPeriod` to the window the user asked about (default
   `24h`).
3. Take the top 1–3 issues. For each, call `sentry.get_issue` to
   read the metadata: title, culprit, first seen, last seen, event
   count, user count, status, assigned team.
4. For the top issue, call `sentry.list_issue_events(issue_id,
   limit=5)` and read the most recent event. Pay attention to:
   - Tags (`environment`, `release`, `os`, `browser`).
   - Breadcrumbs (the action sequence leading to the error).
   - The `request` block (URL, method, headers — without
     secrets).
5. Summarize the investigation: the issue title, the user-visible
   impact, the most likely trigger based on breadcrumbs, and the
   tags that distinguish failing from healthy sessions. Hand off
   to `stacktrace-analysis` for the code-level root cause.

## Tool call patterns

- `sentry.search_issues(query, sort, statsPeriod)` is the canonical
  entry point. Use a structured query like
  `is:unresolved level:error environment:production` rather than a
  free-text match.
- `sentry.list_issue_events(issue_id, limit)` returns events
  newest-first. Read 3–5 events to distinguish the persistent
  signature from noise.
- `sentry.get_event(issue_id, event_id)` returns the full event
  payload, including the stacktrace and breadcrumbs. Use this only
  on the events that match the dominant signature — full payloads
  are large.

## Confirmation boundary

All tools in this skill are `read` tier and run automatically. If
the user asks to assign the issue or post a comment, that is a
`write` action — confirm before applying.

## Pitfalls

- Sentry's `statsPeriod` uses relative time (`24h`, `14d`, `30d`).
  A timestamp-based filter requires a `statsPeriod` that covers
  it; do not pass absolute timestamps directly.
- The same error can be tracked as multiple issues if the
  stacktrace varies (e.g. different line numbers across releases).
  Always check `first_release` and `last_release` before assuming
  an issue is new.
- `sentry.search_issues` returns issues across the org by default.
  Filter to a specific project when the user named one — otherwise
  the top issues may come from an unrelated service.
- Breadcrumbs can contain user input. Do not paste raw breadcrumbs
  into chat summaries — redact obvious PII (email, phone, token
  prefixes) before reporting.
