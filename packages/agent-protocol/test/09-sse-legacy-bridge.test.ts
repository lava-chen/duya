/**
 * Drift test #9 — the legacy SSE bridge covers everything it must.
 *
 * Two failure classes this catches:
 *
 *  1. A legacy event with no mapping. Silent data loss at the cutover.
 *  2. A mapping to an event type the registry does not have. The mapping table
 *     is a `Record<EventType, ...>` at the type level, so a typo there is a
 *     compile error; what this test adds is the OTHER direction, plus a
 *     cross-package check that the legacy list still matches `@duya/ai`.
 *
 * The cross-package check reads `packages/ai/src/types.ts` as text rather than
 * importing `@duya/ai`. Importing it would add a build dependency from the
 * protocol package to another domain package (the grok `sampling-types`
 * mistake in reverse). It would also be wrong inside a worktree, where a bare
 * specifier resolves through the node_modules junction to the PRIMARY
 * checkout's dist instead of the working tree's source.
 */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import {
  EVENT_META,
  EVENT_REGISTRY,
  isEventType,
  type EventType,
} from '../src/index.js';
import {
  LEGACY_SSE_EVENT_TYPES,
  NEW_PROTOCOL_EVENTS,
  SSE_EVENT_TO_PROTOCOL,
  UNDECLARED_ROUTER_EVENTS,
  type LegacySseEventType,
} from '../src/legacy/sse-event.js';

const REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const AI_TYPES = join(REPO_ROOT, 'packages', 'ai', 'src', 'types.ts');

/** Extract the `type: '...'` discriminants from the SSEEvent union. */
function legacyTypesFromAiSource(): string[] {
  const source = readFileSync(AI_TYPES, 'utf8');
  const start = source.indexOf('export type SSEEvent');
  expect(start, 'SSEEvent not found in packages/ai/src/types.ts').toBeGreaterThan(-1);

  // The union runs until the first line that closes it at column 0.
  const rest = source.slice(start);
  const end = rest.search(/\n};|\n\}/);
  const body = end === -1 ? rest : rest.slice(0, end);

  return [...body.matchAll(/type:\s*'([^']+)'/g)].map((m) => m[1]!);
}

describe('drift #9: the legacy mapping table is total and well-formed', () => {
  it('covers every legacy event type, with no extras', () => {
    expect(Object.keys(SSE_EVENT_TO_PROTOCOL).sort()).toEqual(
      [...LEGACY_SSE_EVENT_TYPES].sort(),
    );
  });

  it('every mapped target is a real event type', () => {
    for (const [legacy, targets] of Object.entries(SSE_EVENT_TO_PROTOCOL)) {
      for (const target of targets) {
        expect(isEventType(target), `${legacy} -> ${target} is not in the registry`).toBe(true);
      }
    }
  });

  it('the mapping is total against the real @duya/ai union', () => {
    if (!existsSync(AI_TYPES)) {
      throw new Error(`cannot verify the legacy surface: ${AI_TYPES} is missing`);
    }
    const actual = legacyTypesFromAiSource().sort();
    const declared = [...LEGACY_SSE_EVENT_TYPES].sort();

    const missing = actual.filter((t) => !declared.includes(t as LegacySseEventType));
    const extra = declared.filter((t) => !actual.includes(t));

    expect(
      { missing, extra },
      'packages/ai/src/types.ts SSEEvent and LEGACY_SSE_EVENT_TYPES have diverged',
    ).toEqual({ missing: [], extra: [] });
  });

  it('the two legacy tool announcements map to the two DIFFERENT protocol events', () => {
    // Same shape, different order, different durability. `tool_use_started` is
    // the provisional one and becomes volatile `tool.call_preview`; `tool_use`
    // is the authoritative re-emission and becomes the single durable
    // `tool.call_started`. Completion is `tool_result`'s job.
    //
    // The failure this guards is the one that produced a durable event emitted
    // twice per call with the same id and different arguments — a stream no
    // host could interpret. If a future edit maps both onto one event again,
    // this goes red.
    expect(SSE_EVENT_TO_PROTOCOL['tool_use_started']).toEqual(['tool.call_preview']);
    expect(SSE_EVENT_TO_PROTOCOL['tool_use']).toEqual(['tool.call_started']);
  });

  it('exactly one legacy event maps to the durable tool start', () => {
    // "Exactly once" is a property of the TABLE, not of prose. Two legacy
    // events landing on the durable start is the bug; this counts instead of
    // asserting a list, so a third mapping added later is caught too.
    const mappers = Object.entries(SSE_EVENT_TO_PROTOCOL).filter(([, targets]) =>
      targets.includes('tool.call_started'),
    );
    expect(
      mappers.map(([legacy]) => legacy),
      'more than one legacy event produces the durable tool start',
    ).toEqual(['tool_use']);
  });

  it('the preview is volatile and the start is durable', () => {
    // The split is only meaningful if the durabilities differ; a rename alone
    // would leave the original ambiguity in place under a new name.
    expect(EVENT_META['tool.call_preview'].durability).toBe('volatile');
    expect(EVENT_META['tool.call_started'].durability).toBe('durable');
  });

  it('no legacy event maps to both call_started and call_completed', () => {
    // Guards the specific fabrication this table used to encode: a single
    // wire event standing in for the whole call lifecycle. Nothing on the
    // legacy wire carries a result and an invocation together, so no mapping
    // may claim both endpoints of the lifecycle.
    for (const [legacy, targets] of Object.entries(SSE_EVENT_TO_PROTOCOL)) {
      expect(
        targets.includes('tool.call_started') && targets.includes('tool.call_completed'),
        `${legacy} claims the whole tool lifecycle from one wire event`,
      ).toBe(false);
    }
  });

  it('clipboard_write maps to nothing, on purpose', () => {
    // A UI command, not agent state. The worker has no clipboard.
    expect(SSE_EVENT_TO_PROTOCOL['clipboard_write']).toEqual([]);
  });

  it('every undeclared router event resolves, or is deliberately empty', () => {
    // The router emits at least ten types the union never declared
    // (router.ts:450-569). Any that DO map must map to a real event.
    for (const [emitted, targets] of Object.entries(UNDECLARED_ROUTER_EVENTS)) {
      for (const target of targets) {
        expect(isEventType(target), `${emitted} -> ${target} is not in the registry`).toBe(true);
      }
    }
    expect(UNDECLARED_ROUTER_EVENTS['status']).toEqual(['assistant.status']);
    expect(UNDECLARED_ROUTER_EVENTS['token_usage']).toEqual(['assistant.usage']);
    // `ready` is a ControlFrame, not an event.
    expect(UNDECLARED_ROUTER_EVENTS['ready']).toEqual([]);
  });

  it('the three colon-form compaction types all map, with dots', () => {
    expect(SSE_EVENT_TO_PROTOCOL['compact:start']).toEqual(['compaction.started']);
    expect(SSE_EVENT_TO_PROTOCOL['compact:step']).toEqual(['compaction.step']);
    expect(SSE_EVENT_TO_PROTOCOL['compact:done']).toEqual(['compaction.completed']);
    expect(SSE_EVENT_TO_PROTOCOL['compact:error']).toEqual(['compaction.failed']);
    expect(SSE_EVENT_TO_PROTOCOL['compact:over_threshold']).toEqual([
      'compaction.over_threshold',
    ]);
  });

  it('agent_progress splits three ways, replacing one 8-valued union', () => {
    expect(SSE_EVENT_TO_PROTOCOL['agent_progress']).toEqual([
      'subagent.started',
      'subagent.completed',
      'hook.invoked',
    ]);
  });

  it('every protocol event is reachable from SOME legacy event, or is declared new with a reason', () => {
    const reachable = new Set<EventType>();
    for (const targets of Object.values(SSE_EVENT_TO_PROTOCOL)) {
      for (const t of targets) reachable.add(t);
    }
    for (const targets of Object.values(UNDECLARED_ROUTER_EVENTS)) {
      for (const t of targets) reachable.add(t);
    }
    // The new events are not a hardcoded set in the test — they are
    // `NEW_PROTOCOL_EVENTS`, so a new event with no legacy source fails here
    // until someone writes down WHY it has no legacy source.
    const declaredNew = new Set(Object.keys(NEW_PROTOCOL_EVENTS) as EventType[]);

    const orphaned = EVENT_REGISTRY.all.filter((t) => !reachable.has(t));
    expect(
      orphaned.filter((t) => !declaredNew.has(t)),
      'these protocol events can never be produced by the legacy bridge and are not declared new',
    ).toEqual([]);

    // Bidirectional: declaring an event new that the legacy bridge CAN produce
    // is also drift — the declaration would rot the moment a mapping is added.
    expect(
      [...declaredNew].filter((t) => reachable.has(t)),
      'these events are declared new but the legacy bridge already reaches them',
    ).toEqual([]);
  });

  it('every declared-new event is a real event type carrying a real reason', () => {
    for (const [type, reason] of Object.entries(NEW_PROTOCOL_EVENTS)) {
      expect(isEventType(type), `${type} is declared new but is not in the registry`).toBe(true);
      expect(reason.trim().length, `${type} is declared new with no reason`).toBeGreaterThan(20);
    }
  });
});
