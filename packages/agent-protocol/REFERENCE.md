---
title: "@duya/agent-protocol"
description: Transport-neutral contracts for Sessions, Runs, events, and Host APIs in the DUYA workspace.
---

This page documents the current code contract of `packages/agent-protocol` in the DUYA monorepo. The package defines data shapes and boundaries shared across the Host, Runtime, and clients; it does not implement those operations.

> **Contract scope:** `package.json` marks this package as `private`. “Public exports” here means entry points explicitly declared for workspace packages. It is not a published npm API or an independent long-term compatibility promise. This page follows the current monorepo source.

## Responsibilities and non-responsibilities

`@duya/agent-protocol` defines cross-process contracts, including:

- Session, Run, permission, capability, and error DTOs and interfaces.
- The `RunEvent` union, event metadata registry, and event envelope.
- The Run Manifest shape and deterministic fingerprinting.
- Run event sequence rules and the pure protocol state machine `RunLedger`.
- Contracts shared by the Host and clients for Bots, Plugins, MCP, channels, and workflows.

It does not create Sessions, run an Agent, connect to a model, persist a database, or start HTTP/SSE or Workers. Those implementations belong to `@duya/host`, `@duya/agent-runtime`, `@duya/data`, and the calling surface.

## Dependencies and boundaries

| Property | Current contract |
| --- | --- |
| Runtime dependencies | None; `dependencies` is empty |
| I/O | No filesystem, network, database, or process I/O |
| Architecture position | Foundation `protocol` layer; no dependency on Host, Runtime, or UI |
| Package entry points | Root entry and subpaths declared in `package.json` |
| Local enforcement | Import-graph drift tests protect the no-runtime-dependencies and layer-direction rules |

The boundary is declared by `packages/agent-protocol/package.json`, `src/index.ts`, and the monorepo architecture rules. `src/index.ts` is the root entry. `/testing` and `/legacy` are explicit subpaths but are not re-exported from the root. Production code should not import protocol implementations through `/testing`.

## Main export surface

The package has many domain subpaths. This table lists the entries most relevant to Session and Run integrations. The complete list is in the `exports` field of [`package.json`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/package.json).

| Import | Main contract | Source |
| --- | --- | --- |
| `@duya/agent-protocol` | Cross-domain types, events, Manifest, Run APIs, errors, and pure protocol utilities | [`src/index.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/index.ts) |
| `@duya/agent-protocol/session-api` | Session records, create/update inputs, pagination, Timeline, and `HostSessionApiV1` | [`src/session-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/session-api.ts) |
| `@duya/agent-protocol/session-fork` | Session history fork inputs and results | [`src/session-fork.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/session-fork.ts) |
| `@duya/agent-protocol/rollout-events` | Persisted rollout events and read-cursor types | [`src/rollout-events.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/rollout-events.ts) |
| `@duya/agent-protocol/worker-protocol` | Command DTOs exchanged between Host and Worker | [`src/worker-protocol.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/worker-protocol.ts) |
| `@duya/agent-protocol/plugin-inventory` | Plugin capability inventory DTOs | [`src/plugin-inventory.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/plugin-inventory.ts) |
| `@duya/agent-protocol/plugin-setup` | Plugin setup and configuration contracts | [`src/plugin-setup.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/plugin-setup.ts) |
| `@duya/agent-protocol/bot-api` | Bot management API input, record, and result types | [`src/bot-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/bot-api.ts) |

Subpaths map to build outputs through `package.json` `exports`. Importing undeclared deep paths under `src/**` is not part of the package interface.

## Session API

`HostSessionApiV1` is an asynchronous service-boundary interface, not an HTTP client. It defines Session operations that a Host implementation must provide. Callers use the relevant Host adapter or client to invoke them.

The core shape is shown below; the exact parameters and result unions are declared in `src/session-api.ts`:

```ts
interface HostSessionApiV1 {
  create(input: HostSessionCreateInput): Promise<HostSessionRecord>;
  get(
    sessionId: SessionId,
    options?: { readonly includeAllSessions?: boolean },
  ): Promise<HostSessionRecord | null>;
  list(query?: HostSessionListQuery): Promise<HostSessionPage>;
  update(
    sessionId: SessionId,
    expectedUpdatedAt: Millis | undefined,
    patch: HostSessionPatch,
  ): Promise<HostSessionUpdateResult>;
  delete(sessionId: SessionId, expectedUpdatedAt?: Millis): Promise<HostSessionDeleteResult>;
  readMessages(sessionId: SessionId, query?: HostMessageReadQuery): Promise<HostMessagePage>;
  appendTimeline(sessionId: SessionId, input: HostTimelineAppendInput): Promise<HostTimelineWriteReceipt>;
}
```

The interface also covers search, archive/restore, forking, Timeline reads and writes, and rollout-index reconciliation. `HostSessionRecord` carries metadata such as the Session identity, Workspace binding, title, model/provider, permission mode, and parent/child relationship. Message history uses separate Timeline and rollout types.

### Workspace path constraints

Regular Session creation expresses location through `workspaceId`, `workspaceRootId`, and `workspaceRelativePath` relative to the Workspace root. The protocol comments state that raw filesystem paths must not cross this API. Path resolution, authorization, and root validation belong to the Host. Host-local import compatibility types are separate local-only interfaces and must not be treated as remote Session APIs.

### Concurrency and deletion

- `update` accepts `expectedUpdatedAt`, allowing the Host to check concurrent writes; callers should not assume unconditional replacement.
- `delete` is a soft-delete contract: the Host retains the row for recovery and audit.
- `archive` checks runtime locks; `unarchive` restores only the target Session, leaving descendants archived.
- `list` returns an opaque pagination `cursor`; callers must not parse or construct it.

## Runs, Manifest, and events

A Session is the context for ongoing work; each execution is represented by a separate Run. `HostRunApiV1` defines the Host boundary for Run records and events. `HostRunExecutionApiV1` defines execution controls such as start, cancel, live-event observation, and steering. These are contract interfaces and contain no Run scheduler implementation. Start and cancel are required methods; live-event observation and steering are optional capabilities.

Appending events and settling a terminal require a `RunAttemptFence`. The Host must reject writes from an attempt superseded by a newer one, so an old Worker cannot overwrite the current Run state. Live-event observation is an optional process-local stream; ephemeral events not written to the event ledger are exposed only through it. When `steerAgentRun` is absent, callers should keep the message and queue it for the next turn after the current Run settles.

The key data flow is:

1. The Host receives an execution intent and creates a Run.
2. The Host resolves and freezes a `RunManifest` with the Workspace, cwd, permission policy, capability snapshot, connector bindings, and configuration provenance. The Manifest carries no secrets.
3. The Runtime executes the Run and emits `RunEventEnvelope` values.
4. The Host receives events, persists those whose metadata requires durability, and settles the terminal state.

The Host creates and freezes the Manifest; the protocol defines its shape and `manifestFingerprint`. The Runtime generates Run event sequence numbers; the Session or UI client does not.

```ts
interface RunEventEnvelope<T extends RunEvent = RunEvent> {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly timestamp: EventTimestamp;
  readonly traceId: TraceId;
  readonly spanId?: SpanId;
  readonly parentRunId?: RunId;
  readonly payload: T;
}
```

`SEQ_CONTRACT` specifies that each Run starts at `1`, increments by `1`, and is sequenced by the Runtime. Event identity is `(runId, seq)`, not `(sessionId, seq)`. `EVENT_REGISTRY` provides event category and durability metadata; consumers should follow that metadata when persisting events. Unknown events must be ignored and must not be persisted. `hello`, `ready`, and `error` `ControlFrame` values are unnumbered control frames, not RunEvents.

## Protocol compatibility

Versioning has two independent axes: `PROTOCOL_MAJOR.MINOR` is the wire protocol version, while `PROTOCOL_SCHEMA_REVISION` tracks payload-shape changes. `isCompatible` hard-checks the protocol major. Events and control methods can also declare a minimum protocol version, minimum schema revision, and required Host capabilities through their gates. `negotiate` returns a refusal when a capability required by the Runtime is missing; it does not pretend to connect in a degraded mode.

When adding or changing a cross-boundary event or method, check `EVENT_META`, `CONTROL_GATE`, the schema revision, and both producer and consumer implementations. Version constants alone do not give an unregistered message a compatibility guarantee.

## Type-only usage example

This example shows how to depend on the Session service-boundary types. `@duya/agent-protocol` does not provide the `api` implementation or connect to a Host on its own:

```ts
import type { HostSessionApiV1, SessionId } from "@duya/agent-protocol";

export function readSession(api: HostSessionApiV1, id: SessionId) {
  return api.get(id);
}
```

An application should use the Host client or adapter provided by its layer. UI, Runtime, and external Plugins should not copy the Session persistence implementation.

## Source and contract checks

- Package exports: [`package.json`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/package.json) and [`src/index.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/index.ts)
- Session DTOs and interface: [`src/session-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/session-api.ts)
- Run boundary: [`src/run-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/run-api.ts)
- Event envelope and sequence rules: [`src/envelope.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/envelope.ts) and [`src/run-ledger.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/run-ledger.ts)
- Manifest: [`src/manifest.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/manifest.ts)
- Versioning and negotiation: [`src/version.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/version.ts) and [`src/compatibility.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/compatibility.ts)
- Event types and durability: [`src/events/registry.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/events/registry.ts)
- Package responsibilities and architecture constraints: [`packages/agent-protocol/AGENTS.md`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/AGENTS.md)
