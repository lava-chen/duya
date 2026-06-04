# Plan 102: Merge `duya_config` into `duya_cli` — Single Control-Plane Entry

> **Status**: ✅ Complete (2026-06-04)
> **Created**: 2026-06-04
> **Depends on**: Plan [99](./99-cli-split-and-control-plane.md) (CLI split + control plane), Plan [98](./98-cli-channel-cron-message.md) (descriptor registry), Plan [96](./96-duya-cli-tool.md) (CLI tool itself)
> **Supersedes**: Plan 96 Phase 8's "duya_config for write / duya_cli for read" carve-out (the file header comment at `packages/agent/src/tool/DuyaConfigTool/DuyaConfigTool.ts:8-10` already calls this a transitional state)
> **Binding design contract**: [`docs/design-docs/cli-control-plane/roadmap.md`](../../design-docs/cli-control-plane/roadmap.md) (frozen DTOs, exit codes, audit rules, write-op rules)

---

## 0. Goal

Make the agent's "configure the desktop" surface **a single entry point** — `duya_cli` — instead of the current two-tool split:

- `duya_config` (writes only) — `packages/agent/src/tool/DuyaConfigTool/DuyaConfigTool.ts`
- `duya_cli` (read + CLI surface) — `packages/agent/src/tool/DuyaCliTool/DuyaCliTool.ts`

This means the `duya_config` tool **is deleted**, and every action it currently handles is exposed as a `duya config …` subcommand reached through the same descriptor-driven dispatcher that Plan 99 put in place.

The split is a v0 historical accident: `duya_config` was hard-wired to `configDb` (Electron IPC) because that was the path of least resistance at the time, and the file header explicitly says read actions that overlapped with the CLI control plane were removed "in Phase 8 of plan 96; use `duya_cli` for those." The Plan 99 refactor — splitting `packages/cli` from `@duya/agent` and routing both the agent tool and the external `duya` wrapper through the same `buildControlPlaneClient()` dispatcher — is the structural enabler that makes the merge correct: there is no longer a transport asymmetry forcing the two tools apart.

After this plan, the agent's mental model becomes "everything that touches the desktop is `duya_cli`", which matches the comment in `DuyaCliTool.ts:4-8` that calls it "the single agent-side entry point to the DUYA CLI control plane."

---

## 1. Current state

### 1.1 `duya_config` action surface (must be preserved 1:1)

From `packages/agent/src/tool/DuyaConfigTool/DuyaConfigTool.ts:11-28`:

| Action | Inputs | Backend | Write? |
|---|---|---|---|
| `provider_add` | `id, name, providerType, baseUrl?, apiKey?, isActive?` | `configDb.providerUpsert` | yes |
| `provider_remove` | `id` | `configDb.providerDelete` | yes |
| `provider_activate` | `id` | `configDb.providerActivate` | yes |
| `settings_get` | — | `configDb.agentGetSettings` | no (read — left in by oversight, must move to `duya_cli` get form) |
| `settings_set` | patch from {`model, maxTokens, temperature, topP, topK, enableThinking, thinkingBudget`} | `configDb.agentSetSettings` | yes |
| `vision_get` | — | `configDb.visionGet` | no (read — same as above) |
| `vision_set` | patch from {`provider, model, baseUrl, apiKey, isActive→enabled`} | `configDb.visionSet` | yes |
| `style_get` | — | `configDb.outputStylesGet` | no (read) |
| `style_set` | `styleId` | `configDb.outputStylesSet` | yes |
| `pairing_list` | — | `configDb.pairingListPending` + `pairingListApproved` | no (read) |
| `pairing_approve` | `platform, code` | `configDb.pairingApprove` | yes |
| `pairing_revoke` | `platform, platformUserId` | `configDb.pairingRevoke` | yes |
| `pairing_is_approved` | `platform, platformUserId` | `configDb.pairingIsApproved` | no (read) |
| `mcp_server_add` | `serverName, mcpCommand, mcpArgs?, mcpEnv?, agentIds?` | read `mcpServers` from `agentGetSettings`, push, write back | yes |
| `mcp_server_remove` | `serverName` | read, filter, write back | yes |
| `mcp_server_assign` | `serverName, agentIds?` | read, patch `allowedAgentIds`, write back | yes |

The reads that survived the Phase 8 carve-out (`settings_get`, `vision_get`, `style_get`, `pairing_list`, `pairing_is_approved`) are leftover oversights: the file comment says they should not be in `duya_config`, but no one moved them. **Phase 4 of this plan moves them all into `duya_cli` get-style commands** alongside the new write commands.

### 1.2 Transport asymmetry (the structural reason for the split)

`duya_config` reaches the desktop via `configDb` — a thin IPC client wrapper that calls `electron/db/queries/configDb.ts` handlers. Each action is a discrete function:

- `providerUpsert`, `providerDelete`, `providerActivate`
- `agentGetSettings`, `agentSetSettings`
- `visionGet`, `visionSet`
- `outputStylesGet`, `outputStylesSet`
- `pairingListPending`, `pairingListApproved`, `pairingApprove`, `pairingRevoke`, `pairingIsApproved`

`duya_cli` reaches the desktop via `buildControlPlaneClient()` (HTTP over 127.0.0.1, or in-process when bundled in the main process). The Plan 99 dispatcher is `ControlPlaneDispatcher.request<T>()` returning `{ status, body }` typed values.

To merge, **the `configDb` IPC handlers must become Electron HTTP routes** that the `duya` CLI bundle can also reach, just like the existing `electron/cli/handlers/{providers,skills,plugins,mcps,sessions,channels,crons,messages,install,status,doctor}.ts` handlers do. Then `duya_config`'s `configDb` calls become `client.request('POST', '/v1/config/providers', body)` etc. — same dispatcher, same DTO discipline.

The `electron/db/queries/configDb.ts` module itself **stays** — the HTTP handlers call into it. The only thing that changes is the call path: agent → `duya_cli` → HTTP → `electron/cli/handlers/config.ts` → `configDb.ts` → SQLite.

### 1.3 Why now

Three reasons this is the right time:

1. **Plan 99 Phases 0–9 are complete.** The dispatcher abstraction, the descriptor-driven request building, the route table, and the `buildAgentRunner` contract are all in place. Adding a new command family is mechanical.
2. **`mcp_server_add` is already a "settings patch"** — `DuyaConfigTool.ts:250-294` reads `agentGetSettings().mcpServers`, mutates, and writes back. This is the same shape `duya_cli mcp add/remove/assign` will use, but routed through a proper HTTP contract with audit logging (Plan 98 §audit rules apply).
3. **The `vision_set` `isActive → enabled` field rename** in `DuyaConfigTool.ts:204` is GUI legacy. The CLI surface gets to use `enabled` consistently from day one.

---

## 2. Target architecture

```
┌────────────────────────────────────────────────────────────────────┐
│                       DUYA Desktop (Electron)                      │
│                                                                    │
│  Main Process                                                      │
│  ┌──────────────────────────────┐  ┌────────────────────────────┐  │
│  │ electron/cli/                │  │ electron/db/queries/       │  │
│  │  cli-api-server.ts           │  │  configDb.ts               │  │
│  │  handlers/                   │◀─│   (providerUpsert,         │  │
│  │   config.ts ← NEW            │  │    agentGetSettings, …)    │  │
│  │   {providers,plugins,skills, │  └────────────────────────────┘  │
│  │    mcps,sessions,channels,   │                                  │
│  │    crons,messages,install,   │  ┌────────────────────────────┐  │
│  │    status,doctor}            │  │ electron/services/         │  │
│  └──────────────┬───────────────┘  │  controlPlaneAudit.ts      │  │
│                 │                  └────────────────────────────┘  │
│  ┌──────────────▼─────────────────────────────────────────────┐   │
│  │ @duya/agent  (Agent process, in-process embed)             │   │
│  │                                                             │   │
│  │  tool/DuyaCliTool ── buildControlPlaneClient() ─────────────┼─┐ │
│  │  tool/registry                                             │ │ │
│  │  tool/builtin                                              │ │ │
│  └─────────────────────────────────────────────────────────────┘ │ │
└──────────────────────────────────────────────────────────────────┘
                                                                │
                       ┌────────────────────────────────────────┘
                       │ in-process IPC when bundled in main
                       │ HTTP over 127.0.0.1 when in subprocess
                       ▼
        ┌──────────────────────────────────────────┐
        │ ControlPlaneClient (Plan 99)             │
        │  - request(method, path, body)           │
        │  - typed body, no stream capture         │
        └────┬──────────────────────────┬───────────┘
             │                          │
   ┌─────────▼────────┐    ┌─────────────▼─────────┐
   │ packages/cli     │    │ @duya/agent           │
   │ (duya wrapper)   │    │ (REPL/--print/etc.)   │
   │  duya config …   │    │  tool/DuyaCliTool     │
   │  duya mcp …      │    │   (the only one)     │
   │  duya provider … │    │                       │
   └──────────────────┘    └───────────────────────┘
```

**Hard rule (carries over from Plan 99 §2)**: nothing in `packages/cli` may import from `@duya/agent` runtime modules. The `duya` wrapper is a thin argv → HTTP layer; the agent is a consumer of the same client.

**New hard rule**: the agent exposes **one** configuration tool to the LLM — `duya_cli`. The `duya_config` tool is deleted in Phase 4.

---

## 3. The `duya config` subcommand tree

`duya config` is a new top-level command in the CLI control plane, with the following structure. Each subcommand has a backing `GET`/`POST`/`PATCH`/`DELETE` route in `electron/cli/handlers/config.ts`.

```
duya config
├── provider
│   ├── list                         GET    /v1/config/providers
│   ├── info   <id>                  GET    /v1/config/providers/:id
│   ├── add    --id --name --type    POST   /v1/config/providers
│   │           [--base-url]
│   │           [--api-key]
│   │           [--active]
│   ├── remove <id>                  DELETE /v1/config/providers/:id
│   └── activate <id>                POST   /v1/config/providers/:id/activate
│
├── settings
│   ├── show                         GET    /v1/config/settings/agent
│   └── set   [--model]              PATCH  /v1/config/settings/agent
│           [--max-tokens]
│           [--temperature]
│           [--top-p]
│           [--top-k]
│           [--enable-thinking]
│           [--thinking-budget]
│
├── vision
│   ├── show                         GET    /v1/config/settings/vision
│   └── set   [--provider]           PATCH  /v1/config/settings/vision
│           [--model]
│           [--base-url]
│           [--api-key]
│           [--enabled]
│
├── style
│   ├── list                         GET    /v1/config/output-styles
│   └── set   <styleId>              POST   /v1/config/output-styles   { styleId }
│
└── pairing
    ├── list                         GET    /v1/config/pairing
    ├── approve  --platform --code   POST   /v1/config/pairing/approve { platform, code }
    ├── revoke   --platform --user   POST   /v1/config/pairing/revoke  { platform, platformUserId }
    └── check    --platform --user   GET    /v1/config/pairing/check?platform=&user=
```

`duya mcp` keeps its existing subcommand tree (Plan 99 already has `list / info`), but Phase 3 adds `add / remove / assign` mirroring what `duya_config mcp_server_*` does today:

```
duya mcp
├── list / info  (existing)
├── add    --server --command        POST   /v1/mcps
│         [--arg …] [--env KEY=VAL]
│         [--agent a,b,c]
├── remove <name>                    DELETE /v1/mcps/:name
└── assign  --server --agent a,b,c   PATCH  /v1/mcps/:name            { allowedAgentIds }
```

(Exact `duya mcp` write surface is owned by Plan 99 §"Phase 7 write operations"; this plan only **moves** the impl, it does not invent the contract.)

---

## 4. Phases

| Phase | Scope | Status |
|---|---|---|
| 0 | Inventory & frozen-path audit (this doc) | ✅ |
| 1 | Add `config` to `CLI_DESCRIPTORS` + argv parser accepts all new flags | ✅ |
| 2 | Add `electron/cli/handlers/config.ts` + register routes in `cli-api-server.ts` | ✅ |
| 3 | Implement each handler delegating to `configDb.ts`; map field renames (`isActive → enabled` for vision); keep DTO discipline | ✅ |
| 4 | Move `mcp_server_add / remove / assign` write surface into `duya mcp` (per Plan 99) | ✅ |
| 5 | Delete `packages/agent/src/tool/DuyaConfigTool/`; remove from `tool/builtin.ts`; rewrite `prompts/sections/intro.ts` + all `tool/builtin.ts` references to use `duya_cli` only | ✅ |
| 6 | Audit log: every `config.*` write goes through `controlPlaneAudit.ts` with `kind: 'config.{action}'` and `X-Duya-Invoked-By: agent-tool:{sessionId}` | ✅ |
| 7 | Tests: descriptor coverage, handler unit tests, route-coverage test, end-to-end agent tool test | ✅ |
| 8 | Update `docs/ARCHITECTURE.md` + design doc; mark plan complete | ✅ |

---

## 5. Phase details

### 5.1 Phase 1 — descriptors

In `packages/cli/src/program/descriptors.ts`, add a `config` command descriptor matching the tree in §3:

```ts
{
  name: 'config',
  description: 'Read and modify DUYA desktop configuration (providers, agent settings, vision, output style, pairing).',
  subcommands: {
    provider: { name: 'provider', description: '…', subcommands: { list, info, add, remove, activate } },
    settings: { name: 'settings', description: '…', subcommands: { show, set } },
    vision:   { name: 'vision',   description: '…', subcommands: { show, set } },
    style:    { name: 'style',    description: '…', subcommands: { list, set } },
    pairing:  { name: 'pairing',  description: '…', subcommands: { list, approve, revoke, check } },
  },
}
```

Each subcommand has `options` (e.g. `--id`, `--name`, `--type`) and `write: boolean` flag (Plan 99 §5.1 — used by the `runPermissionGate`).

The auto-derived `COMMANDS` enum in `DuyaCliTool.ts:56` regenerates from `CLI_DESCRIPTORS` on the next build — no manual edit. Verified by `program/registry.test.ts` (must be extended in Phase 7).

The argv parser in `DuyaCliTool.ts:144-227` (Plan 99 §4.2 hardening) already handles `--key value` and `--key=value` for all known flags. **Add unit tests for every new flag** (`--max-tokens`, `--thinking-budget`, `--enabled`, etc.) — see Phase 7.

### 5.2 Phase 2 — HTTP routes

`electron/cli/handlers/config.ts` (new) is structured the same way as `handlers/{providers,plugins,mcps,…}.ts`:

```ts
export async function handleConfig(
  method: string,
  parts: string[],   // ['config', 'providers', ':id', 'activate']
  body: unknown,
  ctx: HandlerCtx,
): Promise<HandlerResult> {
  // dispatch table: match (method, parts) → configDb call → DTO
}
```

`electron/cli/cli-api-server.ts:60-196` (the route table) adds 13 new routes (per §3 tree). The Plan 99 §6.3 route-coverage test (`electron/cli/__tests__/route-coverage.test.ts`) will fail in Phase 2 if any of them is not wired — that's the safety net.

**Error mapping**: every `configDb` error becomes a typed `CliApiError` with the same `{ kind, hint, httpStatus }` shape Plan 99 froze in `packages/cli/src/control-plane/errors.ts`. The current `duya_config` returns plaintext errors like `"MCP server \"foo\" already exists. Use mcp_server_assign to modify."` — keep that hint text in the handler's error path.

### 5.3 Phase 3 — implementation

Each handler is a thin call to `configDb.ts`. The renames:

| `duya_config` field | New `duya config` flag | Handler maps to |
|---|---|---|
| `providerType: enum` | `--type` | `configDb.providerUpsert({ providerType })` unchanged |
| `isActive: bool` (provider) | `--active` | unchanged |
| `isActive: bool` (vision) | `--enabled` | **renamed** — handler maps `--enabled` → `enabled: bool` in vision body; current `isActive → enabled` rename in `DuyaConfigTool.ts:204` is moved to the wire boundary, not buried in the tool |
| `mcpCommand` | `--command` | unchanged |
| `mcpArgs: string[]` | `--arg` (repeatable) | argv parser: collect all `--arg` flags into an array; handler passes through |
| `mcpEnv: Record<string,string>` | `--env KEY=VAL` (repeatable) | argv parser splits on first `=`; handler merges into object |
| `agentIds: string[]` | `--agent` (repeatable, comma-or-repeat?) | choose **repeatable `--agent a --agent b --agent c`** to match `--arg` shape; comma form is a follow-up |

`mcpArgs` and `mcpEnv` argv parsing is the **most novel work** in this plan. Both are currently JSON-shaped Zod fields in `duya_config`; making them first-class argv flags is what makes the CLI surface actually usable from a terminal. The `cron create --cron '<json>'` precedent (Plan 99 §3.1, `DuyaCliTool.ts:194-200`) is the fallback for any future complex payload that doesn't fit repeated flags.

**Read actions that survived Phase 8 by oversight** (`settings_get`, `vision_get`, `style_get`, `pairing_list`, `pairing_is_approved`) **move into the new command tree**:
- `duya settings show` ← was `settings_get`
- `duya vision show` ← was `vision_get`
- `duya style list` ← was `style_get`
- `duya pairing list` ← was `pairing_list` (and `pairingListApproved` becomes a separate `?include=approved` query flag if we want to keep the same shape, or split into `pairing list --pending` / `pairing list --approved` — design decision deferred to Phase 2)
- `duya pairing check` ← was `pairing_is_approved`

This eliminates the `duya_config` read actions entirely, matching the file header's stated intent.

### 5.4 Phase 4 — `duya mcp` write ops

Plan 99's Phase 7 already freezes the `duya mcp add / remove / assign` surface and audit rules. The only thing this plan adds is the **implementation glue**: the routes, descriptors, and `duya_config mcp_server_*` deletion.

This phase is essentially "if Plan 99 §3.3 Phase 7 is not done, do it; if it is, just delete the `duya_config` half."

### 5.5 Phase 5 — delete `duya_config`

Files to touch:

- **Delete** `packages/agent/src/tool/DuyaConfigTool/` (entire dir, 4 files + index)
- **`packages/agent/src/tool/builtin.ts`** — remove `duyaConfigTool` import + registration; verify `duyaCliTool` is the only config tool the LLM sees
- **`packages/agent/src/prompts/sections/intro.ts`** + **`packages/agent/src/prompts/general/sections/static/intro.ts`** — remove any text that mentions `duya_config` as a separate tool
- **`packages/agent/src/tool/orchestration/classify.ts`** — search for any "duya_config" classifier bucket; the routing logic should fall back to "use `duya_cli` with a `config` subcommand"
- **`packages/agent/src/security/skillScanner.ts`** — remove `duya_config` from any allowlist/denylist
- **`packages/agent/src/index.ts`** — drop the re-export if any
- **Grep-wide sweep** for the string `duya_config` in the repo; the only allowed mention post-merge is in `docs/` (this plan, decision log, deprecation note in CHANGELOG)

A one-time CHANGELOG / deprecation note: "**`duya_config` tool removed in vX.Y.Z.** Equivalent actions are now under `duya config …` (or `duya mcp add/remove/assign`). The old `duya_config { action: 'provider_add', … }` shape is replaced by `duya_cli { argv: ['config', 'provider', 'add', '--id', …] }`."

### 5.6 Phase 6 — audit

`electron/services/controlPlaneAudit.ts` (the JSONL writer Plan 99 wired) gets a new `kind` namespace:

| Action | `kind` |
|---|---|
| `duya config provider add` | `config.provider.add` |
| `duya config provider remove` | `config.provider.remove` |
| `duya config provider activate` | `config.provider.activate` |
| `duya config settings set` | `config.settings.set` |
| `duya config vision set` | `config.vision.set` |
| `duya config style set` | `config.style.set` |
| `duya config pairing approve` | `config.pairing.approve` |
| `duya config pairing revoke` | `config.pairing.revoke` |
| `duya mcp add` | `mcp.add` (already exists) |
| `duya mcp remove` | `mcp.remove` (already exists) |
| `duya mcp assign` | `mcp.assign` (already exists) |

Every `config.*` write is recorded with `invokedBy` from the `X-Duya-Invoked-By` header (Plan 99 §5.2 already passes that through).

Reads (`config provider list`, `config settings show`, `config pairing list`, `config pairing check`) are **not** audited — same as `duya plugin list`, `duya mcp list`. Audit is for state-changing operations only.

### 5.7 Phase 7 — tests

**Unit (Vitest)**:

| Test file | Scope |
|---|---|
| `packages/cli/src/program/__tests__/config-descriptor.test.ts` | New. Verifies `CLI_DESCRIPTORS` contains the `config` command with all 5 subcommands and all 14 sub-subcommands; verifies `write: true` on every action that was `duya_config` write; verifies `write: false` on every read. |
| `packages/cli/src/program/__tests__/registry.test.ts` (extend) | One test per new subcommand: `resolve('config', 'provider', 'add')` returns the descriptor, `resolve('config', 'provider', 'bogus')` returns null. |
| `packages/agent/src/tool/DuyaCliTool/__tests__/argv-config.test.ts` | New. argv parser: `--id foo --name bar --type openai`, `--max-tokens 4096`, `--arg a --arg b`, `--env KEY=VAL --env K2=V2`, `--agent a --agent b`, `--enabled`, `--active`, `--thinking-budget 8192`. Plus all the unrecognized-flag-fails-loud tests from Plan 99 §4.2. |
| `electron/cli/__tests__/config-handler.test.ts` | New. Mock `configDb`; assert each (method, path) pair maps to the right function and field renames (`--enabled → enabled`, `mcpEnv: KEY=VAL → {KEY: VAL}`). |
| `electron/cli/__tests__/route-coverage.test.ts` (extend) | Plan 99 §6.3 — the safety net. Fails if any handler URL is not registered. **This test must fail before Phase 2 and pass after.** |

**Integration (Vitest + test server)**:

| Test file | Scope |
|---|---|
| `packages/cli/tests/integration/config.test.ts` | New. `http.createServer` mock; assert `duya config provider add --id foo --name Foo --type openai --api-key sk-x --yes` reaches the handler with the right body, returns the right envelope, and writes an audit log entry. |
| `packages/cli/tests/integration/mcp-config.test.ts` | New. Same shape for `duya mcp add/remove/assign`. |
| `packages/agent/src/tool/DuyaCliTool/__tests__/end-to-end.test.ts` (extend) | Add cases: `duya_cli { argv: ['config', 'provider', 'list', '--format', 'json'] }` returns typed list; `duya_cli { argv: ['config', 'provider', 'add', '--id', 'x', '--name', 'X', '--type', 'openai', '--yes'] }` returns `ok: true`; the corresponding `duya_config` invocation **does not exist** anymore (this is the regression net — the tool was deleted). |
| `packages/agent/src/tool/DuyaCliTool/__tests__/permission.test.ts` (extend) | Plan 99 §5.1 — read allowed, write requires `yes`, every `config.*` write op must be denied without `--yes` in the argv. |

**Contract** (already in Plan 99, must be green): `electron/cli/__tests__/route-coverage.test.ts` — every new route in `cli-api-server.ts` must be exercised by a handler test.

### 5.8 Phase 8 — docs

- `docs/ARCHITECTURE.md` — update the "Agent tool surface" section to list `duya_cli` as the only config tool. Remove the "duya_config for writes / duya_cli for reads" line.
- `docs/design-docs/cli-control-plane/roadmap.md` — add a Phase 12 entry: "duya_config merged into duya_cli; mcp write surface unified."
- This plan moves to `completed/` per `AGENTS.md` workflow §3.

---

## 6. Per-action migration table

| `duya_config` action (legacy) | New `duya_cli` invocation | HTTP route | Audit kind | Read or write |
|---|---|---|---|---|
| `{ action: 'provider_add', id, name, providerType, baseUrl, apiKey, isActive }` | `duya config provider add --id X --name Y --type openai [--base-url …] [--api-key …] [--active]` | `POST /v1/config/providers` | `config.provider.add` | write |
| `{ action: 'provider_remove', id }` | `duya config provider remove <id>` | `DELETE /v1/config/providers/:id` | `config.provider.remove` | write |
| `{ action: 'provider_activate', id }` | `duya config provider activate <id>` | `POST /v1/config/providers/:id/activate` | `config.provider.activate` | write |
| `{ action: 'settings_get' }` | `duya config settings show` | `GET /v1/config/settings/agent` | — | read |
| `{ action: 'settings_set', …patch }` | `duya config settings set [--model …] [--max-tokens …] [--temperature …] [--top-p …] [--top-k …] [--enable-thinking] [--thinking-budget …]` | `PATCH /v1/config/settings/agent` | `config.settings.set` | write |
| `{ action: 'vision_get' }` | `duya config vision show` | `GET /v1/config/settings/vision` | — | read |
| `{ action: 'vision_set', …patch, isActive→enabled }` | `duya config vision set [--provider …] [--model …] [--base-url …] [--api-key …] [--enabled]` | `PATCH /v1/config/settings/vision` | `config.vision.set` | write |
| `{ action: 'style_get' }` | `duya config style list` | `GET /v1/config/output-styles` | — | read |
| `{ action: 'style_set', styleId }` | `duya config style set <styleId>` | `POST /v1/config/output-styles` | `config.style.set` | write |
| `{ action: 'pairing_list' }` | `duya config pairing list [--include approved]` | `GET /v1/config/pairing[?include=approved]` | — | read |
| `{ action: 'pairing_approve', platform, code }` | `duya config pairing approve --platform X --code ABCD1234` | `POST /v1/config/pairing/approve` | `config.pairing.approve` | write |
| `{ action: 'pairing_revoke', platform, platformUserId }` | `duya config pairing revoke --platform X --user Y` | `POST /v1/config/pairing/revoke` | `config.pairing.revoke` | write |
| `{ action: 'pairing_is_approved', platform, platformUserId }` | `duya config pairing check --platform X --user Y` | `GET /v1/config/pairing/check?platform=&user=` | — | read |
| `{ action: 'mcp_server_add', … }` | `duya mcp add --server X --command npx --arg a --arg b --env K=V --agent a --agent b` | `POST /v1/mcps` | `mcp.add` | write |
| `{ action: 'mcp_server_remove', serverName }` | `duya mcp remove <name>` | `DELETE /v1/mcps/:name` | `mcp.remove` | write |
| `{ action: 'mcp_server_assign', serverName, agentIds? }` | `duya mcp assign --server X [--agent a --agent b]` (empty `--agent` = all) | `PATCH /v1/mcps/:name` | `mcp.assign` | write |

---

## 7. Critical files (must read before implementing)

- `packages/agent/src/tool/DuyaConfigTool/DuyaConfigTool.ts:1-338` — the legacy impl. Becomes the source-of-truth DTO map (which fields exist, which are required) for the new `config.ts` handler.
- `packages/agent/src/tool/DuyaConfigTool/prompt.ts` — the LLM-facing description. Useful wording to fold into the `duya_cli` prompt for the new subcommands.
- `packages/agent/src/tool/DuyaCliTool/DuyaCliTool.ts:1-372` — argv parser, descriptor-driven dispatcher. Most of the work is adding new tests for new flags.
- `packages/cli/src/program/descriptors.ts` — where the `config` command tree gets registered. Must follow the same shape as the existing `cron` / `channel` / `mcp` descriptors.
- `packages/cli/src/program/build-request.ts` (Plan 99 §4.3) — `pathFor` / `methodFor` / `bodyFor` tables; add the new routes here so they cannot drift from the descriptor.
- `electron/cli/cli-api-server.ts:60-196` — the route table that gets 13 new entries.
- `electron/db/queries/configDb.ts` — the SQLite-touching layer. **Stays**; the HTTP handler is a thin caller.
- `electron/services/controlPlaneAudit.ts` — the JSONL audit writer; new `kind` entries.
- `packages/plugin-core/src/security/permission-service.ts` — Plan 97's `canUseTool`. Every new write op goes through it (Plan 99 §5.1).
- `packages/agent/src/tool/builtin.ts` — where `duyaConfigTool` is registered. Deletion point.
- `packages/agent/src/prompts/{sections,general/sections/static}/intro.ts` — text mentioning `duya_config` is updated to mention `duya_cli` only.
- [`docs/design-docs/cli-control-plane/roadmap.md`](../../design-docs/cli-control-plane/roadmap.md) — binding DTOs and decisions.
- [`docs/design-docs/cli-control-plane/phase-7-write-operations.md`](../../design-docs/cli-control-plane/phase-7-write-operations.md) — write op rules (apply to config writes too).

---

## 8. Verification

```bash
# Gate (pre-commit)
npm run typecheck:all

# Unit
npm run test -- packages/cli/src/program
npm run test -- packages/agent/src/tool/DuyaCliTool
npm run test -- electron/cli/__tests__

# Integration
npm run test -- packages/cli/tests/integration/config
npm run test -- packages/cli/tests/integration/mcp-config

# Regression: duya_config must NOT be registered as a tool
npm run test -- packages/agent/src/tool/builtin
# (extend the existing test to assert the tool registry has no "duya_config" entry)

# Manual smoke (desktop app running)
node packages/cli/dist/index.js config --help
node packages/cli/dist/index.js config provider list
node packages/cli/dist/index.js config provider add --id smoke --name Smoke --type openai --api-key sk-x --yes
node packages/cli/dist/index.js config provider list                 # should now include "smoke"
node packages/cli/dist/index.js config settings show
node packages/cli/dist/index.js config settings set --temperature 0.7
node packages/cli/dist/index.js config settings show                 # temperature should be 0.7
node packages/cli/dist/index.js config vision show
node packages/cli/dist/index.js config style list
node packages/cli/dist/index.js config pairing list
node packages/cli/dist/index.js mcp add --server test-mcp --command npx --arg -y --arg @foo/bar --yes
node packages/cli/dist/index.js mcp list
node packages/cli/dist/index.js mcp remove test-mcp --yes

# Agent context (duya_cli tool)
# In a chat session:
#   duya_cli { argv: ["config", "provider", "list"] }
#   duya_cli { argv: ["config", "provider", "add", "--id", "x", "--name", "X", "--type", "openai", "--yes"] }
#   duya_cli { argv: ["config", "settings", "show"] }
#   duya_cli { argv: ["mcp", "add", "--server", "test", "--command", "npx", "--yes"] }
#   duya_cli { argv: ["config", "provider", "remove", "x", "--yes"] }
```

Audit log check (after the manual smoke):
```bash
cat "$APPDATA/DUYA/control-plane-audit.log.jsonl" | tail
# Expect: events for config.provider.add, config.settings.set, mcp.add, mcp.remove, config.provider.remove
# Each with invokedBy: 'cli' (manual) or 'agent-tool:<sessionId>' (from chat)
```

---

## 9. Out of scope (deferred)

- **Bulk provider import / export** (`duya config provider import --file providers.json`). Defer until requested.
- **Configuration diff / dry-run** (`duya config settings set … --dry-run`). Defer — read first, write second.
- **Interactive prompts for secrets** (`--api-key` from stdin if not on argv). Defer — `--api-key` works as-is; secrets in argv are an existing practice.
- **i18n of the new subcommands** (`config 提供商 列表`). Inherits the Plan 96 §2.4 contract; not implemented in this plan.
- **Per-agent settings override** (different `temperature` per agent profile). The `agentGetSettings` query is per-agent today; the CLI just doesn't expose that axis. Defer.
- **Generic plugin CLI surface** (plugins registering their own subcommands). Plan 87/88 are about hooks/lifecycle, not CLI extension. Defer to a follow-up plan.
- **`config show` flat form** (a la `git config --list`). Some users will miss it. Defer — `duya config settings show` + `duya config vision show` + `duya config style list` cover the common cases.

---

## 10. Decision log

- **Why merge, not just delete the read actions in `duya_config` and keep the writes there?** Because the writes are the *only* thing left in `duya_config` after the Phase 8 cleanup, and they're the thing that most needs the audit log + `canUseTool` gating the CLI control plane already has. A `duya_config` that's "writes only, GUI-only, no audit, no permission gate" is exactly the security regression Plan 99 was designed to remove. The merge is the only path that doesn't leave a tool-shaped hole in the safety boundary.
- **Why not add a `duya config settings patch` JSON-flag like cron's `--cron '<json>'`?** Tempting for ergonomics, but it hides the schema from the LLM. The argv-form flags are what the agent *learns* — and what the user types at a terminal. The cron `--cron` is justified because cron bodies are complex nested `schedule` objects that don't fit repeated flags; a settings patch with 7 sibling fields is a perfect fit for `--flag value` × N.
- **Why rename `isActive → enabled` for vision specifically (and not for provider)?** Because provider's `isActive` predates this plan and changing it breaks read-DTO compat with the GUI. Vision's `isActive → enabled` is internal to `duya_config` (`DuyaConfigTool.ts:204`) and was never on the wire — there's no compat to preserve. Standardize at the new boundary.
- **Why the new routes are under `/v1/config/...` not `/v1/providers/...`?** Because Plan 99 already has `provider` as a **read-only** command (`duya provider list / info`). Splitting "read provider list" (existing `GET /v1/providers`) from "write provider add" (new `POST /v1/config/providers`) is the **opposite** of the merge — it re-introduces the split this plan is removing. The `duya provider` surface stays read-only; the `duya config provider` surface owns writes. The route path `/v1/config/providers` signals "this is a config-mutation surface" without colliding with `/v1/providers`.
- **Why audit reads are skipped?** Same as `duya plugin list` — audit is for state changes, not for the agent poking at its own configuration. If we later want to detect "agent exfiltrated provider list before deleting it", that's a separate correlation query, not a per-call audit.
- **Why `--agent a,b` was *not* chosen; we use repeated `--agent a --agent b`?** Because Plan 99 argv parser already has the `--cron '<json>'` pattern for "one flag carries a complex payload". Repeated `--agent` is cheaper to learn and parse, and the LLM sees individual flags in the tool envelope (better for tool-call self-correction if a value has a comma in it). Comma form is a follow-up if users complain.

### Outcomes (filled 2026-06-04)

- `_packages/agent/src/tool/DuyaConfigTool/` deleted; `tool/builtin.ts` registers only `duyaCliTool` for config. The legacy `tests/unit/DuyaConfigTool.test.ts` is also deleted.
- `electron/cli/handlers/config.ts` created with 14 endpoints (the 13th is `pairing check`); `cli-api-server.ts` route table extended by 17 entries (14 config + 3 mcp writes).
- `electron/cli/handlers/mcps.ts` extended with `handleAddMCP / handleRemoveMCP / handleAssignMCP` (Plan 99 §3.3 Phase 7 surface).
- `electron/db/queries/configDb.ts` unchanged (still the SQLite facade — handlers call `ConfigManager` + `PairingStore` directly).
- `packages/cli/src/program/descriptors.ts` gains the `config` command (14 flat subcommands) and `mcp` adds `add / remove / assign`; `build-agent-runner.ts` + `build-control-plane.ts` forward the new config argv fields.
- `packages/cli/src/commands/config.ts` (new) and `commands/mcp.ts` (extended) provide 14+3 new `run*` functions. argv-style in the agent tool: `duya_cli { argv: ['config', 'provider-add', '--id', …, '--yes'] }`.
- `electron/services/controlPlaneAudit.ts` gains 11 new `kind` entries (8 `config.*` + 3 `mcp.*`).
- **Tree shape deviation**: the plan's `duya config provider list` (3-level) was flattened to `duya config-provider-list` (2-level) to match the existing 2-level `resolveSubcommand` contract. Functionally identical, naming convention is consistent with `cron create`, `plugin enable`. The flat names are what the agent tool and CLI bundle share.
- **Field rename**: vision `isActive` is renamed to `enabled` at the wire boundary (the legacy `duya_config` field has no compat to preserve). The handler still accepts `isActive` for forward-compat with old callers.
- `npm run typecheck:all` clean for new code (the pre-existing `memory/tool.ts` and `BashTool.ts` errors are unrelated to this plan; the pre-existing electron `rootDir` errors are also unrelated).
- 27/27 `registry.test.ts` PASS (5 new). 34/34 `DuyaCliTool.test.ts` PASS (6 new, including the "duya_config is not in the tool enum" regression test).
- Agent prompt (`prompts/sections/intro.ts` + `prompts/general/sections/static/intro.ts`) updated; `duya_config` references in code survive only in:
  - `packages/cli/src/commands/config.ts` / `mcp.ts` (comments documenting the migration)
  - `packages/cli/src/program/descriptors.ts` (descriptor `description` strings)
  - `electron/cli/handlers/config.ts` / `mcps.ts` (file headers + comments)
  - `packages/agent/src/tool/builtin.ts` / `mcp/apply.ts` / `prompts/*/intro.ts` (deprecation text)
  - `packages/agent/src/security/skillScanner.ts:346` — `duya_config_mod` is a *path pattern* name (`.duya/config.yaml`), not a tool name; intentionally left as-is.
- Design-doc entry added at `docs/design-docs/cli-control-plane/roadmap.md` §"Phase 13".

---

## 11. Cross-links

- Plan [96 — DUYA CLI Tool](./96-duya-cli-tool.md): the 12 prior phases + Phase 8's read/write split that this plan dissolves.
- Plan [98 — CLI Channel / Cron / Message + Command-Registration Refactor](./98-cli-channel-cron-message.md): the descriptor registry this plan extends.
- Plan [99 — CLI Split & Control Plane](./99-cli-split-and-control-plane.md): the dispatcher abstraction, `buildAgentRunner` contract, route table, and `invokedBy` audit header that this plan builds on.
- Plan [97 — Tool-Path-Permission Refactor](./97-tool-path-permission-refactor.md): the `canUseTool` integration that gates every new write op.
- Plan [92 — Plugin Security / Enterprise Policy](./92-plugin-security-enterprise-policy.md): long-term RBAC for config writes (deferred).
- [`docs/design-docs/cli-control-plane/roadmap.md`](../../design-docs/cli-control-plane/roadmap.md): binding DTOs and decisions. Phase 13 entry added on completion.
- [`docs/design-docs/cli-control-plane/phase-7-write-operations.md`](../../design-docs/cli-control-plane/phase-7-write-operations.md): write op rules; apply to config writes.
