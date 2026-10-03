# M5.1 — the slice inventory and the cut list

> Plan 587 [M5.1](../../exec-plans/active/587-agent-harness-monorepo/06-package-and-host-migration.md).
> This slice produces a MAP and a VERIFIER. It moves no code; M5.2 onwards does
> that. Every number below is re-derived from the tree by
> `scripts/architecture/import-graph.mjs` and checked on every `npm test` run.

## What is here, and what enforces it

| Artefact | Role | Enforced by |
| --- | --- | --- |
| `scripts/architecture/import-graph.mjs` | The graph resolver: type graph, value graph, host-import view, SCC members | `import-graph.test.ts` |
| `scripts/architecture/slice-classification.ts` | The per-file classification, the purity findings, the declared ports | `slice-classification.test.ts` |
| `scripts/architecture/slice-cut-list.ts` | The chosen value edges, and the edges deliberately NOT promised | `slice-cut-list.test.ts` |

`npm run architecture:slice-graph` prints the graph summary.

## 1. The classification

3232 source files walked under `apps/`, `packages/` and `evals/`. **2867
classified**, **365** under a stated exclusion. Zero files are unaccounted for:
the verifier fails on any file no rule claims and no exclusion explains.

| Category | Files | Where the rule lives | How the verifier keeps it true |
| --- | --- | --- | --- |
| `wire` | 55 | `slice-classification.ts` `RULES`, most-specific-first | per-category count + path fingerprint; dead-rule check |
| `pure` | 5 | same | same |
| `runtime-coordination` | 276 | same | same |
| `capability-adapter` | 1169 | same | same |
| `cp-durable` | 158 | same | same |
| `host-ui` | 1204 | same | same |

### Granularity, and why

The plan says a directory is an **inventory**, not a unit of work. So the unit
of classification is the directory plus explicit per-file overrides, and the
verifier expands it to every file.

- **Too fine rots.** A hand-maintained 3232-entry list is a list nobody
  updates, and a stale list is worse than none because it reads as coverage.
- **Too coarse cannot drive a cut.** "packages/agent is runtime" is true and
  useless; M5.2's first cut falls between `apps/desktop/src/main/control-plane`
  and `apps/desktop/src/main/db`, so the rules sit at that resolution.

A category is chosen by the **job the code does**, not the package it currently
lives in. That is what makes this a map to a cut rather than a description of a
tree that is about to change.

### The verifier is a test, not a script

`slice-classification.test.ts` runs on every `npm test` and fails when a file
is added, removed, or recategorised. All three were demonstrated:

| Perturbation | Caught by |
| --- | --- |
| add `packages/agent-core/src/_perturb-probe.ts` | 3 assertions (total, `pure` count, `pure` fingerprint) |
| remove `packages/agent-core/src/run-budget.ts` | 3 assertions (total, `pure` count, `pure` fingerprint) |
| recategorise `agent-core` `pure` → `capability-adapter` | 5 assertions, including the closed-vocabulary check catching the emptied `pure` bucket |

It also caught four rules written for directories that do not exist, and two
duplicate rules, during authoring. That is the check working, not a nuisance.

## 2. The graphs, exported

Measured on this tree, no `dist/` present:

| View | Count |
| --- | --- |
| Files walked | 3232 |
| Type edges (type-only included) | 7368 |
| **Value edges** (survive into emitted JS) | **6229** |
| Cross-package value edges | 177 |
| SCCs, type graph | 29 (largest 42, 23, 14, 12, 9) |
| SCCs, value graph | 15 (largest 20, 20, 9, 4, 3) |
| `workspace → host` value edges | 17 |
| `host → workspace` value edges | 121 |

The type/value split is the one genuinely new fact. Both existing audits count
an import as an edge whether it binds a type or a value — correct for a boundary
gate, wrong for a cut list. `import type` is erased by the compiler; removing
it changes no emitted JavaScript.

The classifier errs in **one** direction only: when it cannot tell, it says
`value`. A false `value` costs one cut-list entry to investigate; a false
`type` would let a migration delete a live runtime dependency. The value graph
is therefore a **superset** of the truth, and so is the cut list.

## 3. The cut list

An edge is on the list when removing it is a **precondition** for the target
architecture and one of these holds: (a) it points from a workspace package
into a host; (b) it is a host → workspace edge that exists only to reach a
**type** across the boundary; (c) it forces a package to exist at **runtime**
where only a type relationship is intended. Size is never a reason.

| Rank | Edge | Count | Why load-bearing |
| --- | --- | --- | --- |
| 1 | `pkg:agent → electron-main` | 15 | (a) Every edge starts in a **test** file. 14 reach `main/memory-state/migrations/*.sql.ts` from the agent `memory-state`/`memory-rollout` fixtures; 1 reaches `main/automation/{schedule,types}`. Host-owned state is owned by, or tested through, the agent package. Cheap: no production code moves. |
| 1 | `electron-main → src-renderer` | 33 | (b) The main process loading renderer modules as **values**. Not type-only, so a DTO alone does not remove all of them. |
| 2 | `electron-main → pkg:agent` | 91 | (c) The largest host → workspace value set. The **set** must shrink; several edges are legitimate host composition and are triaged individually in M5.2. |
| 2 | `src-renderer → electron-main` | 4 | (b) Renderer importing main-process modules. Already forbidden by policy as tolerated debt; entirely type-shaped in intent. |
| 3 | `electron-main → pkg:gateway` | 11 | (c) Direction is **correct** (the host owns the process). Listed because M5.5 consolidates these adapters behind ports, and may legitimately survive. |
| 3 | `evals → electron-main` | 2 | (a) **Found and deliberately kept.** The eval harness reaching into the main process is the measuring instrument; E4.1/E4.3 built it on purpose. |

### What this list refuses to promise

- **No SCC-shrink promise.** The 42- and 14-member SCCs are internal to
  `packages/agent`/`packages/ai`, are not cross-package value edges, and no M5.2
  cut moves their members. An SCC size is a property of a scan over the current
  file set, not a design goal.
- **No `cycle 16` promise.** That is a baseline fingerprint count; it moves when
  the **resolver** changes as much as when the code does.
- **No "all 91" promise.** The set must shrink, not vanish. A test asserting
  either figure is exactly the promise the plan forbids, so there is none.

## 4. Purity findings in `core` (recorded, not moved)

M5.1 §4 forbids a `core` input smuggling an IO function while claiming purity.
Three instances, verified by the test re-reading each cited line:

| Location | Declared layer | Evidence |
| --- | --- | --- |
| `packages/ai/src/api/ollama-chat.ts:329` | `core` | `await fetch(.../api/chat)` |
| `packages/ai/src/api/ollama-chat.ts:618` | `core` | `await fetch(.../api/embed)` |
| `packages/ai/src/api/bedrock-converse.ts:35` | `core` | `} from 'node:crypto';` |

`packages/ai` is declared layer `core` in `architecture-policy.yaml` but performs
network IO and Node crypto, so by the job test the inventory classifies it
`capability-adapter`. **That is a finding, not a relabelling**: the policy's
layer declaration and the code disagree, and M5.3 owns the fix.

`packages/agent-core` is clean — 5 source files, importing only
`@duya/agent-protocol`, data in and decision out. No IO-shaped inputs.

## 5. The declared ports

Declared, not extracted. Each names where the contract should live and what it
replaces, so M5.2 cuts against a decision rather than re-making it.

| Port | Target | Replaces |
| --- | --- | --- |
| `ModelClient` | `packages/agent-core/src` (port), `packages/ai` implements | `ai/src/types.ts` `AIClient`; 80 provider files |
| `ToolExecutor` | `packages/agent-core/src` (port) | `StreamingToolExecutor` + `ToolExecutionPipeline`, in the 42-member SCC |
| `ContextLoader` | `packages/agent-core/src` (port) | `packages/agent/src/context/` (fragment pure, watcher IO) |
| `TranscriptRepository` | `apps/desktop/src/main/control-plane` (port) | protocol owns the shape, host `db` owns storage |
| `PermissionBroker` | `apps/desktop/src/main/control-plane` (**already exists**) | `control-plane/permission-coordinator.ts`, 25KB |
| `Clock` | `packages/agent-core/src` (port) | implicit `Date.now()`, no seam |
| `Telemetry` | `packages/agent-runtime/src` (port) | `agent/src/observability`, no declared interface |
| `ProcessScope` | `packages/agent-runtime/src` (port) | `agent/src/utils/processTreeKill.ts`, called directly |
| `SecretResolver` | `apps/desktop/src/contracts` (port) | `apps/desktop/src/main/config`, read directly |

**Placement judgement.** `core` owns the port *interfaces* that `core` itself
consumes (Clock, ModelClient, ContextLoader, ToolExecutor) because a port is a
narrow input contract and putting it anywhere else either inverts the layer
order or forces `core` to import the host. Ports that only the Control Plane
consumes live with it. `SecretResolver` goes to `contracts` because it is a
Desktop DTO-shaped seam, not a runtime one. `apps/desktop/src/contracts` **does
not exist yet** — M5.2 creates it; this slice only fixes where it goes.

## 6. Unclassified, stated rather than hidden

365 files sit under exclusions that each carry a written reason in
`UNCLASSIFIED_PREFIXES`, and the verifier asserts the exclusion **count** so the
gap cannot silently shrink:

- 7 test directories (`packages/*/test(s)`, host `__tests__`) — fixtures, not
  migration targets. The regression anchor is the eval matrix, not these.
- `packages/agent/skills` — bundled skill **assets** (markdown plus scripts)
  the loader reads, not source. Classifying them by job would invent a seventh
  category.
- `evals/` — the measuring instrument, deliberately outside the map it checks.

`packages/ai/vitest.config.ts` is classified `capability-adapter` as the nearest
honest bucket; it is a runner config, not a capability, and the rule says so.

## 7. Known limitation, recorded not hidden

The inherited specifier regex has no alternative for a **bare side-effect
import** (`import './register.js'`), so it — like both existing audits — does
not match that form. Measured: zero occurrences in `packages/**` and `apps/**`.
Changing it here would make this resolver disagree with the counts the
architecture gate is baselined on, which is larger than M5.1 may do silently.
Asserted as-is in `import-graph.test.ts` so the day the form appears, the test
says the graph is now missing an edge.
