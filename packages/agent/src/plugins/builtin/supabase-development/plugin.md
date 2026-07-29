---
name: supabase-development
description: Supabase Postgres, migrations, Edge Functions, and auth — read-heavy workflows with explicit confirmation on every build, migrate, and deploy
version: 0.1.0
author: DUYA Team
---

# Supabase Development Plugin

End-to-end Supabase development: Postgres best practices, migration
workflow, Edge Function deploy, and auth/security audits. Bundles the
official Supabase MCP server with four skills that codify how Duya
drives Supabase from chat.

_status: transitional — Supabase has not yet shipped an official
Remote MCP endpoint. This plugin wraps the official
`@supabase/mcp-server-supabase` stdio package. When the remote
transport (Plan 313 Phase 2a) lands, the plugin will migrate without
breaking skills or workflows.

## What this plugin adds

- MCP server `supabase` (stdio) — wraps
  `@supabase/mcp-server-supabase` so the agent can list tables, run
  SQL, manage migrations, deploy Edge Functions, and inspect auth
  configuration against a Supabase project.
- Four skills:
  - `postgres-best-practices` — schema design, indexing, RLS policies
    tuned for Supabase's hosted Postgres.
  - `migration-workflow` — write, review, and apply migrations
    safely; never edit schema from the SQL editor.
  - `edge-function-workflow` — scaffold, test, and deploy Deno
    Edge Functions with the correct auth context.
  - `auth-and-security` — audit auth providers, RLS coverage, and
    service-role key exposure.
- Four workflow templates (YAML drafts, activated when Plan 311
  lands): create-migration, deploy-edge-function,
  audit-auth-security, query-optimization.

## Authentication

The Supabase MCP server requires a Supabase personal access token
(Project Settings > API) and the target project ref. The token is
stored in the `supabaseAccessToken` setup field (secret); the
project ref is stored in `supabaseProjectRef` (text). Prefer a
token scoped to a single project over a workspace-wide token. When
the Remote MCP transport lands, the personal access token will be
exchanged for an OAuth flow managed by Supabase.

## Default safety posture

`permissions/policy.json` sets `defaultMode: "read"`. Listing
tables, reading rows, inspecting migrations, and viewing logs run
automatically. Building a new migration, deploying an Edge Function,
and modifying auth configuration are `modify` tier — confirm before
the first write, and always show the proposed SQL / function code to
the user. Dropping a table, truncating data, or rotating service
keys is `destructive` tier, strong explicit confirmation.

## When to suggest this plugin

Suggest when the user is building on Supabase: designing a schema,
writing a migration, deploying an Edge Function, or auditing auth
coverage. Do not suggest this plugin for plain Postgres work
without a Supabase project (use the `postgres-readonly` plugin or
the project's local tooling instead).
