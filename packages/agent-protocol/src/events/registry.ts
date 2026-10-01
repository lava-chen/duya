/**
 * The closed event registry.
 *
 * Design source: 07-agent-protocol-spec.md §4.
 *
 * This is the TypeScript answer to grok-build's `define_methods!` macro
 * (`docs/architecture/10-reference-comparison.md` §1). Rust can generate a
 * union from one list; TypeScript cannot generate a type, so the single source
 * of truth is the `RunEventPayloads` INTERFACE in payloads.ts and this module
 * derives everything else from `keyof` it.
 *
 * ## Why specs and registry are separate files (07 §1)
 *
 * Because the registry must have ZERO runtime imports. If `registry.ts`
 * imported payload VALUES it would pull the whole payload graph into every
 * consumer of the registry, and drift test #1 — "the registry must not import
 * anything at runtime" — would be unassertable. Everything it needs from
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
import type { Since } from '../version.js';

export type EventType = keyof RunEventPayloads;

/** The derived union. `type` is the discriminant; the payload is attached. */
export type RunEvent = {
  [K in EventType]: { readonly type: K } & RunEventPayloads[K];
}[EventType];

/** Unknown-event carrier. `fromEnvelope` NEVER throws (07 §13); it returns
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
 *  direction enforcement to the hub (methods.rs:19-21); the same applies here —
 *  the protocol supplies vocabulary, adapters enforce direction. */
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

export interface EventMeta {
  readonly durability: Durability;
  readonly category: EventCategory;
  /** Protocol version at which this type was introduced. */
  readonly since: Since;
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
 * the two lists cannot drift.
 */
export const EVENT_META = {
  'run.started': { durability: 'durable', category: 'run', since: '1.0', description: 'Run opened; carries the manifest hash and the runtime identity.' },
  'run.paused': { durability: 'volatile', category: 'run', since: '1.0', description: 'Run halted at a pause point, resumable.' },
  'run.completed': { durability: 'durable', category: 'run', since: '1.0', description: 'Terminal success. Cancellation also lands here, not in run.failed.' },
  'run.failed': { durability: 'durable', category: 'run', since: '1.0', description: 'Terminal failure with a protocol error code.' },

  'turn.started': { durability: 'durable', category: 'turn', since: '1.0', description: 'A model turn began.' },
  'turn.retry_scheduled': { durability: 'volatile', category: 'turn', since: '1.0', description: 'Retry metadata promoted to a first-class event.' },
  'turn.completed': { durability: 'durable', category: 'turn', since: '1.0', description: 'Turn finished with a stop reason and usage.' },

  'assistant.text_block': { durability: 'durable', category: 'assistant', since: '1.0', description: 'A complete text block.' },
  'assistant.text_delta': { durability: 'ephemeral', category: 'assistant', since: '1.0', description: 'Incremental text. Counted in metrics, never retained.' },
  'assistant.thinking_block': { durability: 'durable', category: 'assistant', since: '1.0', description: 'A complete reasoning block.' },
  'assistant.thinking_delta': { durability: 'ephemeral', category: 'assistant', since: '1.0', description: 'Incremental reasoning. Counted in metrics, never retained.' },
  'assistant.message_finalized': { durability: 'durable', category: 'assistant', since: '1.0', description: 'The authoritative assistant message.' },
  'assistant.usage': { durability: 'durable', category: 'assistant', since: '1.0', description: 'Token and cost accounting.' },
  'assistant.mode_changed': { durability: 'volatile', category: 'assistant', since: '1.0', description: 'Mode switch. `mode` is a closed set, not a bare string.' },
  'assistant.goal_updated': { durability: 'durable', category: 'assistant', since: '1.0', description: 'Goal state machine progress.' },
  'assistant.status': { durability: 'volatile', category: 'assistant', since: '1.0', description: 'Human-readable status line for the UI.' },

  'tool.call_started': { durability: 'volatile', category: 'tool', since: '1.0', description: 'Tool invocation began. Split from completion so isError can be recorded.' },
  'tool.arguments_delta': { durability: 'ephemeral', category: 'tool', since: '1.0', description: 'Streaming tool arguments.' },
  'tool.progress': { durability: 'volatile', category: 'tool', since: '1.0', description: 'Long-running tool progress.' },
  'tool.group_progress': { durability: 'volatile', category: 'tool', since: '1.0', description: 'Aggregate progress for a group of tools.' },
  'tool.timed_out': { durability: 'volatile', category: 'tool', since: '1.0', description: 'Tool exceeded its deadline.' },
  'tool.call_completed': { durability: 'durable', category: 'tool', since: '1.0', description: 'Tool finished. `isError` is mandatory, unlike the legacy event.' },

  'permission.requested': { durability: 'durable', category: 'permission', since: '1.0', description: 'Approval needed. `expiresAt` is minted once, here.' },
  'permission.resolved': { durability: 'durable', category: 'permission', since: '1.0', description: 'Every decision is recorded, including timeout and cancellation.' },
  'permission.expired': { durability: 'durable', category: 'permission', since: '1.0', description: 'Emitted BEFORE permission.resolved{deny,timeout}.' },

  'compaction.started': { durability: 'durable', category: 'compaction', since: '1.0', description: 'Context compaction began.' },
  'compaction.step': { durability: 'volatile', category: 'compaction', since: '1.0', description: 'Compaction progress step.' },
  'compaction.completed': { durability: 'durable', category: 'compaction', since: '1.0', description: 'Compaction produced a new boundary.' },
  'compaction.failed': { durability: 'durable', category: 'compaction', since: '1.0', description: 'Compaction failed; transcript unchanged.' },
  'compaction.over_threshold': { durability: 'volatile', category: 'compaction', since: '1.0', description: 'Retained tokens exceed the window.' },

  'subagent.started': { durability: 'durable', category: 'subagent', since: '1.0', description: 'Subagent spawned.' },
  'subagent.completed': { durability: 'durable', category: 'subagent', since: '1.0', description: 'Subagent finished.' },
  'hook.invoked': { durability: 'durable', category: 'subagent', since: '1.0', description: 'A lifecycle hook ran. The legacy payload carried its own seq field; that third seq namespace is dropped.' },

  diagnostic: { durability: 'ephemeral', category: 'diagnostic', since: '1.0', description: 'Structured log line. Consumers that want it subscribe; the product UI ignores it.' },
  'diagnostic.trace': { durability: 'ephemeral', category: 'diagnostic', since: '1.0', description: 'Span record for tracing.' },

  'extension.custom': { durability: 'volatile', category: 'extension', since: '1.0', description: 'Forward-compatibility escape hatch. Unknown namespaces MUST be ignored and never persisted.' },
} as const satisfies MetaTable;

export const EVENT_REGISTRY: EventRegistry = defineEventUnion(EVENT_META);

export const EVENT_TYPES: readonly EventType[] = EVENT_REGISTRY.all;

export const isEventType = EVENT_REGISTRY.isKnown;

export const eventSpecOf = EVENT_REGISTRY.specOf;
