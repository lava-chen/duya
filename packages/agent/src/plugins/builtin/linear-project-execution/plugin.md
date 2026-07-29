---
name: linear-project-execution
description: Linear issue triage, spec-to-issues, sprint planning, implementation status, and issue-to-code — read-heavy with strict gate on delete
version: 0.1.0
author: DUYA Team
---

# Linear Project Execution Plugin

End-to-end Linear project execution: triage the inbox, turn a spec
into issues, plan the sprint, track implementation status, and
hand an issue off to code. Bundles the official Linear MCP server
with five skills that codify how Duya drives Linear from chat.

_status: transitional — Linear offers an official hosted Remote MCP
endpoint at `https://mcp.linear.app/sse`. Until Plan 313 Phase 2a
lands the HTTP transport in `MCPServerConfig`, this plugin ships a
stdio fallback wrapping the Linear MCP adapter. It will migrate to
the hosted endpoint without breaking skills or workflows.

## What this plugin adds

- MCP server `linear` (stdio) — wraps the Linear MCP adapter so the
  agent can list teams, projects, cycles, and issues; read issue
  detail and comments; create and update issues; and post comments
  against a Linear workspace.
- Five skills:
  - `issue-triage` — triage the inbox: prioritize, label, assign,
    surface the next 1–3 issues to act on.
  - `spec-to-issues` — turn a spec into a structured set of Linear
    issues with labels, estimates, and dependencies.
  - `sprint-planning` — propose a cycle load based on team capacity
    and issue estimates.
  - `implementation-status` — read the current state of in-flight
    issues and surface blockers.
  - `issue-to-code` — read an issue, locate the code, implement,
    open a PR that closes the issue.
- Four workflow templates (YAML drafts, activated when Plan 311
  lands): generate-issues-from-spec, analyze-sprint-risks,
  complete-issue-and-pr, project-status-report.

## Authentication

The Linear MCP server requires a Linear personal API key with at
least the `read` scope; creating and updating issues requires the
`write` scope. The key is stored in the `linearApiKey` setup
field (secret). Prefer a key scoped to a single workspace over
an org-wide key. When the Remote MCP transport lands, the personal
key will be exchanged for an OAuth flow managed by Linear.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Listing
teams, projects, cycles, and issues; reading issue detail and
comments; and reading project status run automatically. Creating
or updating an issue is `write` tier — confirm with the user
before the first write, and always show the proposed issue title,
description, and labels. Posting a comment is `write` tier;
confirm. Archiving an issue is `modify` tier; confirm. Deleting
an issue is `destructive` tier, strong explicit confirmation —
Linear does not support undo on delete.

## When to suggest this plugin

Suggest when the user is triaging or planning a Linear project,
turning a spec into issues, or handing an issue off to code. Do
not suggest this plugin for general document writing (use the
Notion plugin) or for non-Linear project management.
