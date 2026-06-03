# Phase 5: MCP Source-of-Truth Unification

> **Status**: Audit Complete — Locking the source-of-truth decision for MCP
> **Created**: 2026-06-03
> **Scope**: Documents the authoritative data source for MCP server configuration. No source code in this document.

---

## 1. Problem Statement

MCP server configuration is currently scattered across multiple data sources. The CLI cannot give a stable answer to "which MCP servers exist and what are their configs" because each source may report a different view.

### 1.1 Confirmed Data Sources (from `electron/agents/mcp/collect-main.ts` audit)

| Source | Location | Owner | Stable ID |
|--------|----------|-------|-----------|
| **Bundled** | `packages/agent/bundle/literature-mcp-server.js` | App | `bundled:literature` |
| **Plugin manifest** | `<plugin.installPath>/plugin.json` `capabilities.mcpServers[]` | Plugin | `plugin:<pluginId>:<serverName>` |
| **Legacy on-disk settings** | `<userData>/settings.json` `mcpServers[]` | User (legacy) | `legacy:<filename>:<serverName>` |
| **Agent settings DB** | `getAgentSettings().mcpServers[]` | User | `settings:<serverName>` |
| **Settings KV** | `getJsonSetting('mcpServers', [])` | User | `kv:<serverName>` |

### 1.2 Real Failure Mode (if not unified)

- A user disables an MCP server in one storage location
- The same server is still listed in another storage location
- CLI shows the server as "available" (from one source) but the agent runtime fails to start it (from another source)
- GUI shows it in two places, neither authoritative

---

## 2. Locked Precedence (v0 Source of Truth)

After unification, the **authoritative** MCP server list is the **union** of all sources, with the following precedence for **conflict resolution** (same name appears in multiple sources):

```
1. Agent settings DB (settings:<name>)        — user's runtime override
2. Settings KV (kv:<name>)                    — user's recent config
3. Plugin manifest (plugin:<id>:<name>)       — installed plugin-declared
4. Legacy on-disk (legacy:<name>)             — legacy user config (preserved for migration)
5. Bundled (bundled:<name>)                   — app-supplied default
```

**Higher precedence wins** on the SAME name. Lower-precedence duplicates are **shadowed** and not exposed by the CLI v0.

---

## 3. Stable Public ID Strategy (v0)

Each MCP server is identified by its authoritative source + name:

| Source | Public ID format | Example |
|--------|------------------|---------|
| Agent settings | `settings:<name>` | `settings:filesystem` |
| Settings KV | `kv:<name>` | `kv:github` |
| Plugin manifest | `plugin:<pluginId>:<name>` | `plugin:com.duya.literature:literature` |
| Legacy on-disk | `legacy:<name>` | `legacy:my-custom-mcp` |
| Bundled | `bundled:<name>` | `bundled:literature` |

Same approach as Phase 3 skill IDs (`source:owner:name`). Plugin IDs are stable because they come from `PluginManager`; bundled IDs are stable because they are app-versioned.

### 3.1 Conflict Resolution Rule

If two sources report a server with the same `name` (e.g. both plugin and user settings define `literature`):
- The higher-precedence source's `name` is the public id
- Shadowed candidates do NOT appear in the CLI v0 DTO
- `duya mcp info <shadowed_id>` returns `mcp_not_found` (404)

### 3.2 Why This Rule

- User's most recent settings are the most authoritative runtime intent
- Plugin manifest is the install-time contract; settings override
- Legacy on-disk is preserved but deprecated
- Bundled is the absolute fallback

---

## 4. Frozen JSON DTO (v0)

### 4.1 `duya mcp list`
```json
{
  "id": "plugin:com.duya.literature:literature",
  "name": "literature",
  "source": "plugin | settings | kv | legacy | bundled",
  "sourceId": "<pluginId> if source=plugin, else omitted",
  "enabled": true,
  "connected": false
}
```

Fields:
- `id` — frozen public identifier
- `name` — directory / server name (for display)
- `source` — provenance
- `sourceId` — present only when `source = plugin`
- `enabled` — whether the candidate is enabled
- `connected` — runtime connection status (currently always `false` in v0; populated when agent runtime reports)

### 4.2 `duya mcp info <id>`
```json
{
  "id": "plugin:com.duya.literature:literature",
  "name": "literature",
  "source": "plugin",
  "sourceId": "com.duya.literature",
  "enabled": true,
  "connected": false,
  "command": "node",
  "args": ["...redacted..."],
  "env": {}
}
```

Additional fields:
- `command` — executable name (e.g. `node`, `python`)
- `args` — CLI args (truncated / redacted of secrets in v0)
- `env` — env var keys (values redacted in v0)

### 4.3 Fields NOT in v0 DTO

- `connection` details (host, port, socket path) — defer
- `lastError`, `lastConnected` — defer to status endpoint (future)
- raw `settings.json` paths — never
- API keys / tokens in `env` values — NEVER
- absolute filesystem paths — never

---

## 5. `connected` Field — v0 Limitation

`connected` is a snapshot of the last-known connection state from the agent runtime. In v0, the CLI does not actively probe connection state — it reads the cached value from the main process.

- `true` if the agent runtime reported successful connection
- `false` otherwise (disconnected, not yet connected, error)

`duya doctor` will be the source of truth for runtime health; `duya mcp list` is a static snapshot.

---

## 6. CLI Service Implementation Plan

### 6.1 Domain Reader

Create `packages/agent/src/mcp/mcpService.ts` (mirrors `skillService.ts`):

```typescript
export interface MCPCandidate {
  name: string;
  source: 'bundled' | 'plugin' | 'settings' | 'kv' | 'legacy';
  pluginId?: string;
  command: string;
  args: string[];
  env: Record<string, string>;
  enabled: boolean;
}

export function listMCPDTOs(args: ServiceListArgs): MCPListItem[];
export function getMCPInfoDTO(args: { id: string } & ServiceListArgs): MCPInfoItem | null;
```

Reads from the unified collector (`collect-main.ts`) and applies the precedence rules.

### 6.2 CLI API Server Endpoints

```
GET /v1/mcps         — list (uses mcpService)
GET /v1/mcps/:id     — info
```

### 6.3 CLI Commands

```
duya mcp list            — calls /v1/mcps
duya mcp info <id>       — calls /v1/mcps/:id
duya mcp list --format json
duya mcp info <id> --format json
```

The legacy `mcpCmds.ts` placeholder is NOT deleted (per Decision 5.1, legacy execution CLI is preserved as-is); new commands are added alongside.

---

## 7. Agent Runtime MCP Wiring (companion task)

**Separate task from this doc.** To make duya agent actually USE MCP tools, `duyaAgent` initialization must:
- Read the unified MCP candidates
- Connect to each enabled one
- Register the resulting `Tool[]` into `ToolRegistry`

The wiring is in `packages/agent/src/index.ts` line 1277 (`mcpClients: []` is the broken hardcode).

This is a runtime behavior change and is **out of scope** for the Phase 6 CLI surface. It is a follow-up task to be done after the CLI surface is verified.

---

## 8. Stop Conditions

Phase 6 (CLI MCP read-only) is blocked until:
1. ✅ This document is approved (Phase 5 audit)
2. `mcpService.ts` is implemented and unit-tested
3. `/v1/mcps` endpoints are wired
4. CLI commands work via the harness
5. No new typecheck errors

Phase 5 itself is **not** implemented by code in this document — it is the audit and rules. The actual unification code already exists in `collect-main.ts`; this document formalizes the precedence.

---

*This document is the system of record for MCP source-of-truth. Implementation is Phase 6.*