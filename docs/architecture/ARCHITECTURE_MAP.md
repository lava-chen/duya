# Architecture Map

> **Which package do I open for this symptom?**
>
> Read [ARCHITECTURE.md](ARCHITECTURE.md) for design and data flows.
> Read `packages/<pkg>/AGENTS.md` for that package's own responsibilities,
> key files, and debug entries.

Every claim here cites a `path:line`. If a fact drifts, the citation tells you
where to re-check — that is the point of this file.

---

## 1. The package map

23 workspace packages. Each has its own `AGENTS.md`.

| Package | Owns | Debug entry |
| --- | --- | --- |
| `agent-protocol` | Wire contract: events, manifest, seq ledger, API DTOs. Zero runtime deps. | `src/run-ledger.ts:165` |
| `agent-core` | Pure run reasoning: terminal state, budget, durability. Zero IO. | `src/run-outcome.ts:101` |
| `agent-runtime` | The run engine: `RunEngineImpl`, `RunEvent` stream, tool pipeline, permission gate. | `src/engine/run-engine.ts` |
| `host` | Product worker: run manifest, `RunOrchestrator`, worker supervision, tool registry, DB bridge. | `src/run-orchestrator.ts:637` |
| `cli` | CLI control plane + terminal TUI. Also the worker bundle's esbuild entry. | `src/index.ts:46` |
| `agent` | **Legacy shell, retirement OPEN.** ~335 re-export shims. Not the execution subject. | `scripts/architecture/agent-retirement-gate.mjs` |
| `ai` | LLM adapter + **built-in provider/model catalog**. | `src/providers/catalog-data.ts:40` |
| `capabilities` | Tool implementations (FS/shell/browser/MCP) + tool contracts + path policy. | `src/permissions/policy.ts:1032` |
| `data` | SQLite ownership, migrations, durable stores. Data root is `~/.duya`. | `src/main-schema.ts:23` |
| `memory` | Memory V2 domain: layout, curation ledger, leases, extraction. | `src/outbox.ts:207` |
| `plugin-core` | Plugin formats, MCP pure resolution, trust tiers, App schema. | `src/security/trust-engine.ts:25` |
| `tooling` | Extension contract + 13-slot registry — a contract, no production caller found. | `src/registry.ts:129` |
| `sandbox` | Command sandboxing: Docker → bubblewrap → none. | `src/sandbox-adapter.ts:41` |
| `computer-use` | Desktop control backend (mouse/keyboard/screen/SOM) + app access policy. | `src/access.ts:136` |
| `client-core` | Transport-neutral surface model + `RunSession` reducer. | `src/surface/surface-model.ts` |
| `ui` | **The whole renderer**: components, stores, hooks, i18n, CSS, `UiServices`. | `src/App.tsx:97` |
| `command-catalog` | Slash-command metadata only. No behavior. | `src/index.ts` |
| `input-completion` | Pure completion rules. Candidates come from each surface. | `src/trigger.ts` |
| `connectors` | App Connector id vocabulary + `.app.json` schema. Zero IO. | `src/app-schema.ts` |
| `gateway` | External platform gateway (Telegram / Feishu / WeChat / Discord). | `src/gateway-manager.ts:188` |
| `voice` | Voice input: mic → streaming STT → text. | `src/stt/engine.ts:20` |
| `apps/desktop` | Electron main process, preload bridge, SQLite boot, Agent Server child. | `src/preload/index.ts` |
| `apps/web` | Browser client: loopback BFF → standalone Host. | `src/server/web-bff.ts:53` |

The **Debug entry** column is relative to that package's own root.

### Dependency direction

A package may only depend downward. The enforced layer table lives in
`scripts/architecture/boundary-gates.mjs:67-75` — **not** in the `layers:` block
of `architecture-policy.yaml`, which the main checker never reads.

```
protocol  @duya/agent-protocol
core      @duya/agent-core, @duya/ai
runtime   @duya/agent-runtime, @duya/agent, @duya/capabilities,
          @duya/connectors, @duya/memory
host      @duya/desktop, @duya/cli, @duya/gateway
```

12 packages (`host`, `ui`, `data`, `client-core`, `tooling`, `sandbox`,
`plugin-core`, `command-catalog`, `input-completion`, `computer-use`,
`voice`, `web`) are in **no layer** — reverse edges into them are
not checked.

---

## 2. One turn, end to end

1. **Client → server.** Desktop router `apps/desktop/src/main/agents/server/router.ts:1184`
   resolves provider + cwd, then sends `init`. Standalone Host equivalent:
   `packages/host/src/http-server.ts:2798` (SSE at `:2893`).
2. **Run identity minted.** `const runId = randomUUID()` —
   `packages/host/src/run-orchestrator.ts:638` (`openRun` at `:637`).
3. **Manifest frozen.** `packages/host/src/manifest-factory.ts:171` — provider
   and model frozen in, deep-frozen `:269`, fingerprinted `:270`. Host does
   this, *not* the runtime, so the runtime cannot self-certify.
4. **Worker spawned.** `packages/host/src/worker-manager.ts:231`; the artifact
   is `packages/host/bundle/worker-entry.js`, built from
   `packages/cli/src/agent-worker-entry.ts` (`scripts/build-host-worker-bundle.mjs:30`).
5. **Turn runs.** `packages/host/src/worker-process-entry.ts:1684` →
   `driveRunWithEngine` (`packages/host/src/worker-engine-driver.ts:104`) →
   `RunEngineImpl.execute` (`packages/agent-runtime/src/engine/run-engine.ts`).
6. **Events flow.** Worker → host over **NDJSON on stdout**
   (`packages/host/src/worker-transport.ts:92`); host → client over **HTTP+SSE**.
   Frames become protocol events at
   `packages/agent-runtime/src/translate/chat-event-translator.ts:222`.
7. **Terminal waits for durability.** The terminal event is held until the
   durable `run:complete` lands (`packages/agent-runtime/src/events/event-emitter.ts:563`,
   `packages/host/src/run-orchestrator.ts:1259`).

`seq` has exactly one authority: `packages/agent-protocol/src/run-ledger.ts:165`.
Producer-supplied `seq` is re-minted, never adopted.

---

## 3. Symptom → open this

| Symptom | Open first |
| --- | --- |
| Run will not start | `packages/host/src/run-orchestrator.ts:637` |
| Cancel does nothing | `packages/host/src/run-orchestrator.ts:1428` |
| Worker never boots | `packages/host/src/worker-manager.ts:234` |
| Worker crash on boot | `packages/host/src/worker-process-entry.ts:3781` |
| Worker refuses the turn | `packages/host/src/worker-process-entry.ts:1757` + `packages/agent-core/src/run-manifest-verification.ts` |
| Events out of order / seq gaps | `packages/agent-protocol/src/run-ledger.ts:165` |
| Terminal never lands | `packages/host/src/run-orchestrator.ts:1259` |
| Tool hangs | `packages/agent-runtime/src/tools/execution/StreamingToolExecutor.ts:1412` |
| Tool not visible to the model | `packages/host/src/worker-session-runtime.ts:1499` |
| Permission wrongly denied/allowed | `packages/agent-runtime/src/authorization/permissions/permissions.ts:283` |
| Permission prompt stuck | `packages/host/src/worker-process-entry.ts:1606` |
| Provider / model ignored | `packages/host/src/manifest-factory.ts:241` |
| New model missing from catalog | `packages/ai/src/providers/catalog-data.ts:40` |
| MCP server will not connect | `packages/capabilities/src/MCP/MCPManager.ts:665` |
| MCP tool missing | `packages/host/src/connector-services/apply.ts:427` |
| Plugin will not load | `packages/plugin-core/src/plugins/loader/capability-discovery.ts:423` |
| Filesystem tool / path rejected | `packages/capabilities/src/permissions/policy.ts:557` |
| Shell permission misjudged | `packages/capabilities/src/permissions/policy.ts:837` |
| Memory not persisted | `packages/memory/src/outbox.ts:207` |
| DB migration mismatch | `packages/data/src/main-schema.ts:903` |
| Sandbox not applied | `packages/sandbox/src/sandbox-adapter.ts:41` |
| Blank renderer | `packages/ui/src/App.tsx:97` |
| State not updating | `packages/ui/src/stores/conversation-store.ts:610` |
| IPC call fails | `apps/desktop/src/preload/index.ts` |
| Web cannot reach Host | `apps/web/src/server/web-bff.ts:53` |
| Marketplace Canvas app broken | `plugins/conductor-canvas/src` |
| Slash popup broken | `packages/ui/src/lib/message-input-logic.ts` → `@duya/input-completion` |

---

## 4. Dead paths — the ones people still follow

The renderer moved to `packages/ui/src`. The top-level `src/` and `electron/`
directories **do not exist** (0 tracked files).

| Old path | Current path |
| --- | --- |
| `apps/desktop/src/renderer/components/**` | `packages/ui/src/components/**` |
| `apps/desktop/src/renderer/lib/**` | `packages/ui/src/lib/**` |
| `apps/desktop/src/renderer/stores/**` | `packages/ui/src/stores/**` |
| `apps/desktop/src/renderer/i18n/**` | `packages/ui/src/i18n/**` |
| `apps/desktop/src/renderer/components/layout/panels/CodeReviewPanel.tsx` | `packages/ui/src/components/layout/panels/CodeReviewPanel.tsx` |
| `apps/desktop/src/renderer/lib/git-ipc.ts` | `packages/ui/src/lib/git-ipc.ts` |
| `apps/desktop/src/renderer/lib/commands/registry.ts` | `packages/ui/src/lib/commands/registry.ts` |
| `electron/preload.ts` | `apps/desktop/src/preload/index.ts` |
| `electron/main.ts` | `apps/desktop/src/main/index.ts` |
| `electron/logging/logger.ts` | `apps/desktop/src/main/logging/logger.ts` |
| `electron/ipc/git-handlers.ts` | `apps/desktop/src/main/ipc/git-handlers.ts` |
| `packages/agent/bundle/agent-process-entry.js` | `packages/host/bundle/worker-entry.js` |
| `resources/agent-bundle/` | `resources/harness-bundle/` |
| `packages/agent/src/tool/**` (tool implementations) | `packages/capabilities/src/**` — the agent copies are shims |

Also dead: `npm run chat-cli` / `chat-cli:build` / `build:chat-cli` (no such
scripts). Use `npm run build:cli-dev` then `npm run dev:tui`, which runs
`node packages/cli/bundle/cli.cjs tui`.

---

## 5. Boundaries and gates

`architecture-policy.yaml` is the machine authority. `managed: true` means
zero tolerance and never baselined — there are **16** such modules, not 3.
`managed: false` modules may carry baseline debt but cannot grow it.
Declared `requires:` edges are counted, never blocking; an **undeclared** edge
is what blocks.

```bash
npm run architecture:check     # boundary gate (writes a temp file under scripts/)
npm run architecture:self-test
npm run check:encoding          # UTF-8, no BOM — applies to .md too
node tests/rules-compliance.test.mjs   # every packages/* must have a rule file
npm run typecheck:all
```

`@duya/ai` is a `core` module with 5 registered IO carve-outs
(`scripts/architecture/layer-purity.ts:303-337`) — adding a `fetch(` anywhere
else in that package fails the gate.
