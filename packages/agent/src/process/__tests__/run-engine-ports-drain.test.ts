/**
 * Plan 600 S2 (drain contract): the adapter maps a real `MessageUpdate` to a
 * `ToolDrainItem` without dropping anything the legacy loop reads.
 *
 * ## What this file is the proof of
 *
 * `DuyaAgent.ts:2677-2698` reads four things off each update the pipeline
 * yields. `toDrainItem` is the function that has to carry all four into the
 * engine's port type, because the alternative -- stringifying the extras into
 * `ToolOutcome.content` -- is a lossy adapter: the sub-agent's internal stream
 * becomes model input, and a pending payload becomes an empty string.
 *
 * So the assertions here are per-READ, not per-field: each one names the line
 * the legacy code reads and checks that the mapped item still holds the value.
 * A field the type does not carry cannot be asserted at all, which is the point
 * -- the list below and the type are two views of the same requirement.
 *
 * ## Why the assertions are not `a === a`
 *
 * The update is built the way the PRODUCER builds it (the `metadata` shape is
 * copied from `StreamingToolExecutor.createAgentProgressMessage:2290-2316`),
 * while the expectation is derived from the field the LEGACY LOOP consumed.
 * For the two identity assertions the two sides are deliberately different
 * objects in the causal chain -- the promise the test created and the promise
 * the mapper handed on -- so `toBe` measures a real hand-off rather than a
 * value that was never in question.
 *
 * ## What this file deliberately does NOT prove
 *
 * The other half -- that the ENGINE consumes all three kinds without leaking or
 * double-settling -- needs a real `RunEngineImpl`. This file used to claim that
 * half was unreachable from here because "@duya/agent-runtime resolves to a
 * different worktree's built `dist`"; that claim is FALSE and has been retired.
 * The composition runs in one process, and
 * `packages/agent/src/process/__tests__/engine-drain-carryover.test.ts` drives
 * these REAL producer shapes through the REAL adapter and the REAL engine in a
 * single test, with the first test in that file asserting the claim as behaviour
 * rather than as a file path. `packages/agent-runtime/test/tool-drain-contract.test.ts`
 * pins the engine's own half from the other side.
 */

import { describe, expect, it } from 'vitest';
import { toDrainItem } from '../run-engine-ports.js';
import type { MessageUpdate } from '../../tool/StreamingToolExecutor.js';
import type { Message } from '@duya/agent-protocol/transcript';

// ============================================================================
// Update shapes, built the way the producer builds them
// ============================================================================

/**
 * A progress message, field for field from
 * `StreamingToolExecutor.createAgentProgressMessage` (`:2290-2316`).
 *
 * `event` is distinguished by PRESENCE, not by value: `overrides.event ??
 * DEFAULT` would turn an explicit `undefined` back into the default, so a test
 * for "no event" could not be written. The `'absent'` marker is how the
 * producer would actually look if the nested event were missing.
 */
const NO_EVENT = Symbol('absent');

function progressMessage(overrides: { event?: unknown; toolId?: string } = {}): Message {
  const event = 'event' in overrides ? overrides.event : { type: 'text', data: 'sub-agent is thinking', agentId: 'sub-1' };
  return {
    role: 'user',
    content: [{ type: 'text', text: JSON.stringify({ toolUseId: 'call-1', agentEventType: 'text' }) }],
    metadata: {
      type: 'agent_progress',
      toolId: overrides.toolId ?? 'call-1',
      toolName: 'Task',
      ...(event === NO_EVENT ? {} : { agentEvent: event }),
    },
  } as unknown as Message;
}

/** A `role: 'tool'` result, the format the pipeline produces today. */
function toolMessage(content: string, extra: Partial<Message> = {}): Message {
  return {
    role: 'tool',
    content,
    tool_call_id: 'call-1',
    duration_ms: 42,
    ...extra,
  } as unknown as Message;
}

/** The old `tool_result` content-array format, still accepted by the loop. */
function oldFormatToolMessage(isError: boolean, text: string): Message {
  return {
    role: 'assistant',
    content: [{ type: 'tool_result', tool_use_id: 'call-old', content: text, is_error: isError }],
  } as unknown as Message;
}

// ============================================================================
// Read 1: `result.deferredContext`  (DuyaAgent.ts:2681)
// ============================================================================

describe('the deferred context survives as a PENDING promise', () => {
  it('hands on the very promise the producer created, unresolved', () => {
    const promise = Promise.resolve({ review: 'looks-right' });
    const update: MessageUpdate = {
      deferredContext: { toolUseId: 'call-1', toolName: 'Task', promise },
    };

    const item = toDrainItem(update);

    expect(item).not.toBeNull();
    expect(item?.kind).toBe('deferred_context');
    if (item?.kind !== 'deferred_context') throw new Error('unreachable: kind asserted above');
    // Identity, not equality: the adapter must not have awaited or re-wrapped
    // it. An adapter that resolved here would move the wait into the drain.
    expect(item.pending).toBe(promise);
    expect(item.callId).toBe('call-1');
    expect(item.toolName).toBe('Task');
  });

  it('never presents a deferred context as a tool result', () => {
    // The lossy-adapter shape: everything that is not a result gets a `content`
    // and becomes one. This is the case that would put a follow-up review into
    // the ledger and into the model's next request.
    const item = toDrainItem({
      deferredContext: { toolUseId: 'call-1', toolName: 'Task', promise: Promise.resolve('x') },
    });
    expect(item?.kind).not.toBe('tool_result');
  });
});

// ============================================================================
// Reads 2 and 3: the progress discriminant and its payload (DuyaAgent.ts:2687-2690)
// ============================================================================

describe('the progress frame survives as itself, not as a result', () => {
  it('recognises the producer\'s discriminant and forwards the event by identity', () => {
    const event = { type: 'text', data: 'sub-agent is thinking', agentId: 'sub-1' };
    const item = toDrainItem({ message: progressMessage({ event }) });

    expect(item?.kind).toBe('subagent_progress');
    if (item?.kind !== 'subagent_progress') throw new Error('unreachable: kind asserted above');
    // The two sides are different objects in the chain: the event the test built
    // and the one the engine will receive.
    expect(item.event).toBe(event);
    expect(item.callId).toBe('call-1');
  });

  it('is never a tool result, so its text can never reach the model', () => {
    const item = toDrainItem({ message: progressMessage() });
    expect(item?.kind).not.toBe('tool_result');
    // A `tool_result` would also carry `content`, and that is the field
    // `#drainOutcomes` turns into a message for the model.
    expect(item).not.toHaveProperty('content');
  });

  it('reads the call id off `toolId`, because a progress message has no `tool_call_id`', () => {
    const item = toDrainItem({ message: progressMessage({ toolId: 'call-from-toolid' }) });
    expect(item?.kind === 'subagent_progress' ? item.callId : null).toBe('call-from-toolid');
  });

  it('skips a progress message with no `agentEvent`, exactly as the legacy loop does', () => {
    // `DuyaAgent.ts:2691` yields only `if (agentEvent)`. A progress message with
    // no event is not a result either, so it must map to `null` rather than to a
    // result with an empty content.
    const item = toDrainItem({ message: progressMessage({ event: NO_EVENT }) });
    expect(item).toBeNull();
  });

  it('wins over a result when a message somehow carries both shapes', () => {
    // The legacy order is progress first (`:2687`) and it `continue`s, so a
    // message that satisfies both tests is a progress frame. The adapter has to
    // keep that order or it would persist a progress row to history.
    const hybrid = {
      role: 'tool',
      content: 'looks like a result',
      tool_call_id: 'call-1',
      metadata: { type: 'agent_progress', toolId: 'call-1', agentEvent: { type: 'done' } },
    } as unknown as Message;
    expect(toDrainItem({ message: hybrid })?.kind).toBe('subagent_progress');
  });
});

// ============================================================================
// Read 4: `result.message` (DuyaAgent.ts:2701-2752)
// ============================================================================

describe('a real tool result keeps every field the loop reads', () => {
  it('maps the `role: tool` format, with the error inferred from the marker', () => {
    const item = toDrainItem({ message: toolMessage('<tool_error>boom</tool_error>') });

    expect(item?.kind).toBe('tool_result');
    if (item?.kind !== 'tool_result') throw new Error('unreachable: kind asserted above');
    expect(item.callId).toBe('call-1');
    expect(item.content).toBe('<tool_error>boom</tool_error>');
    // `DuyaAgent.ts:2729` infers the error from the text, not from a field.
    expect(item.isError).toBe(true);
    expect(item.durationMs).toBe(42);
  });

  it('maps the old `tool_result` block format, with the error read from the FIELD', () => {
    // `:2737` takes `is_error` from the block. Reading it from the text instead
    // would invent an error for a clean result, or miss a real one -- and a
    // missed error is a failed tool that reports success to the model.
    const clean = toDrainItem({ message: oldFormatToolMessage(false, 'no error here') });
    expect(clean?.kind === 'tool_result' ? clean.isError : null).toBe(false);

    const failed = toDrainItem({ message: oldFormatToolMessage(true, 'no marker in the text') });
    expect(failed?.kind === 'tool_result' ? failed.isError : null).toBe(true);
    expect(failed?.kind === 'tool_result' ? failed.callId : null).toBe('call-old');
  });

  it('carries the producer metadata verbatim, for the two consumers that read it', () => {
    // `recordToolCatalogSchemaRead` (`:2715`) and the renderer's preview path
    // (`:2750`) both read keys the runtime cannot enumerate, so the whole object
    // travels. Identity proves it was carried rather than rebuilt.
    const metadata = { schemaRead: 'Read', screenshotPath: 'C:/shot.png' };
    const item = toDrainItem({
      message: toolMessage('ok', { metadata } as unknown as Partial<Message>),
    });

    expect(item?.kind === 'tool_result' ? item.metadata : null).toBe(metadata);
  });

  it('omits `metadata` entirely when the producer sent none', () => {
    const item = toDrainItem({ message: toolMessage('ok') });
    expect(item).not.toHaveProperty('metadata');
  });
});

// ============================================================================
// Nothing to report
// ============================================================================

describe('an update with nothing to report is null, not a fake result', () => {
  it('returns null for an empty update', () => {
    expect(toDrainItem({})).toBeNull();
  });

  it('returns null for a message that is neither progress nor a result', () => {
    expect(toDrainItem({ message: { role: 'user', content: 'hello' } as unknown as Message })).toBeNull();
  });

  it('prefers the deferred context when an update somehow carries both', () => {
    // `StreamingToolExecutor.ts:2194` yields `{ deferredContext }` alone, so this
    // shape does not occur -- but the legacy checks it FIRST, and matching that
    // order means the mapper cannot be tricked into losing a payload.
    const item = toDrainItem({
      deferredContext: { toolUseId: 'call-d', toolName: 'Task', promise: Promise.resolve(1) },
      message: toolMessage('result'),
    });
    expect(item?.kind).toBe('deferred_context');
  });
});
