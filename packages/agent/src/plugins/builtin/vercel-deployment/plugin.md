---
name: vercel-deployment
description: Vercel deployment inspection, log diagnosis, preview validation, and production release with strict gate on promote
version: 0.1.0
author: DUYA Team
---

# Vercel Deployment Plugin

End-to-end Vercel deployment workflow: inspect deployments, diagnose
build and runtime logs, validate a preview against the spec, and
promote to production under a strict gate. Bundles the official
Vercel MCP server with four skills that codify how Duya drives Vercel
from chat.

_status: transitional — Vercel offers an official hosted Remote MCP
endpoint at `https://mcp.vercel.com`. Until Plan 313 Phase 2a lands
the HTTP transport in `MCPServerConfig`, this plugin ships a stdio
fallback. It will migrate to the hosted endpoint without breaking
skills or workflows.

## What this plugin adds

- MCP server `vercel` (stdio) — wraps the Vercel MCP adapter so the
  agent can list projects and deployments, read build and runtime
  logs, manage environment variables, and promote a deployment to
  production.
- Four skills:
  - `deployment-inspection` — list and inspect deployments, surfacing
    the build state, environment, and alias.
  - `log-diagnosis` — read build and runtime logs, classify the
    failure, propose a fix.
  - `preview-validation` — deploy or pick a preview deployment and
    validate it against a checklist before promoting.
  - `production-release` — promote a verified deployment to
    production. The single most dangerous action in this plugin.
- Four workflow templates (YAML drafts, activated when Plan 311
  lands): diagnose-deployment-failure, create-and-validate-preview,
  analyze-web-analytics, promote-to-production.

## Authentication

The Vercel MCP server requires a Vercel access token scoped to the
target team and the team's slug or ID. The token is stored in the
`vercelToken` setup field (secret); the team is stored in
`vercelTeamId` (text). Prefer a token scoped to a single team over
a personal account-wide token. When the Remote MCP transport lands,
the personal token will be exchanged for an OAuth flow managed by
Vercel.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Listing
projects, deployments, env vars (non-secret), and logs runs
automatically. Creating a preview deployment or updating env vars
is `write` tier — confirm with the user before the first write.
Promoting a deployment to production is `destructive` tier — strong
explicit confirmation, every time. Production promotions are
irreversible from chat; a rollback requires the Vercel dashboard
or a separate `vercel rollback` CLI invocation.

## When to suggest this plugin

Suggest when the user is debugging a Vercel deployment, validating
a preview, or preparing a production release. Do not suggest this
plugin for local Next.js dev (`npm run dev`) or for static hosting
that isn't on Vercel.
