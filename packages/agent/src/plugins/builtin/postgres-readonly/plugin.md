---
name: postgres-readonly
description: Read-only PostgreSQL inspection, safe query, and data analysis with defense-in-depth policy
version: 0.1.0
author: DUYA Team
---

# PostgreSQL Read-only Plugin

Provides schema inspection, safe read-only querying, and lightweight
data analysis over a local PostgreSQL connection. Designed as the
reference scaffold for first-party plugin packages (Plan 313 Phase 0)
and hardened as the production read-only plugin in Phase 3: it
exercises the subdirectory `skills/<name>/SKILL.md` layout, the
`mcp/servers.json` file, and the `permissions/policy.json`
"default read" policy.

## What this plugin adds

- MCP server `postgres-readonly` (stdio) — wraps
  `@modelcontextprotocol/server-postgres` with the `--read-only`
  flag enabled. The server blocks INSERT/UPDATE/DELETE at the
  server boundary; the connection string is injected through the
  `connectionString` setup field.
- Three skills:
  - `schema-inspection` — enumerate databases, tables, columns,
    and indexes without writing anything.
  - `safe-query` — run SELECT queries with explicit read-only
    guards and a checklist of SELECT-adjacent statements that are
    not actually read.
  - `data-analysis` — summarize result sets, compute
    distributions, and surface anomalies for inspection.

## Default safety posture (defense-in-depth)

Read-only is enforced at three layers, all of them mandatory:

1. **MCP server boundary** — the `--read-only` flag on
   `@modelcontextprotocol/server-postgres` blocks write statements
   at the server. Even a tool call that bypasses the agent's
   permission tier cannot mutate data through this server.
2. **Permission policy** — `permissions/policy.json` sets
   `defaultMode: "read"` and pins every write-capable action
   (`query.insert`, `query.update`, `query.delete`, `table.drop`,
   `table.truncate`, `schema.alter`) to the `destructive` tier.
   The agent must confirm before even attempting a write, and the
   confirmation is the strong explicit kind. Unlisted actions are
   bumped one tier above the conservative default per the design
   doc §6.
3. **Recommended Postgres role** — the connection string should
   point at a role whose grants are read-only
   (`GRANT SELECT ON ALL TABLES IN SCHEMA public TO <role>`).
   Even a server bypass and a policy bypass cannot mutate data
   the role cannot write.

All three layers are intentional defense-in-depth. Any one of
them failing should not compromise read-only safety.

## Connection string setup

The `connectionString` setup field is treated as a secret. It is
stored in the system keychain (Plan 83's secret handling), never
logged, and never exposed to the renderer process.

Recommended setup:

1. Create a dedicated Postgres role for the agent:
   ```sql
   CREATE ROLE duya_reader LOGIN PASSWORD '<strong-secret>';
   GRANT CONNECT ON DATABASE <db> TO duya_reader;
   GRANT USAGE ON SCHEMA public TO duya_reader;
   GRANT SELECT ON ALL TABLES IN SCHEMA public TO duya_reader;
   ALTER DEFAULT PRIVILEGES IN SCHEMA public
     GRANT SELECT ON TABLES TO duya_reader;
   ```
2. Build the connection string with that role:
   `postgresql://duya_reader:<strong-secret>@<host>:5432/<db>?sslmode=require`
3. Paste the connection string into the `connectionString` setup
   field. The MCP server picks it up via the `DATABASE_URL` env
   var.

Never use a superuser or write-capable role for this plugin.
The MCP `--read-only` flag and the policy enforcement are
defense-in-depth — the role's grants are the actual boundary.

## When to suggest this plugin

Suggest when the user needs to inspect a PostgreSQL database,
validate a schema, or answer questions about table contents
without modifying data. Do not suggest this plugin for Supabase
projects (use the `supabase-development` plugin, which has
Supabase-aware migration and Edge Function workflows) or for
write-heavy database work (the policy will require confirmation
on every write, which is the intended safety posture but not a
good interactive workflow).
