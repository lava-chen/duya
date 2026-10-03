/**
 * The closed event registry.
 *
 * This is the TypeScript answer to grok-build's `define_methods!` macro.
 * Rust can generate a union from one list; TypeScript cannot generate a type,
 * so the single source of truth is the `RunEventPayloads` INTERFACE in
 * payloads.ts and this module derives everything else from `keyof` it.
 *
 * ## Why specs and registry are separate files
 *
 * Because the registry must have ZERO runtime imports. If `registry.ts`
 * imported payload VALUES it would pull the whole payload graph into every
 * consumer of the registry, and drift test #1 鈥?"the registry must not import
 * anything at runtime" 鈥?would be unassertable. Everything it needs from
 * payloads.ts arrives as `import type`, which the compiler erases.
 *
 * ## Three properties this buys
 *
 *  1. `RunEvent` is derived, so adding a key to `RunEventPayloads` widens the
 *     union and every exhaustive `switch` becomes a compile error.
 *  2. `EVENT_META` is typed `{ [K in EventType]: EventMeta }`, so a payload
 *     without metadata AND metadata without a payload are both compile errors.
 *  3. `Durability` is a machine-readable field on every event, where
 *     pi-protocol states the same rule in prose ("Progress events are transient
 *     UI hints and must not be reduced into authoritative state"). Prose does
 *     not fail a build; a field does.
 */

import type { RunEventPayloads } from './payloads.js';
import type { MessageGate } from '../compatibility.js';

export type EventType = keyof RunEventPayloads;

/** The derived union. `type` is the discriminant; the payload is attached. */
export type RunEvent = {
  [K in EventType]: { readonly type: K } & RunEventPayloads[K];
}[EventType];

/** Unknown-event carrier. `fromEnvelope` NEVER throws; it returns
 *  this instead so an old host can meet a new runtime. An unknown event is
 *  therefore never durable and is never persisted. */
export interface UnknownRunEvent {
  readonly kind: 'unknown';
  readonly type: string;
  readonly raw: unknown;
}

export type DecodedEvent = RunEvent | UnknownRunEvent;

/** D = durable (persisted, participates in transcript reconstruction)
 *  V = volatile (in-memory replay ring, not written to disk)
 *  E = ephemeral (stream-only, never stored) */
export type Durability = 'durable' | 'volatile' | 'ephemeral';

/** Classification only. grok-build keeps its method enum FLAT and leaves
 *  direction enforcement to the hub; the same applies here 鈥?the protocol
 *  supplies vocabulary, adapters enforce direction.
 *
 *  external, grok-build `crates/common/xai-tool-protocol/src/methods.rs:19-21`
 *  "the enum is flat 鈥?direction enforcement is the computer hub's job" */
export type EventCategory =
  | 'run'
  | 'turn'
  | 'assistant'
  | 'tool'
  | 'permission'
  | 'compaction'
  | 'subagent'
  | 'diagnostic'
  | 'extension';

/**
 * Metadata for every event.
 *
 * Extends `MessageGate` rather than carrying a `since` string, so an event
 * cannot be declared without also declaring when it appeared and what a
 * consumer must understand to make sense of it. The earlier `since` field was
 * writable and unreadable in the same breath 鈥?thirty events all read `1.0`
 * and nothing consulted it 鈥?so the type now refuses to let that happen.
 */
export interface EventMeta extends MessageGate {
  readonly durability: Durability;
  readonly category: EventCategory;
  /**
   * Whether a consumer that does not understand this event may ignore it.
   *
   * Plan 587 T3.2, contract 搂F: "鏃犳硶璇嗗埆鐨勫叧閿帶鍒?terminal 涓嶈兘鍋峰伔鍙樻垚鎴愬姛"
   * 鈥?an unrecognised critical control/terminal must not quietly become
   * success. This flag is where that sentence becomes machine-readable.
   *
   * The rule is NAMESPACE, not a per-event judgement, and it is enforced at
   * compile time by `CRITICALITY_MATCHES_RESERVED_NAMESPACES` in
   * `criticality.ts`: an event in a reserved namespace is critical, and no
   * event outside one is. A hand-picked list would be a second source of truth
   * that a new event could silently opt out of, which is the exact failure the
   * registry is supposed to prevent for `durability`.
   */
  readonly critical: boolean;
  readonly description: string;
}

export interface EventRegistry {
  readonly all: readonly EventType[];
  readonly byCategory: ReadonlyMap<EventCategory, readonly EventType[]>;
  readonly durable: readonly EventType[];
  readonly volatile: readonly EventType[];
  readonly ephemeral: readonly EventType[];
  readonly allSpecs: ReadonlyMap<EventType, EventMeta>;
  readonly specOf: (type: string) => EventMeta | undefined;
  isKnown: (type: string) => type is EventType;
}

type MetaTable = { readonly [K in EventType]: EventMeta };

/** The one function. Given a complete metadata table it returns every derived
 *  view, so no lookup can be hand-maintained alongside it. */
export function defineEventUnion<M extends MetaTable>(meta: M): EventRegistry {
  const entries = Object.entries(meta) as [EventType, EventMeta][];

  const all = entries.map(([type]) => type);
  const byCategory = new Map<EventCategory, EventType[]>();
  const byDurability: Record<Durability, EventType[]> = {
    durable: [],
    volatile: [],
    ephemeral: [],
  };

  for (const [type, spec] of entries) {
    const bucket = byCategory.get(spec.category);
    if (bucket) bucket.push(type);
    else byCategory.set(spec.category, [type]);
    byDurability[spec.durability].push(type);
  }

  const allSpecs = new Map<EventType, EventMeta>(entries);
  const known = new Set<string>(all);

  return {
    all,
    byCategory,
    durable: byDurability.durable,
    volatile: byDurability.volatile,
    ephemeral: byDurability.ephemeral,
    allSpecs,
    specOf: (type: string) => allSpecs.get(type as EventType),
    isKnown: (type: string): type is EventType => known.has(type),
  };
}

/**
 * Runtime metadata for every event.
 *
 * The mapped type on the export is the guarantee: TypeScript requires a value
 * for every key of `RunEventPayloads` and rejects keys that are not in it, so
 * the two lists cannot drift. It also forces every entry to carry a
 * `MessageGate`, which is the point: the gate is not optional bookkeeping.
 *
 * `requiresCapability` appears only where a host that lacks it would be
 * actively misled. A host that cannot render a tool preview should be sent no
 * preview rather than one it will drop; a host that cannot resume from a
 * checkpoint should be sent no checkpoint reference rather than one it will
 * try and fail to use.
 */
const G1_0 = { minProtocol: '1.0', minSchemaRevision: 1, critical: false } as const;

/**
 * The gate for an event in a RESERVED namespace, where "critical" is a
 * property of the name rather than a per-event opinion.
 *
 * `run.`, `permission.` and `checkpoint.` are the namespaces the protocol mints
 * ITSELF, and they are exactly the namespaces where a consumer that does not
 * understand the event is holding a false belief rather than a missing pixel:
 *
 *  - an unread `run.completed` / `run.failed` is a run whose ending is unknown,
 *    which is what "quietly becomes success" means;
 *  - an unread `permission.requested` is a blocked tool with nobody answering;
 *  - an unread `checkpoint.saved` is a resume boundary a host will later try to
 *    restore from and cannot.
 *
 * Everything else is display fidelity, not correctness. A host that misses
 * `assistant.text_delta` shows a gap; a host that misses `run.completed` reports
 * a run it does not know the end of. `extension.` is the namespace the contract
 * names as the forward-compatibility escape hatch, so ignoring it IS its
 * contract rather than a failure to understand it.
 */
const G1_0_CRITICAL = { ...G1_0, critical: true } as const;

export const EVENT_META = {
  'run.started': { ...G1_0_CRITICAL, durability: 'durable', category: 'run', description: 'Run opened; carries the manifest hash and the runtime identity.' },
  'run.paused': { ...G1_0_CRITICAL, durability: 'volatile', category: 'run', description: 'Run halted at a pause point, resumable.' },
  'run.completed': { ...G1_0_CRITICAL, durability: 'durable', category: 'run', description: 'Terminal success. Cancellation also lands here, not in run.failed.' },
  'run.failed': { ...G1_0_CRITICAL, durability: 'durable', category: 'run', description: 'Terminal failure with a protocol error code.' },

  'turn.started': { ...G1_0, durability: 'durable', category: 'turn', description: 'A model turn began.' },
  'turn.retry_scheduled': { ...G1_0, durability: 'volatile', category: 'turn', description: 'Retry metadata promoted to a first-class event.' },
  'turn.completed': { ...G1_0, durability: 'durable', category: 'turn', description: 'Turn finished with a stop reason and usage.' },

  'assistant.text_block': { ...G1_0, durability: 'durable', category: 'assistant', description: 'A complete text block.' },
  'assistant.text_delta': { ...G1_0, durability: 'ephemeral', category: 'assistant', description: 'Incremental text. Counted in metrics, never retained.' },
  'assistant.thinking_block': { ...G1_0, durability: 'durable', category: 'assistant', description: 'A complete reasoning block.' },
  'assistant.thinking_delta': { ...G1_0, durability: 'ephemeral', category: 'assistant', description: 'Incremental reasoning. Counted in metrics, never retained.' },
  'assistant.message_finalized': { ...G1_0, durability: 'durable', category: 'assistant', description: 'The authoritative assistant message.' },
  'assistant.usage': { ...G1_0, requiresCapability: 'usage_accounting', durability: 'durable', category: 'assistant', description: 'Token and cost accounting. Withheld from a host that cannot account for cost, rather than sent and dropped.' },
  'assistant.mode_changed': { ...G1_0, durability: 'volatile', category: 'assistant', description: 'Mode switch. `mode` is a closed set, not a bare string.' },
  'assistant.goal_updated': { ...G1_0, durability: 'durable', category: 'assistant', description: 'Goal state machine progress.' },
  'assistant.status': { ...G1_0, durability: 'volatile', category: 'assistant', description: 'Human-readable status line for the UI.' },

  'tool.call_preview': { ...G1_0, requiresCapability: 'tool_call_preview', durability: 'volatile', category: 'tool', description: 'Provisional announcement while arguments still stream. Never durable: the call it describes may not happen as stated.' },
  'tool.call_started': { ...G1_0, durability: 'durable', category: 'tool', description: 'Authoritative intent, emitted exactly once per toolCallId before executor dispatch. The durable half of the side-effect ledger.' },
  'tool.arguments_delta': { ...G1_0, durability: 'ephemeral', category: 'tool', description: 'Streaming tool arguments.' },
  'tool.progress': { ...G1_0, durability: 'volatile', category: 'tool', description: 'Long-running tool progress.' },
  'tool.group_progress': { ...G1_0, durability: 'volatile', category: 'tool', description: 'Aggregate progress for a group of tools.' },
  'tool.timed_out': { ...G1_0, durability: 'volatile', category: 'tool', description: 'Tool exceeded its deadline.' },
  'tool.call_completed': { ...G1_0, requiresCapability: 'tool_outcome_detail', durability: 'durable', category: 'tool', description: 'Tool finished. `outcome` is a discriminated union; an absent producer status becomes `indeterminate`, never `success`.' },

  'permission.requested': { ...G1_0_CRITICAL, durability: 'durable', category: 'permission', description: 'Approval needed. `expiresAt` is minted once, by the runtime.' },
  'permission.resolved': { ...G1_0_CRITICAL, durability: 'durable', category: 'permission', description: 'Every decision is recorded, including timeout and cancellation.' },
  'permission.expired': { ...G1_0_CRITICAL, requiresCapability: 'permission_expiry', durability: 'durable', category: 'permission', description: 'Emitted BEFORE permission.resolved{deny,timeout}.' },

  'checkpoint.saved': { ...G1_0_CRITICAL, requiresCapability: 'checkpoint_resume', durability: 'durable', category: 'run', description: 'A durable checkpoint boundary. Carries a reference, never the messages. Gated on `checkpoint_resume` so a host is never handed a reference it cannot use.' },

  'compaction.started': { ...G1_0, durability: 'durable', category: 'compaction', description: 'Context compaction began.' },
  'compaction.step': { ...G1_0, durability: 'volatile', category: 'compaction', description: 'Compaction progress step.' },
  'compaction.completed': { ...G1_0, durability: 'durable', category: 'compaction', description: 'Compaction produced a new boundary.' },
  'compaction.failed': { ...G1_0, durability: 'durable', category: 'compaction', description: 'Compaction failed; transcript unchanged.' },
  'compaction.over_threshold': { ...G1_0, durability: 'volatile', category: 'compaction', description: 'Retained tokens exceed the window.' },

  'subagent.started': { ...G1_0, durability: 'durable', category: 'subagent', description: 'Subagent spawned.' },
  'subagent.completed': { ...G1_0, durability: 'durable', category: 'subagent', description: 'Subagent finished.' },
  'hook.invoked': { ...G1_0, durability: 'durable', category: 'subagent', description: 'A lifecycle hook ran. The legacy payload carried its own seq field; that third seq namespace is dropped.' },

  diagnostic: { ...G1_0, durability: 'ephemeral', category: 'diagnostic', description: 'Structured log line. Consumers that want it subscribe; the product UI ignores it.' },
  'diagnostic.trace': { ...G1_0, durability: 'ephemeral', category: 'diagnostic', description: 'Span record for tracing.' },

  'extension.custom': { ...G1_0, durability: 'volatile', category: 'extension', description: 'Forward-compatibility escape hatch. Unknown namespaces MUST be ignored and never persisted.' },
} as const satisfies MetaTable;

export const EVENT_REGISTRY: EventRegistry = defineEventUnion(EVENT_META);

export const EVENT_TYPES: readonly EventType[] = EVENT_REGISTRY.all;

export const isEventType = EVENT_REGISTRY.isKnown;

export const eventSpecOf = EVENT_REGISTRY.specOf;

// 鈹€鈹€ control-plane gate table 鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€鈹€

/**
 * The same gate, applied to control methods.
 *
 * Control methods are held to the identical rule as events, and for a sharper
 * reason: an event a host cannot interpret is ignored, but a control method a
 * host cannot implement becomes a promise the host will keep. `run.resume`
 * reaching a host with no `replay` capability is a resume that silently does
 * nothing, which is worse than a refusal.
 */
export const CONTROL_GATE: Readonly<Record<string, MessageGate>> = {
  'run.start': { minProtocol: '1.0', minSchemaRevision: 1 },
  'run.cancel': { minProtocol: '1.0', minSchemaRevision: 1 },
  'run.pause': { minProtocol: '1.0', minSchemaRevision: 1, requiresCapability: 'replay' },
  'run.resume': { minProtocol: '1.0', minSchemaRevision: 1, requiresCapability: 'replay' },
  'permission.respond': { minProtocol: '1.0', minSchemaRevision: 1 },
  'permission.setMode': { minProtocol: '1.0', minSchemaRevision: 1 },
};

/** The gate table spanning both planes, so a call site cannot forget one. */
export const MESSAGE_GATES: Readonly<Record<string, MessageGate>> = {
  ...CONTROL_GATE,
  ...EVENT_META,
};
