# DUYA CLI — Product Responsibility & Roadmap

> **Status**: Phase 0 + Phase 1 + Phase 2 + Phase 3 Complete
> **Created**: 2026-05-31
> **Updated**: 2026-06-03
> **Scope**: CLI product positioning, formal decisions, command roadmap, and Phase 2 design.

---

## 1. Product Positioning

DUYA CLI is **not** a second independent agent runtime, nor is it a replacement for the GUI. It is a **local command control plane** for advanced users, developers, and automated scripts.

| Dimension | GUI | CLI |
|-----------|-----|-----|
| **Primary audience** | Ordinary researchers, daily workflows | Advanced users, developers, automation |
| **Capability** | Full interaction, visual feedback | Status queries, diagnostics, structured output |
| **Security model** | Interactive confirmation, credential entry | Read-only by default, write ops behind explicit auth |
| **Output** | Rich UI, charts, interactive widgets | Plain text, JSON, table formats |
| **Automatable** | Limited (requires display) | Full (scriptable, `--format json`) |

The GUI owns the complete interactive experience: capability discovery, session creation, tool execution with confirmation, credential management, and complex research workflows. The CLI delegates to the GUI's data source (via the CLI API server) and provides only what the GUI can safely expose.

---

## 2. Users & Scenarios

### 2.1 Ordinary Research User
- **Primary interface**: GUI
- **CLI usage**: None expected
- **Rationale**: CLI requires understanding of the app's architecture; GUI is safer and more discoverable

### 2.2 Advanced User / Developer
- **Primary interface**: GUI for session work; CLI for state inspection
- **CLI usage**:
  - `duya status` — quick health check before starting a complex session
  - `duya plugin list` — audit what capabilities are installed
  - `duya session list` — find a specific session by title or pattern
  - `duya doctor` — diagnose why a capability is not working
  - `duya skill list` / `duya skill info <id>` — inspect available skills
- **Rationale**: CLI enables fast diagnostics without opening the full app

### 2.3 External Script / Automated Agent
- **Primary interface**: CLI via `--format json`
- **CLI usage**:
  - Query plugin/session/skill state for conditional logic
  - Feed structured data into external pipelines
  - Monitor DUYA's operational state
- **Constraints**: Read-only operations only; no write, no credential access
- **Rationale**: External agents need a stable, versioned API surface

---

## 3. Formal Decisions (Implementation Constraints)

These decisions are binding for all future CLI development. No implementation may violate them.

### 3.1 Decision 1: `duya doctor` Positioning

- `duya doctor` is a high-priority user-facing diagnostic entry point, **not** a code-level prerequisite for `provider` / `MCP` / `skill` commands.
- Each command family directly calls its corresponding domain service / health probe. `doctor` only aggregates results.
- **doctor v0** reports only checks from **stable, security-audited** data sources:
  - desktop / CLI API / runtime discovery
  - profile mode
  - database integrity
  - plugin registry
  - session query
- **Provider / skill**: Return `not_checked` or omit from doctor v0 until their data sources are audited.
- **MCP**: Currently only output a clear WARNING that "configuration source-of-truth is not yet unified". **Do not** pre-connect new MCP read implementations for the sake of doctor.

### 3.2 Decision 2: CLI Write Operations Rules

- Write operations **must** reuse the main process's and GUI's identical domain policy / service. CLI is **never** permitted to directly modify config files or maintain its own state.
- Low-risk reversible interactive CLI operations may default to requiring confirmation in the future.
- In **non-interactive / external agent** scenarios, write operations are **denied by default** until the following are designed:
  - `--yes` flag semantics and scope
  - Permission scope for CLI-originated actions
  - Audit strategy
- The following high-risk operations are **not exposed** until above design is complete:
  - Provider key entry
  - `plugin install` / `plugin remove`
  - `mcp add` / `mcp remove`
  - `session delete`

### 3.3 Decision 3: Audit Log Rules

- CLI does **not** create independent log storage. Future write operations and security-related events are written by the main process to a **unified control-plane audit store**.
- Read-only operations (`list` / `info` / `show`) do **not** persist audit logs by default.
- The following **may** be logged:
  - Authentication failures
  - Permission denials
  - Write operations (when implemented)
  - Sensitive diagnostics (e.g., repeated auth failures)
- **Never log**:
  - API keys, bearer tokens, or any secrets
  - Session message content or system prompts
  - Complete request/response bodies for read operations

### 3.4 Decision 4: Output Contract Stability

- **Default text output** is for human reading. Layout and wording are **not stable**; scripts must not parse text output.
- **`--format json`** and local `/v1/*` API responses form a **versioned stable contract** for automation.
  - Field names, field types, semantics, and error envelopes must not change in breaking ways.
- **Frozen JSON DTOs**:

  | Endpoint | Fields |
  |----------|--------|
  | `GET /v1/plugins` (list) | `id / name / version / enabled / capabilities / source` |
  | `GET /v1/plugins/:id` (info) | `id / name / version / enabled / capabilities / source / description / permissions` |
  | `GET /v1/sessions` (list) | `id / title / updatedAt / messageCount` |
  | `GET /v1/sessions/:id` (show) | `id / title / createdAt / updatedAt / model / messageCount` |
  | `GET /v1/skills` (list) | `id / name / description / source / enabled` |
  | `GET /v1/skills/:id` (info) | `id / name / description / category / source / enabled / customized / userInvocable / allowedTools / platforms` |

- **No arbitrary internal or sensitive fields** may be added to JSON output.

### 3.5 Decision 5: External Agent & Authentication Boundaries

- **No external agent continuous polling** of the local API is designed in the near term.
- External scripts or agents may call read-only CLI JSON commands **on demand**; they do not directly obtain or hold the runtime bearer token.
- API continues to bind to `127.0.0.1` only; **no remote control, long-lived tokens, or persistent polling interfaces** are provided.
- Automated write operations are **not enabled** until:
  - Capability scope design
  - Confirmation strategy
  - Rate limiting
  - Audit logging

  are all completed.

---

## 4. Core Responsibilities (What CLI Does)

### 4.1 Status & Diagnostics
- `duya status` — Is the GUI running? Is the CLI API server reachable? Is the auth token valid?
- `duya doctor` — Read-only diagnostic aggregating health probes

### 4.2 Capability Query (Read-Only)
- `duya plugin list` / `duya plugin info <id>` — **Done (Phase 0)**
- `duya skill list` / `duya skill info <id>` — **Done (Phase 3)**
- `duya provider list` / `duya provider status` — Phase 4
- `duya mcp list` / `duya mcp status` — Phase 6 (after Phase 5 data source unification)

### 4.3 Asset Read-Only Access
- `duya session list` / `duya session show <id>` — **Done (Phase 1)**
- Future: `duya session search <query>`
- Future: `duya message list <session-id>`

### 4.4 Reversible Management Actions (Phase 7, Post Permission Model)
- `duya plugin enable <id>` / `duya plugin disable <id>`
- `duya skill enable <id>` / `duya skill disable <id>`
- `duya mcp enable <id>` / `duya mcp disable <id>`

---

## 5. Non-Core Responsibilities (What CLI Does NOT Do)

### 5.1 Legacy Execution CLI (Preserved as-is, Not Expanded)
- `duya --print <prompt>`
- `duya -t`
- `duya --headless`
- `duya REPL`
- `duya setup`

These will not receive new features, refactoring, or architectural investment.

### 5.2 Prohibited Behaviors
- **No second state store**: CLI reads exclusively from the GUI's data source.
- **No MCP before data source unification** (Phase 5).
- **No write operations before permission model** (Phase 7).
- **No API key exposure**: Provider commands show only `hasKey: true/false` and `active: true/false`.

### 5.3 Out of Scope Indefinitely
- Remote control (`--api`, `--token`, SSH tunneling)
- Daemon mode
- CLI bundle as a standalone npm package
- PATH registration (`duya install-cli`) until CLI is stable
- Session create/update via CLI

---

## 6. Command Roadmap

### Phase 0 — Plugin Control Plane ✅ COMPLETE
| Command | Notes |
|---------|-------|
| `duya status` | Runtime discovery, server health, auth |
| `duya plugin list` | id/name/version/enabled/capabilities/source |
| `duya plugin info <id>` | id-only, no name fallback |

### Phase 1 — Session Control Plane ✅ COMPLETE
| Command | Notes |
|---------|-------|
| `duya session list` | Pagination, visibility filter, --format |
| `duya session show <id>` | 6-field DTO, unified 404 |
| Formal integration tests | 22/22 PASS |

### Phase 2A — Doctor Health-Probe Audit ✅ COMPLETE
- Product contract: `status` vs `doctor` semantic separation
- JSON schema v1.0.0: check IDs, status enum, aggregation rules
- Exit code strategy: 0 for ok/warning, 1 for error
- Code reuse audit: `probe()` addition to `client.ts`
- Test plan: 10 scenarios covering normal/failure/security cases

### Phase 2B — `duya doctor` Implementation ✅ COMPLETE
- `duya doctor [--format json|text]` — read-only diagnostic
- 10/10 formal integration tests PASS

### Phase 3A — Skill Data Source Audit ✅ COMPLETE
- Audited all 5 sources (bundled, user, project, custom, plugin)
- Identified bundled→user misclassification bug
- Documented resolver + precedence model

### Phase 3A.1 — Skill Identity & Override Contract ✅ COMPLETE
- Locked `enabled` semantic (name-scoped effective state)
- Locked supported sources: `bundled`, `user` (post-fix), `plugin`
- Frozen list DTO and info DTO candidates
- No project/custom support in v0 (no stable public id)

### Phase 3B-0 — Bundled Source Provenance & Sync Protection ✅ COMPLETE
- `13c1d24` provenance marker (`.duya-origin.json`) + safe migration
- `c7253b3` user-owned skill protection during sync
- `7510ea4` / `8fc2d8f` customized bundled semantics + continuous upgrade
- `effectivePrecedence` lock: `user = customized-bundled > plugin > plain bundled`

### Phase 3B-1 — Skill CLI Read-Only ✅ COMPLETE
- Shared resolver + DTO at `packages/agent/src/skills/skillService.ts`
- `duya skill list` / `duya skill info <id>`
- HTTP endpoints `GET /v1/skills` and `GET /v1/skills/:id`
- Frozen JSON DTOs: list `id / name / description / source / enabled`; info adds `category / customized / userInvocable / allowedTools / platforms`

### Phase 4 — Provider Read-Only (Future)
| Command | Notes |
|---------|-------|
| `duya provider list` | `hasKey: true/false`, no key value |
| `duya provider status <id>` | `active: true/false`, model name |

### Phase 5 — MCP Source-of-Truth Unification (Future)
> Not a CLI command. Infrastructure prerequisite for Phase 6.

### Phase 6 — MCP Read-Only (Future)
| Command | Notes |
|---------|-------|
| `duya mcp list` | After Phase 5 complete |
| `duya mcp status <id>` | Connection status, tool count |

### Phase 7 — Write Operations (Future, Post Permission Model)
- `enable` / `disable` for plugin, skill, mcp
- `session delete` (soft-delete)
- Never via CLI: `provider set-key`, `plugin install`, `mcp add`

---

## 7. Summary: Permanent Scope Exclusions

| Category | Reason |
|----------|--------|
| Remote control (`--api --token`) | Security boundary |
| MCP before data source unification | Avoid inconsistent answers |
| Write operations before permission model | Audit logging, confirmation required |
| `duya install-cli` (PATH registration) | CLI must stabilize first |
| CLI bundle as npm package | Desktop app is distribution mechanism |
| Session create/update via CLI | Inherently interactive, belongs in GUI |
| API key display via `duya provider` | Never expose credentials |
| External agent continuous polling | Not designed; local-only control plane |

---

*This document is the system of record for the CLI control plane. Implementation plans live in `docs/exec-plans/active/96-duya-cli-tool.md`.*