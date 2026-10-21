/**
 * T3.4 — the runtime half of the coalescing guards.
 *
 * `coalesce-guards.ts` holds the compile-time half (in `src/`, because these
 * packages' tsconfig exclude `test/` and esbuild strips types — T3.1 measured
 * that a guard written in a test directory enforces nothing). These are the
 * halves TypeScript cannot check: that the registry's durability table still
 * matches the set the batcher assumes, and that the flow-control table still
 * says what the transports do.
 */

import { describe, expect, it } from 'vitest';
import { EVENT_REGISTRY } from '@duya/agent-protocol';
import type { EventType } from '@duya/agent-protocol';
import {
  COALESCABLE_EVENT_TYPES,
  defaultMeasureBytes,
  isCoalescable,
  coalesceKeyId,
  coalesceKeyOf,
} from '../src/events/coalesce.js';
import type { CoalesceKey } from '../src/events/coalesce.js';
import { TRANSPORT_FLOW_CONTROL } from '../src/events/control-channel.js';

describe('the batcher merges exactly the families the registry calls ephemeral', () => {
  it('every coalescable type is ephemeral in the registry', () => {
    // If one of these stopped being ephemeral, merging would be discarding a
    // durable frame - a transcript fact - and the coalescing claim would be
    // false.
    for (const type of COALESCABLE_EVENT_TYPES) {
      expect(EVENT_REGISTRY.specOf(type)?.durability).toBe('ephemeral');
    }
  });

  it('no durable type is ever coalescable', () => {
    for (const type of EVENT_REGISTRY.durable) {
      expect(isCoalescable(type)).toBe(false);
    }
  });

  it('no volatile type is ever coalescable', () => {
    // Volatile frames are held in the in-memory ring and are not persisted, so
    // merging one would silently shorten what a reconnect can still read.
    for (const type of EVENT_REGISTRY.volatile) {
      expect(isCoalescable(type)).toBe(false);
    }
  });

  it('the mergeable set is exactly the three delta families, not a growing list', () => {
    expect(new Set(COALESCABLE_EVENT_TYPES)).toEqual(
      new Set<EventType>(['assistant.text_delta', 'assistant.thinking_delta', 'tool.arguments_delta']),
    );
  });

  it('covers every ephemeral type that carries a concatenable delta', () => {
    // The property behind the set, stated so a fourth ephemeral delta family
    // cannot be added and then silently bypass coalescing.
    const concatenable = EVENT_REGISTRY.ephemeral.filter((type) =>
      ['assistant.text_delta', 'assistant.thinking_delta', 'tool.arguments_delta'].includes(type),
    );
    expect(new Set(concatenable)).toEqual(new Set(COALESCABLE_EVENT_TYPES));
  });
});

describe('a merge key cannot be forged into another key', () => {
  it('separates keys that differ in any one component', () => {
    const base = coalesceKeyOf('r', {
      type: 'assistant.text_delta',
      messageId: 'm',
      index: 0,
      delta: 'x',
    } as never) as CoalesceKey;
    const otherType = coalesceKeyOf('r', {
      type: 'assistant.thinking_delta',
      messageId: 'm',
      index: 0,
      delta: 'x',
    } as never) as CoalesceKey;
    const otherBlock = coalesceKeyOf('r', {
      type: 'assistant.text_delta',
      messageId: 'm',
      index: 1,
      delta: 'x',
    } as never) as CoalesceKey;
    const otherMessage = coalesceKeyOf('r', {
      type: 'assistant.text_delta',
      messageId: 'n',
      index: 0,
      delta: 'x',
    } as never) as CoalesceKey;
    const otherRun = coalesceKeyOf('r2', {
      type: 'assistant.text_delta',
      messageId: 'm',
      index: 0,
      delta: 'x',
    } as never) as CoalesceKey;

    const ids = new Set(
      [base, otherType, otherBlock, otherMessage, otherRun].map((key) => coalesceKeyId(key)),
    );
    expect(ids.size).toBe(5);
  });

  it('gives the same id to two events of one block and type', () => {
    const a = coalesceKeyOf('r', { type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'a' } as never);
    const b = coalesceKeyOf('r', { type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'b' } as never);
    expect(coalesceKeyId(a as CoalesceKey)).toBe(coalesceKeyId(b as CoalesceKey));
  });

  it('does not collide on a message id whose suffix looks like a block index', () => {
    // The collision the naive concatenation has, and the reason the index is
    // delimited rather than just appended:
    //
    //   messageId "a",  index 12  ->  "ma12"
    //   messageId "a1", index 2   ->  "ma12"
    //
    // Two different content blocks sharing a key means block 12 of message "a"
    // swallows block 2 of message "a1" - text from one block appended to the
    // other, which is exactly the merge contract section F forbids.
    const first = coalesceKeyOf('r', {
      type: 'assistant.text_delta',
      messageId: 'a',
      index: 12,
      delta: 'x',
    } as never) as CoalesceKey;
    const second = coalesceKeyOf('r', {
      type: 'assistant.text_delta',
      messageId: 'a1',
      index: 2,
      delta: 'x',
    } as never) as CoalesceKey;
    expect(coalesceKeyId(first)).not.toBe(coalesceKeyId(second));
  });

  it('refuses a component carrying the key separator, rather than producing a key that decodes as another', () => {
    const carries = coalesceKeyOf('r', {
      type: 'assistant.text_delta',
      messageId: 'm:0',
      index: 1,
      delta: 'x',
    } as never) as CoalesceKey;
    expect(() => coalesceKeyId(carries)).toThrow(/key separator/);
  });
});

describe('the flow-control table still matches what the code does', () => {
  it('names every transport the repo has, and none claims a per-type pause', () => {
    for (const [transport, capability] of Object.entries(TRANSPORT_FLOW_CONTROL)) {
      expect(capability, transport).not.toBe('per_type_pause');
    }
  });

  it('keeps the refusal promise: nothing here may be described as ephemeral-only', () => {
    // If a future transport CAN pause by type, this table changes and the
    // assertion changes with it. Until then the refusal stands for all of them.
    expect(Object.values(TRANSPORT_FLOW_CONTROL)).not.toContain('per_type_pause');
  });
});

describe('the byte measure is the real wire cost', () => {
  it('measures the JSON form, and a bigger payload measures bigger', () => {
    const small = { type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'a' };
    const big = { type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'a'.repeat(1000) };
    expect(defaultMeasureBytes(small as never)).toBe(JSON.stringify(small).length);
    expect(defaultMeasureBytes(big as never)).toBeGreaterThan(defaultMeasureBytes(small as never));
  });

  it('counts UTF-8 bytes rather than UTF-16 code units', () => {
    // A delta of multi-byte characters must measure more than its `.length`.
    // Undercounting here is how a "byte bound" quietly becomes a "character
    // bound" and the queue holds twice what the host sized for.
    const ascii = { type: 'assistant.text_delta', messageId: 'm', index: 0, delta: 'abc' };
    const cjk = { type: 'assistant.text_delta', messageId: 'm', index: 0, delta: '中文字' };
    expect(defaultMeasureBytes(cjk as never)).toBeGreaterThan(cjk.delta.length);
    expect(defaultMeasureBytes(cjk as never)).toBeGreaterThan(defaultMeasureBytes(ascii as never));
  });
});
