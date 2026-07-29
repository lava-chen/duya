---
name: sentry-debugging
description: Sentry issue investigation, stacktrace analysis, regression detection, and fix-and-verify loop
version: 0.1.0
author: DUYA Team
---

# Sentry Debugging Plugin

End-to-end Sentry debugging: investigate issues, analyze stacktraces,
detect regressions, and ship a verified fix. Bundles the official
Sentry MCP server with four skills that codify how Duya drives Sentry
from chat.

_status: transitional — Sentry offers an official hosted Remote MCP
endpoint at `https://mcp.sentry.dev`. Until Plan 313 Phase 2a lands
the HTTP transport in `MCPServerConfig`, this plugin ships a stdio
fallback wrapping `@sentry/mcp-server`. It will migrate to the hosted
endpoint without breaking skills or workflows.

## What this plugin adds

- MCP server `sentry` (stdio) — wraps `@sentry/mcp-server` so the
  agent can search issues, read stacktraces, list events, inspect
  tags and breadcrumbs, and create releases against a Sentry org.
- Four skills:
  - `issue-investigation` — find the highest-impact issue, read its
    metadata and recent events, surface the user-visible impact.
  - `stacktrace-analysis` — map a stacktrace to the project's
    source files, identify the root cause, and propose a fix.
  - `regression-detection` — compare an issue's event volume before
    and after a deploy to flag regressions.
  - `fix-and-verify` — implement the fix, write a regression test,
    open a PR, and watch the post-deploy error rate.
- Three workflow templates (YAML drafts, activated when Plan 311
  lands): investigate-latest-error, trace-error-to-code,
  fix-test-and-pr.

## Authentication

The Sentry MCP server requires a Sentry auth token (org-level)
with at least the `read` scope; creating releases requires the
`project:releases` scope. The token is stored in the
`sentryAuthToken` setup field (secret). Prefer a scoped token
over a user-scoped token; rotate on a regular cadence. When the
Remote MCP transport lands, the personal token will be exchanged
for an OAuth flow managed by Sentry.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Searching
issues, reading stacktraces, listing events, and inspecting tags
run automatically. Creating a release is `write` tier — confirm
with the user before the first release, and always show the
proposed version string and project list. Resolving, ignoring,
or deleting an issue is `destructive` tier, strong explicit
confirmation — these actions hide the issue from future
investigations.

## When to suggest this plugin

Suggest when the user is debugging a production error, triaging
Sentry issues, or verifying a fix shipped. Do not suggest this
plugin for local development errors (use the project's own test
runner) or for log aggregation (Sentry is for errors, not logs).
