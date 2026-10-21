/**
 * The `ToolResult` wire boundary, and the deprecated re-exports that carry it.
 *
 * ## What this proves, and what it cannot
 *
 * It proves the projection drops exactly the two Promise fields and keeps
 * every JSON field, that the deprecated `@duya/ai` re-exports still resolve,
 * and that the encoded output contains no promise-shaped hole.
 *
 * It does NOT prove anything about a running agent: no tool is executed and
 * no provider is called. A type-level and pure-projection result is not a
 * runtime result, and plan 587 requires the two be reported separately.
 */

import { describe, expect, it } from 'vitest';
import {
  hasDeferredRuntimeState,
  serializeToolResult,
  toToolResultWire,
} from '../src/tool-result-wire.js';
import {
  MESSAGE_CONTENT_TYPES,
  type AgentProgressEvent,
  type AssistantMessage,
  type DeferredToolExtras,
  type Message,
  type MessageContent,
  type PermissionRequestEvent,
  type RuntimeToolResult,
  type StopReason,
  type TokenUsage,
  type ToolResult,
  type ToolResultWire,
  type UsageCall,
} from '../src/types.js';
import {
  MESSAGE_CONTENT_TYPES as PROTOCOL_CONTENT_TYPES,
  type MessageContent as ProtocolMessageContent,
  type TokenUsage as ProtocolTokenUsage,
} from '@duya/agent-protocol/transcript';

describe('tool-result wire serializer', () => {
  it('drops both Promise fields and keeps every JSON field', () => {
    const runtime: RuntimeToolResult = {
      id: 't1',
      name: 'Read',
      result: 'contents',
      error: false,
      duration_ms: 12,
      metadata: { lineCount: 3, exitCode: 0 },
      images: [{ data: 'AA', mediaType: 'image/png' }],
      blocks: [{ type: 'text', text: 'block' }],
      structured: { ok: true },
      pendingExtraResult: Promise.resolve({ result: 'more' }),
      pendingContext: Promise.resolve('transient note'),
    };

    const wire = toToolResultWire(runtime);

    expect(wire).toEqual({
      id: 't1',
      name: 'Read',
      result: 'contents',
      error: false,
      duration_ms: 12,
      metadata: { lineCount: 3, exitCode: 0 },
      images: [{ data: 'AA', mediaType: 'image/png' }],
      blocks: [{ type: 'text', text: 'block' }],
      structured: { ok: true },
    });

    expect('pendingExtraResult' in wire).toBe(false);
    expect('pendingContext' in wire).toBe(false);
  });

  it('omits absent optionals rather than writing explicit undefined', () => {
    // `exactOptionalPropertyTypes` is on across the workspace. A wire frame
    // carrying `error: undefined` is indistinguishable from one that set
    // `error: false` once it has been through JSON, and the protocol's
    // `checkRequiredFields` treats the two differently on purpose.
    const wire = toToolResultWire({ id: 't', name: 'n', result: '' });
    expect(Object.keys(wire).sort()).toEqual(['id', 'name', 'result']);
    expect('error' in wire).toBe(false);
    expect(JSON.parse(JSON.stringify(wire))).toEqual({ id: 't', name: 'n', result: '' });
  });

  it('preserves an explicit `error: false`', () => {
    // The opposite case: absent and `false` are genuinely different and the
    // distinction has to survive, or a successful tool becomes indistinguishable
    // from one whose producer never said.
    const wire = toToolResultWire({ id: 't', name: 'n', result: '', error: false });
    expect('error' in wire).toBe(true);
    expect(wire.error).toBe(false);
  });

  it('serialized JSON contains no promise-shaped hole', () => {
    // The failure this guards: `JSON.stringify` renders a Promise as `{}`, so
    // a leaked `pendingContext` would reach the wire as a plausible-looking
    // empty object and no error would be raised anywhere.
    const runtime: RuntimeToolResult = {
      id: 't',
      name: 'n',
      result: 'r',
      pendingContext: Promise.resolve({ secret: 'should not be here' }),
    };
    const { json } = serializeToolResult(runtime);
    expect(json).not.toContain('pendingContext');
    expect(json).not.toContain('should not be here');
    expect(JSON.parse(json)).toEqual({ id: 't', name: 'n', result: 'r' });
  });

  it('reports deferred runtime state without throwing on a plain result', () => {
    expect(hasDeferredRuntimeState({ id: 't', name: 'n', result: '' })).toBe(false);
    expect(
      hasDeferredRuntimeState({
        id: 't',
        name: 'n',
        result: '',
        pendingExtraResult: Promise.resolve({ result: 'x' }),
      }),
    ).toBe(true);
  });

  it('the legacy error boolean is carried through untouched', () => {
    // Not upgraded to the event vocabulary's `ToolCallOutcome`: doing so here
    // would invent an outcome for every result whose producer omitted the bit.
    const wire = toToolResultWire({ id: 't', name: 'n', result: 'r', error: true });
    expect(wire.error).toBe(true);
    expect('outcome' in wire).toBe(false);
  });
});

describe('deprecated @duya/ai re-exports still resolve to the protocol types', () => {
  it('ToolResult and RuntimeToolResult are the same type', () => {
    // `ToolResult` appears 305 times across 100 files under `packages/`. The
    // alias is what makes this a move rather than a rename.
    const asLegacy: ToolResult = { id: 't', name: 'n', result: '' };
    const asRuntime: RuntimeToolResult = asLegacy;
    const asWire: ToolResultWire = toToolResultWire(asRuntime);
    expect(asWire.id).toBe('t');
  });

  it('a DeferredToolExtras value is accepted where a ToolResult is expected', () => {
    const extras: DeferredToolExtras = { pendingContext: Promise.resolve('note') };
    const result: ToolResult = { id: 't', name: 'n', result: '', ...extras };
    expect(hasDeferredRuntimeState(result)).toBe(true);
  });

  it('the content union is the protocol one, with all six members', () => {
    // If `@duya/ai` had kept its own copy, `MESSAGE_CONTENT_TYPES` would be a
    // different array and this would fail — which is the drift the move exists
    // to prevent.
    expect([...MESSAGE_CONTENT_TYPES]).toEqual([...PROTOCOL_CONTENT_TYPES]);
    expect(MESSAGE_CONTENT_TYPES).toHaveLength(6);

    const asProtocol: ProtocolMessageContent = {
      type: 'provider_block',
      origin: 'anthropic',
      kind: 'server_tool_use',
      payload: { id: 'srvtoolu_1' },
    };
    const asAi: MessageContent = asProtocol;
    expect(asAi.type).toBe('provider_block');
  });

  it('usage types are the protocol ones', () => {
    const usage: TokenUsage = {
      input_tokens: 10,
      output_tokens: 5,
      cache_hit_tokens: 2,
      upstreamProvider: 'Anthropic',
      calls: [{ input_tokens: 10, output_tokens: 5, model: 'm', provider_id: 'p' }],
    };
    const asProtocol: ProtocolTokenUsage = usage;
    expect(asProtocol.input_tokens).toBe(10);
    expect(asProtocol.calls?.[0]?.provider_id).toBe('p');
  });

  it('the remaining moved shapes still carry every field', () => {
    const message: Message = {
      role: 'user',
      content: 'hi',
      visibility: 'hidden',
      displayContent: 'hi',
      metadata: { a: 1 },
      msg_type: 'note',
      seq_index: 3,
      compactedMessageIds: ['m1', 'm2'],
      tokenUsage: { input_tokens: 1, output_tokens: 1 },
    };
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: [],
      stopReason: 'repeated_tool_calls',
      providerMeta: { serviceTier: 'flex' },
    };
    const stop: StopReason = 'repeated_tool_calls';
    const call: UsageCall = { input_tokens: 1, output_tokens: 1, reasoning_tokens: 1 };
    const perm: PermissionRequestEvent = {
      id: 'p',
      toolName: 'Bash',
      toolInput: { cmd: 'ls' },
      mode: 'generic',
      expiresAt: 0,
      metadata: { toolParamsDisplay: [{ name: 'cmd', label: 'Command', value: 'ls' }] },
    };
    const progress: AgentProgressEvent = { type: 'hook_invoked', hookEvent: undefined };

    expect(message.visibility).toBe('hidden');
    expect(assistant.stopReason).toBe(stop);
    expect(call.reasoning_tokens).toBe(1);
    expect(perm.metadata?.toolParamsDisplay?.[0]?.label).toBe('Command');
    expect(progress.type).toBe('hook_invoked');
  });
});
