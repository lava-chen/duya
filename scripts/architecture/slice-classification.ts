/**
 * slice-classification.ts — the M5.1 per-file classification of the current
 * source tree.
 *
 * ## What this is
 *
 * Plan 587 M5.1 requires "当前源码逐文件分类：wire、pure、runtime coordination、
 * capability adapter、CP durable、host/UI；目录只作 inventory，不整体 mv". This
 * module is that classification, in code, so a machine can check it.
 *
 * ## How granular, and why
 *
 * The plan says a directory is an INVENTORY, not a unit of work. So the unit of
 * classification here is the DIRECTORY (plus explicit per-file exceptions), and
 * the verifier expands it to every file. Two reasons, both measured:
 *
 *  1. **Too fine rots.** At 3232 files, a hand-maintained per-file list is a
 *     list nobody updates, and a stale list is worse than none — it reads as
 *     coverage. The E4.2 behaviour matrix is the precedent that works: 56 rows
 *     of real claims, each verified against the repo, at the granularity where
 *     a claim is actually made.
 *  2. **Too coarse cannot drive a cut.** "packages/agent is runtime" is true and
 *     useless. The cut list needs `apps/desktop/src/main/control-plane` to be
 *     separable from `apps/desktop/src/main/db`, so the rules go at the level
 *     where M5.2's first cut actually falls.
 *
 * So: directory rules, most-specific-first, with a per-file exception list for
 * the mixed barrels. The verifier fails when a file is added (no rule matches),
 * removed (a rule matches nothing), or recategorised (the expected-category
 * fingerprint moves).
 *
 * ## Why the categories are these six
 *
 * They are the plan's own words, and they are a partition of the TARGET
 * architecture in `00-contracts.md` §A, not of today's packages. A file is
 * classified by the JOB it does, not by the package it currently lives in —
 * which is what makes the inventory a map to a cut rather than a description of
 * a tree that is about to change.
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// TWO levels up, not three: this file sits in `scripts/architecture/`, which is
// two directories below the repo root. `../..` matches `import-graph.mjs`; the
// extra `..` climbed into `.claude/worktrees` and the inventory silently
// classified zero files.
export const REPO_ROOT = path.resolve(HERE, '../..');

/**
 * The six categories, closed.
 *
 * Closed on purpose: an open vocabulary is how a classification quietly grows a
 * seventh bucket that means "we did not know", and a bucket that means "we did
 * not know" is the same failure the plan warns about when it says an unproven
 * capability must be reported as unsupported rather than claimed.
 */
export const CATEGORIES = [
  'wire',
  'pure',
  'runtime-coordination',
  'capability-adapter',
  'cp-durable',
  'host-ui',
] as const;

export type Category = (typeof CATEGORIES)[number];

/**
 * A rule: a path PREFIX (never a glob) and the category every file under it
 * holds. Prefixes only, because a glob is a place to hide an accident — a
 * `**` can silently widen. Most specific first; first match wins.
 */
export interface ClassificationRule {
  readonly prefix: string;
  readonly category: Category;
  /** Why this directory is what it is. Required — a rule with no reason rots. */
  readonly why: string;
}

/**
 * The rules, most specific first.
 *
 * Ordering is load-bearing and the verifier checks it: a broader rule above a
 * narrower one makes the narrower one dead, and a dead rule is a lie.
 *
 * The precise invariant, because the precise one is the one that bites: a rule
 * must come before ANY rule whose prefix contains it, not merely before its
 * immediate neighbour. `classify` returns the first match, so a broader rule
 * anywhere above a narrower one claims every file the narrower rule was written
 * to describe. The section headers below group rules by category for reading;
 * they do not override this.
 */
export const RULES: readonly ClassificationRule[] = [
  // ── exceptions to the wire rule ─────────────────────────────────────────
  // These three carve one file and two directories OUT of the
  // `packages/agent-protocol/src` rule at the head of the wire section, so they
  // have to precede it. Their position is load-bearing rather than stylistic:
  // below that rule they are unreachable, and each `why` states a classification
  // the map does not actually apply. This is the case the dead-rule check missed,
  // because it only reported a shadowed rule when the two were adjacent and these
  // sat 14 slots below.
  {
    prefix: 'packages/agent-protocol/src/codecs.ts',
    category: 'pure',
    why: 'Encode/decode is a total function over data — no IO, no clock, no ambient state. Wire because it defines the wire format, pure because performing it touches nothing. A FILE, not a directory.',
  },
  {
    prefix: 'packages/agent-protocol/src/transcript',
    category: 'runtime-coordination',
    why: 'EXCEPTION to the wire rule below, and deliberately so. The transcript vocabulary is wire DATA, but its transformation functions (compaction transforms, projection) are pure algorithms over it. M5.3 splits these; until then the rule keeps the directory whole and says so.',
  },
  {
    prefix: 'packages/agent-protocol/src/events',
    category: 'runtime-coordination',
    why: 'EXCEPTION to the wire rule below. The event REGISTRY is wire metadata, but `verdictForUnknownType` and the criticality boundary are decisions about how to handle an event at runtime.',
  },

  // ── wire ────────────────────────────────────────────────────────────────
  // The protocol package is the single owner of the wire vocabulary (T3.1).
  {
    prefix: 'packages/agent-protocol/src',
    category: 'wire',
    why: 'Owns the wire vocabulary: envelopes, events, transcript types, codec. Zero IO by policy `forbidden-dependency`, and it is the only leaf everything else may depend on.',
  },
  {
    prefix: 'apps/desktop/src/preload',
    category: 'wire',
    why: 'The preload bridge is the renderer-facing half of the host IPC contract: it is a boundary, not a domain.',
  },
  {
    prefix: 'apps/desktop/src/contracts',
    category: 'wire',
    why: 'The host contract vocabulary, and the prediction the `renderer/types` rule above made in M5.1: "Candidates for `apps/desktop/src/contracts` once a second consumer exists (00-contracts.md §A)." Plan 587 M5.2 is that second consumer. `main/ipc/git-types.ts` and `renderer/types/import.ts` moved here so the main process, the preload bridge and the renderer can share a type without any of them importing another. Wire because that is what it is by function — a boundary vocabulary, not domain logic — and `contracts-boundary.test.ts` fails if it ever gains a value, an `electron` import, or a host import.',
  },
  {
    prefix: 'apps/desktop/src/renderer/types',
    category: 'wire',
    why: 'Renderer-side DTO shapes. M5.1 recorded these as "candidates for `apps/desktop/src/contracts` once a second consumer exists"; M5.2 moved `import.ts` there for exactly that reason. What is left here is renderer-only vocabulary with no second consumer yet.',
  },
  {
    prefix: 'apps/desktop/src/renderer/data',
    category: 'wire',
    why: 'Renderer transport shapes and the fetch layer that speaks them.',
  },
  // Ahead of the broader `memory-state` rule below it carves out of, for the
  // reachability reason stated at the head of RULES.
  {
    prefix: 'apps/desktop/src/main/memory-state/migrations',
    category: 'cp-durable',
    why: 'EXCEPTION and a genuine ownership defect. SQL migrations live in the HOST but are owned by `packages/agent/src/memory-state`. M5.2 moves the owner; until then the rule records the host location and the mis-ownership.',
  },
  {
    prefix: 'apps/desktop/src/main/memory-state',
    category: 'cp-durable',
    why: 'EXCEPTION to the host rule, and a real ownership finding. The memory-state STORE lives in the host but is owned by `packages/agent/src/memory-state`, and 14 of the 16 agent->main edges land here. M5.2 moves the owner.',
  },
  {
    prefix: 'packages/agent/src/channels',
    category: 'wire',
    why: 'Channel address and prompt shapes: the identity an external channel carries, which 00-contracts.md §B keeps distinct from sessionId.',
  },
  {
    prefix: 'packages/agent/src/constants',
    category: 'wire',
    why: 'Constants every layer must agree on. Wire because a disagreement here is a protocol disagreement.',
  },
  {
    prefix: 'packages/agent/src/ipc',
    category: 'wire',
    why: 'The IPC contract the host speaks to the run layer, plus the db client that carries it.',
  },
  {
    prefix: 'packages/agent/src/types',
    category: 'wire',
    why: 'Agent type vocabulary consumed across the run boundary. Holds a single ambient declaration today; the rule exists so a type added here is classified by the job its directory does.',
  },
  {
    prefix: 'packages/agent/src/types.ts',
    category: 'wire',
    why: 'The 36KB agent type barrel — a FILE beside the `types/` directory, which is why it needs its own rule. It also holds the deprecated transcript re-export T3.1 left with a registered removal task.',
  },
  {
    prefix: 'packages/agent/src/index.ts',
    category: 'wire',
    why: 'The public barrel of `@duya/agent`: the agent constructor plus the type surface the desktop renderer and library callers consume. A published surface is wire by function.',
  },
  {
    prefix: 'packages/agent/src/agent-profile',
    category: 'runtime-coordination',
    why: 'Profile RESOLUTION: reads bot config, filters toolsets, composes an effective profile. The `types.ts` in this directory is wire vocabulary and the service that builds it coordinates; the directory is classified as a whole until M5.3 splits it.',
  },

  // ── pure ─────────────────────────────────────────────────────────────────
  {
    prefix: 'packages/agent-core/src',
    category: 'pure',
    why: 'Terminal-state resolution, budget accounting, durability policy, capability negotiation. Data in, decision out. Verified clean: imports only `@duya/agent-protocol`.',
  },

  // ── runtime coordination ────────────────────────────────────────────────
  {
    prefix: 'packages/agent-runtime/src',
    category: 'runtime-coordination',
    why: 'The run execution engine: transports, event emission, replay cursors, backpressure, control channels. Async coordination with no host dependency.',
  },
  {
    prefix: 'packages/agent/src/agent',
    category: 'runtime-coordination',
    why: 'Turn assembly, stream running, event dispatch, finalization, permission gating. The run loop, and the single largest mixed barrel in the tree.',
  },
  {
    prefix: 'packages/agent/src/compact',
    category: 'runtime-coordination',
    why: 'Context compaction transforms. The ALGORITHMS are pure and are M5.3 targets; the coordinator that calls the model is not, so the directory stays runtime until it is split.',
  },
  {
    prefix: 'packages/agent/src/session',
    category: 'runtime-coordination',
    why: 'Session state transitions and the turn loop bookkeeping that drives them.',
  },
  {
    prefix: 'packages/agent/src/queue',
    category: 'runtime-coordination',
    why: 'Backpressure and queueing. Coordination with no capability of its own.',
  },
  {
    prefix: 'packages/agent/src/abort',
    category: 'runtime-coordination',
    why: 'Cancellation and cooperative-stop signalling.',
  },
  {
    prefix: 'packages/agent/src/lifecycle',
    category: 'runtime-coordination',
    why: 'Run lifecycle transitions.',
  },
  {
    prefix: 'packages/agent/src/observability',
    category: 'runtime-coordination',
    why: 'Run-scoped telemetry emission. The PORT is runtime; the sink is an adapter.',
  },
  {
    prefix: 'packages/agent/src/process',
    category: 'runtime-coordination',
    why: 'The child-process run loop and its workflow runtime. Coordination over a spawned child; the spawn itself is a capability adapter (see `utils/processTreeKill`).',
  },
  {
    prefix: 'packages/agent/src/message',
    category: 'runtime-coordination',
    why: 'EXCEPTION worth stating. Message CONVERSION is pure and is the first M5.3 target; the compaction controller and mailbox attachment context coordinate real work. Whole directory stays runtime until split.',
  },
  {
    prefix: 'packages/agent/src/decisions',
    category: 'runtime-coordination',
    why: 'Model fallback and calibration decisions made DURING a run. The decision functions are pure; the service that reaches a provider is not.',
  },
  {
    prefix: 'packages/agent/src/config',
    category: 'runtime-coordination',
    why: 'Agent-side configuration resolution: feature flags, cache config, tool exposure. Read once per run and folded into the manifest.',
  },
  {
    prefix: 'packages/agent/src/mentions',
    category: 'runtime-coordination',
    why: 'Mention resolution against the live session context. Reads state, so it is coordination rather than a pure transform.',
  },
  {
    prefix: 'packages/agent/src/wake',
    category: 'runtime-coordination',
    why: 'Agent-side wake scheduling and its store. Pairs with the host wake directory; both coordinate a timed trigger.',
  },
  // Ahead of the broader `agents` rule below it carves out of, for the
  // reachability reason stated at the head of RULES. Both carry the same
  // category, so the ordering costs nothing and makes the rules reachable.
  {
    prefix: 'apps/desktop/src/main/agents/server',
    category: 'runtime-coordination',
    why: 'The agent server: hosts the runtime, dispatches commands, relays events. Coordination, not a capability.',
  },
  {
    prefix: 'apps/desktop/src/main/agents/process-pool',
    category: 'runtime-coordination',
    why: 'Pool scheduling for agent child processes. The pool decides; each worker is an adapter.',
  },
  {
    prefix: 'apps/desktop/src/main/agents',
    category: 'runtime-coordination',
    why: 'Host-side agent session management, server lifecycle and the db bridge. The `server/` and `process-pool/` subdirectories have their own narrower rules above.',
  },
  {
    prefix: 'apps/desktop/src/main/index.ts',
    category: 'runtime-coordination',
    why: 'Main-process entry: wires the runtime and its adapters together. Composition, which is coordination by function.',
  },
  {
    prefix: 'apps/desktop/src/main/channels',
    category: 'runtime-coordination',
    why: 'Inbound channel multiplexing and envelope routing between the gateway and the run layer.',
  },
  {
    prefix: 'apps/desktop/src/main/wake',
    category: 'runtime-coordination',
    why: 'Wake scheduling and the channel store that feeds it.',
  },

  // ── capability adapter ──────────────────────────────────────────────────
  {
    prefix: 'packages/agent/src/tool',
    category: 'capability-adapter',
    why: 'Tool implementations. Each one WRAPS a capability (FS, process, network, browser) and is the thing a ToolExecutor port must be able to stand in for.',
  },
  {
    prefix: 'packages/agent/src/hooks',
    category: 'capability-adapter',
    why: 'Hook execution and hook-provided capabilities. Part of the 42-member SCC: the hooks cluster and the tool cluster are mutually recursive.',
  },
  {
    prefix: 'packages/agent/src/mcp',
    category: 'capability-adapter',
    why: 'MCP client transport and server wiring. A network capability adapter.',
  },
  {
    prefix: 'packages/agent/src/skills',
    category: 'capability-adapter',
    why: 'Skill discovery and loading. Wraps the filesystem; the loader path is an adapter concern (00-contracts.md §H).',
  },
  {
    prefix: 'packages/agent/src/context',
    category: 'capability-adapter',
    why: 'OS-context fragments and the file WATCHER. The projection is pure; the scan-and-watch half is IO and keeps the directory here.',
  },
  {
    prefix: 'packages/agent/src/providers',
    category: 'capability-adapter',
    why: 'Provider client construction. The ModelClient port must be satisfiable without importing any of this.',
  },
  {
    prefix: 'packages/agent/src/sandbox',
    category: 'capability-adapter',
    why: 'Sandbox enforcement. A capability by definition, and the reason Trust UI may not claim sandboxing until escape tests pass (00-contracts.md §E).',
  },
  {
    prefix: 'packages/agent/src/security',
    category: 'capability-adapter',
    why: 'Path containment and secret hygiene primitives over real IO.',
  },
  {
    prefix: 'packages/agent/src/agentsmd',
    category: 'capability-adapter',
    why: 'AGENTS.md discovery and loading. Filesystem capability, with pure parsing inside it.',
  },
  {
    prefix: 'packages/agent/src/prompts',
    category: 'capability-adapter',
    why: 'EXCEPTION worth stating. Template RENDERING is pure (M5.3 moves it to core); the Hbs asset loader and directory scan are IO. Whole directory stays adapter until split.',
  },
  {
    prefix: 'packages/agent/src/modes',
    category: 'capability-adapter',
    why: 'Mode declaration and registry. The state reducer is pure (M5.3); the tools and hooks a mode contributes are adapter work.',
  },
  {
    prefix: 'packages/agent/src/journal',
    category: 'capability-adapter',
    why: 'Durable journal writes. Persistence is a capability; the CP owns the decision of what is durable.',
  },
  {
    prefix: 'packages/agent/src/memory-state',
    category: 'capability-adapter',
    why: 'SQLite-backed memory state. A storage capability, and the target of the 16 main-boundary test edges (M5.2).',
  },
  {
    prefix: 'packages/agent/src/memory-rollout',
    category: 'capability-adapter',
    why: 'Memory extraction and rollout, driven by real model calls and real storage.',
  },
  {
    prefix: 'packages/ai/src',
    category: 'capability-adapter',
    why: 'FINDING, not a clean fit. Policy layers call `ai` `core`, but these files do network `fetch` and `node:crypto` (see `PURE_VIOLATIONS`), so by the JOB test they are adapters. Recorded rather than quietly relabelled.',
  },
  {
    prefix: 'packages/ai/scripts',
    category: 'capability-adapter',
    why: 'Model catalogue generation scripts. Build-time capability, not runtime code.',
  },
  {
    prefix: 'packages/ai/vitest.config.ts',
    category: 'capability-adapter',
    why: 'A test runner configuration, classified with the package it configures so the inventory has no unexplained file. It is not itself a capability; the prefix is the nearest honest bucket.',
  },
  {
    prefix: 'packages/plugin-core/src',
    category: 'capability-adapter',
    why: 'Connector, MCP and marketplace machinery. Every real integration lives behind an adapter here.',
  },
  {
    prefix: 'packages/computer-use/src',
    category: 'capability-adapter',
    why: 'OS-level input, screen capture and automation backends. A capability in the most literal sense.',
  },
  {
    prefix: 'packages/voice/src',
    category: 'capability-adapter',
    why: 'STT/TTS providers and their process management. Audio devices plus child processes.',
  },
  {
    prefix: 'apps/desktop/src/main/services',
    category: 'capability-adapter',
    why: 'Host-side capability implementations: browser control, app connections, providers, network, voice, recording.',
  },
  {
    prefix: 'apps/desktop/src/main/skills',
    category: 'capability-adapter',
    why: 'Host-side skill installation and file IO.',
  },
  {
    prefix: 'apps/desktop/src/main/plugins',
    category: 'capability-adapter',
    why: 'Plugin install, cache and marketplace client. Filesystem and network.',
  },
  {
    prefix: 'apps/desktop/src/main/import',
    category: 'capability-adapter',
    why: 'Import scanner and writer. Filesystem capability over data a user already has on disk.',
  },
  {
    prefix: 'apps/desktop/src/main/config',
    category: 'capability-adapter',
    why: 'Private config read/write and secret storage. The host implementation of the SecretResolver port lives here.',
  },
  {
    prefix: 'apps/desktop/src/main/memory',
    category: 'capability-adapter',
    why: 'Host-side memory service over the memory-state store.',
  },
  {
    prefix: 'packages/agent/src/utils',
    category: 'capability-adapter',
    why: 'Host and OS utilities: process-tree kill, attachment IO, image handling. The reason the whole directory is adapter and not `pure` is `processTreeKill.ts`.',
  },

  // ── cp durable ──────────────────────────────────────────────────────────
  {
    prefix: 'apps/desktop/src/main/control-plane',
    category: 'cp-durable',
    why: 'THE Control Plane. Run persistence decisions, manifest binding, permission coordination, durable receipts. Plan 00 §A puts it at `apps/desktop/src/main/control-plane`, which is where it already is.',
  },
  {
    prefix: 'apps/desktop/src/main/db',
    category: 'cp-durable',
    why: 'SQLite access and migrations. Storage is CP-owned; the store is the durable substrate the CAS rules write through.',
  },
  {
    prefix: 'apps/desktop/src/main/project-database',
    category: 'cp-durable',
    why: 'Per-project database access. Same durable substrate, separate database.',
  },
  {
    prefix: 'apps/desktop/src/main/automation',
    category: 'cp-durable',
    why: 'Schedule ownership and automation persistence. The 16 agent->main edges in M5.2 end here.',
  },
  {
    prefix: 'packages/agent/src/permissions',
    category: 'cp-durable',
    why: 'EXCEPTION worth stating. Policy evaluation is a pure decision and belongs in core; the GRANT is durable and belongs to CP. Whole directory classified CP until M5.3 splits the two halves.',
  },

  // ── host/UI ─────────────────────────────────────────────────────────────
  {
    prefix: 'apps/desktop/src/renderer',
    category: 'host-ui',
    why: 'React renderer: components, hooks, stores, orb, styles. UI, and the reason 53 main->renderer edges are a defect rather than a design.',
  },
  {
    prefix: 'apps/desktop/src/main/ipc',
    category: 'host-ui',
    why: 'IPC surface: handlers, channels, schema validation. Host transport, with no domain decisions of its own.',
  },
  {
    prefix: 'apps/desktop/src/main/gateway',
    category: 'host-ui',
    why: 'Gateway process supervision and config events. Host transport wiring.',
  },
  {
    prefix: 'apps/desktop/src/main/conductor',
    category: 'host-ui',
    why: 'Conductor layout and workbench host services. Presentation-side host state.',
  },
  {
    prefix: 'apps/desktop/src/main/messaging',
    category: 'host-ui',
    why: 'Chat message assembly for the UI. Presentation concern.',
  },
  {
    prefix: 'apps/desktop/src/main/core',
    category: 'host-ui',
    why: 'Host core services and their shared helpers. Host-internal, not CP-durable.',
  },
  {
    prefix: 'apps/desktop/src/main/lib',
    category: 'host-ui',
    why: 'Host shared library helpers.',
  },
  {
    prefix: 'apps/desktop/src/main/logging',
    category: 'host-ui',
    why: 'The Desktop logger. Host infrastructure by 00-contracts.md §A; runtime must not import it.',
  },
  {
    prefix: 'apps/desktop/src/main/types',
    category: 'host-ui',
    why: 'Host type declarations. Candidates for `apps/desktop/src/contracts`.',
  },
  {
    prefix: 'apps/desktop/src/main/cli',
    category: 'host-ui',
    why: 'Main-process CLI command handling. Host surface, and an M5.2 consumer of the runtime rather than a provider to it.',
  },
  {
    prefix: 'apps/desktop/src/main/utils',
    category: 'host-ui',
    why: 'Host utilities.',
  },
  {
    prefix: 'packages/agent/src/cli',
    category: 'host-ui',
    why: 'The agent CLI surface: pure command descriptors mixed with the runner that builds an agent. M5.2 splits them; the whole directory is host-facing today.',
  },
  {
    prefix: 'packages/gateway/src',
    category: 'host-ui',
    why: 'Channel adapters (Feishu, Weixin) and their transports. Host-bound integration surfaces.',
  },
  {
    prefix: 'packages/conductor/src',
    category: 'host-ui',
    why: 'Conductor canvas UI and its renderer components. UI in a workspace package, which is why 23 renderer->conductor deep imports exist.',
  },
  {
    prefix: 'packages/cli/src',
    category: 'host-ui',
    why: 'CLI commands. M5.2 splits the pure descriptor from the runner that constructs an agent.',
  },
];

/**
 * Per-file exceptions, applied AFTER the rules.
 *
 * Needed because a few individual files are the opposite of their directory.
 * Each one states why, so a reader can tell a real exception from a typo.
 */
export const FILE_OVERRIDES: Readonly<Record<string, Category>> = {
  // The run loop's own barrel: re-exports the turn machinery, so it reads as
  // coordination even though it holds no algorithm.
  'packages/agent/src/agent/index.ts': 'runtime-coordination',
  // Agent types are wire-shaped vocabulary consumed across the run boundary.
  'packages/agent/src/types/index.ts': 'wire',
  'packages/agent/src/types/agent.ts': 'wire',
  // Constants are the values every layer must agree on.
  'packages/agent/src/constants/index.ts': 'wire',
  // The IPC contract the host speaks to the run layer.
  'packages/agent/src/ipc/index.ts': 'wire',
  'packages/agent/src/ipc/protocol.ts': 'wire',
};

/**
 * Directories deliberately NOT classified, with the reason.
 *
 * The plan requires an unproven capability to be reported as unsupported rather
 * than claimed, and an unclassified file must be visible rather than hidden. A
 * file under one of these prefixes makes the verifier FAIL, so the gap is
 * loud and has to be closed deliberately.
 *
 * ONE CONSTRAINT ON WHAT CAN GO HERE, because it is not a matter of taste. A
 * prefix is only ever consulted for a file no RULE claims — that is the single
 * place `isUnclassifiedPrefix` is asked. So a prefix nested inside a classified
 * directory is unreachable however many files it holds: the broader rule claims
 * them first, and the exclusion quietly describes nothing.
 *
 * Three were exactly that and have been removed: `main/agents/tests`,
 * `main/agents/__tests__` and `renderer/components/__tests__` all held real
 * files and none could ever be excluded, because `main/agents` and `renderer`
 * are classified directories. The convention that follows is the tree's actual
 * one and is now the whole rule: a `__tests__` directory under a classified
 * directory is classified WITH it. That is why the sixty-odd `__tests__`
 * directories under `apps/desktop/src` are in the census, and why
 * `main/__tests__` is the only live host exclusion — no rule claims bare
 * `apps/desktop/src/main`.
 */
export const UNCLASSIFIED_PREFIXES: readonly { prefix: string; why: string }[] = [
  {
    prefix: 'packages/agent/tests',
    why: 'Test fixtures for the legacy agent suite. The regression anchor for the migration is the eval matrix, not this suite; classifying fixtures would add ~200 files that no cut touches.',
  },
  {
    prefix: 'packages/agent-core/test',
    why: 'Tests for the pure island. They test `pure` code but are not `pure` code, and no cut moves them.',
  },
  {
    prefix: 'packages/agent-protocol/test',
    why: 'Protocol contract tests. These are the wire package\'s own gates; they assert the vocabulary rather than being it.',
  },
  {
    prefix: 'packages/agent-runtime/test',
    why: 'Runtime tests. Same reasoning as the agent suite.',
  },
  {
    prefix: 'packages/ai/test',
    why: 'Provider client tests. Same reasoning.',
  },
  {
    prefix: 'packages/plugin-core/tests',
    why: 'Plugin-core tests. Same reasoning.',
  },
  {
    prefix: 'packages/voice/tests',
    why: 'Voice tests. Same reasoning.',
  },
  {
    prefix: 'packages/agent/skills',
    why: 'Bundled skill ASSETS (markdown plus scripts), not source. They ship as files the loader reads, so classifying them by job would be inventing a seventh category.',
  },
  {
    prefix: 'apps/desktop/src/main/__tests__',
    why: 'Host tests. Same reasoning as the agent suite.',
  },

  {
    prefix: 'evals',
    why: 'The eval harness. It is the REGRESSION ANCHOR for M5, so it is deliberately outside the map it is used to check — classifying the measuring instrument alongside the measured is how the two get confused.',
  },
];

/**
 * Purity violations found while classifying, recorded rather than fixed.
 *
 * M5.1 §4: "禁止 core 输入中藏 IO 函数却宣称纯". These are the cases where a
 * module the policy calls `core` performs IO. They are findings: this slice
 * produces a map, and moving them is M5.3's work.
 *
 * ── M5.3 update: the layer declaration was wrong, so the declaration is fixed
 *    and the finding is retired at its cause.
 *
 * M5.1 recorded these three as "`ai` is declared layer `core`, therefore IO in
 * `ai` is a violation by definition". M5.3 measured the package and reached a
 * different conclusion: `ai` is genuinely core-SHAPED (see the long note at
 * `architecture-policy.yaml`'s `core` line — the two packages that actually
 * carry the contract, `agent-protocol` and `agent-core`, import nothing from
 * it at all), and what was actually missing was not a re-label but a GATE.
 *
 * So `declaredLayer` below no longer reads `core`: these files are inside a
 * package whose core-declared half is pure, and they are the declared
 * capability carve-out inside it. They are still listed here, still re-read at
 * their cited lines by `slice-classification.test.ts`, and still inventoried in
 * `layer-purity.ts` `CORE_MODULES` — so the evidence stays live and checked.
 *
 * What changed is that the next one cannot be added silently: `layer-purity.ts`
 * fails on any IO site in a `core` root that is not in its carve-out.
 */
export interface PurityViolation {
  readonly file: string;
  readonly line: number;
  readonly declaredLayer: string;
  readonly evidence: string;
  readonly why: string;
}

export const PURE_VIOLATIONS: readonly PurityViolation[] = [
  {
    file: 'packages/ai/src/api/ollama-chat.ts',
    line: 329,
    declaredLayer: 'capability carve-out inside legacy-ai (architecture-policy.yaml layers)',
    evidence: "await fetch(`${this.baseURL}/api/chat`, {",
    why: 'A network call inside a core-declared package. NOT relabelled: see the `core` note in architecture-policy.yaml. This file should take an injected transport — the pattern already exists twice in the same package (system-one/client.ts:166 and api/google-generative-ai.ts:398 both resolve a `fetch` default into an injectable seam).',
  },
  {
    file: 'packages/ai/src/api/ollama-chat.ts',
    line: 618,
    declaredLayer: 'capability carve-out inside legacy-ai (architecture-policy.yaml layers)',
    evidence: "const response = await fetch(`${this.baseURL}/api/embed`, {",
    why: 'Second network call in the same file; a separate capability from the chat completion, and the same injected-transport fix covers both.',
  },
  {
    file: 'packages/ai/src/api/bedrock-converse.ts',
    line: 35,
    declaredLayer: 'capability carve-out inside legacy-ai (architecture-policy.yaml layers)',
    evidence: "} from 'node:crypto';",
    why: 'A `core`-shaped module importing a Node builtin. Lazy-loaded at line 69, so the renderer can import this file — the import is still a coupling, and the laziness defers the load without removing it. NOTE the `import type` on this line is erased at compile time and is NOT itself a capability; `layer-purity.ts` skips type-only imports for exactly this reason and flags the real `require` at line 69 instead.',
  },
];

/**
 * The narrow ports M5.1 names, and where each one lives now.
 *
 * Declared, not extracted: this slice produces a map. Each entry says where the
 * port's contract should live and what it replaces, so M5.2 can cut against it
 * without re-deciding the placement.
 */
export interface PortDeclaration {
  readonly name: string;
  readonly method: string;
  readonly target: string;
  readonly now: string;
}

export const PORTS: readonly PortDeclaration[] = [
  {
    name: 'ModelClient',
    method: 'interface',
    target: 'packages/agent-core/src (port) implemented by packages/ai',
    now: 'packages/ai/src/types.ts `AIClient`; 147 files, 80 provider files',
  },
  {
    name: 'ToolExecutor',
    method: 'interface',
    target: 'packages/agent-core/src (port); registry stays runtime-coordination',
    now: 'packages/agent/src/tool/StreamingToolExecutor.ts + ToolExecutionPipeline.ts, in the 42-member SCC',
  },
  {
    name: 'ContextLoader',
    method: 'interface',
    target: 'packages/agent-core/src (port); loader and watcher stay capability adapters',
    now: 'packages/agent/src/context/ (fragment.ts pure, watcher.ts IO)',
  },
  {
    name: 'TranscriptRepository',
    method: 'interface',
    target: 'apps/desktop/src/main/control-plane (port), SQLite implements',
    now: 'still undeclared: packages/agent-protocol/src/transcript owns the shape, host db owns the storage (run-store.ts, message-log.ts). C6.1 landed a host port in `main/control-plane/repository-port.ts` and it declares five surfaces — Run, Artefact, Approval, GoalTask, CheckpointIndex — none of them a transcript one.',
  },
  {
    name: 'PermissionBroker',
    method: 'interface',
    target: 'apps/desktop/src/main/control-plane (already exists as permission-coordinator.ts)',
    now: 'apps/desktop/src/main/control-plane/permission-coordinator.ts, 25KB',
  },
  {
    name: 'Clock',
    method: 'interface',
    target: 'packages/agent-core/src (port); tests inject virtual time',
    now: 'implicit: Date.now() at call sites, no seam (00-contracts.md §D)',
  },
  {
    name: 'Telemetry',
    method: 'interface',
    target: 'packages/agent-runtime/src (port); sink is a host adapter',
    now: 'packages/agent/src/observability, no declared interface',
  },
  {
    name: 'ProcessScope',
    method: 'interface',
    target: 'packages/agent-runtime/src (port); BashWorker/worker pool reuse it',
    now: 'EXTRACTED to packages/agent-runtime/src/process/process-scope.ts (M5.5), which owns the bookkeeping and takes the kill strategy as an injected `ProcessTreeKiller`. `agent/src/utils/processTreeKill.ts` stays as that implementation by decision and is still called directly by three sites: session/bash-task-registry.ts, tool/WorkerPool.ts, tool/BashTool/managed-bash.ts.',
  },
  {
    name: 'SecretResolver',
    method: 'interface',
    target: 'apps/desktop/src/main/contracts (port); private config implements',
    now: 'apps/desktop/src/main/config, read directly by callers',
  },
];

/** Resolve a repo-relative path to its category, or null if unclassified. */
export function classify(relPath: string): Category | null {
  const posix = relPath.split(path.sep).join('/');
  if (FILE_OVERRIDES[posix] !== undefined) return FILE_OVERRIDES[posix];
  for (const rule of RULES) {
    if (posix === rule.prefix || posix.startsWith(`${rule.prefix}/`)) return rule.category;
  }
  return null;
}

/** Is this path under a deliberately-unclassified prefix? */
export function isUnclassifiedPrefix(relPath: string): boolean {
  const posix = relPath.split(path.sep).join('/');
  return UNCLASSIFIED_PREFIXES.some(
    (u) => posix === u.prefix || posix.startsWith(`${u.prefix}/`),
  );
}
