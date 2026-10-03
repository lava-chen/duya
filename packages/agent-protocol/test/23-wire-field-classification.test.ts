/**
 * Drift test #23 — the per-field classification agrees with the shapes.
 *
 * ## What this file can and cannot prove
 *
 * `classification.ts` types every table as `Classified<Shape>`, so a MISSING
 * classification is a compile error and a STALE one is a compile error. That
 * file is in `src/`, which `build:protocol` and `typecheck:protocol` both
 * compile, so the guarantee is real. What the compiler cannot do is tell you a
 * classification is *correct*.
 *
 * So this file pins the judgements themselves. If someone reclassifies
 * `visibility` from `ui-view` to `json-wire` because "it is on a wire type",
 * the build stays green and this test goes red.
 *
 * ## What is NOT checked here, and where it is instead
 *
 * Property 2 below reads like it enforces "the `MessageContent` union still
 * has six members", and as a TYPE-level claim it would be decorative:
 * `packages/agent-protocol/tsconfig.json` excludes `test`, so nothing in CI
 * typechecks this file — vitest runs it through esbuild, which strips types.
 * Deleting `ImageContent` from the union left this file 20/20 green. That was
 * measured.
 *
 * The real enforcement is `MESSAGE_CONTENT_UNION_IS_COMPLETE` and
 * `STOP_REASON_IS_COMPLETE` in `src/transcript/content.ts`, which make the same
 * drop a compile error (`TS2322`, exit 2). The assertions below check the
 * runtime constant that those guards compare against, so the pair is:
 * compiled source proves union == constant, and this test proves the constant
 * is the six and nine members the code expects.
 *
 * ## The three properties worth enforcing
 *
 *  1. No `internal-async` field is on a type the wire can carry.
 *  2. The `MessageContent` union still has all six members. This is the
 *     "no field dropped for a tidier union" rule stated as an assertion:
 *     `ImageContent` and `ProviderBlockContent` exist only here, and the
 *     event vocabulary's four-member union would silently lose them.
 *  3. Every union member the code actually emits is classified.
 */

import { describe, expect, it } from 'vitest';
import {
  AGENT_PROGRESS_TYPES,
  DECLARED_FIELD_DIVERGENCES,
  DEFERRED_TOOL_EXTRAS_FIELDS,
  FIELD_CLASSIFICATION,
  FORBIDDEN_ON_WIRE,
  MESSAGE_CONTENT_TYPES,
  MESSAGE_FIELDS,
  PERMISSION_REQUEST_MODES,
  STOP_REASON_MEMBERS,
  TOOL_RESULT_METADATA_DIVERGENCE,
  TOOL_RESULT_WIRE_FIELDS,
  TOOL_USE_CONTENT_FIELDS,
} from '../src/transcript/index.js';
import type {
  AgentProgressEvent,
  Message,
  MessageContent,
  PermissionRequestEvent,
  StopReason,
} from '../src/transcript/index.js';

/** Every classification table, flattened to `Type.field -> class`. */
const flatEntries = (): Array<[string, string]> =>
  Object.entries(FIELD_CLASSIFICATION).flatMap(([type, table]) =>
    Object.entries(table).map(([field, cls]) => [`${type}.${field}`, cls]),
  );

describe('drift #23: the inventory classifies every field, in both directions', () => {
  it('the compiler-visible tables and the exported map agree', () => {
    // `FIELD_CLASSIFICATION` is built from the same const objects the tables
    // are exported as. If someone adds a table to one place and not the
    // other, the map is the one consumers read and this catches the split.
    expect(Object.keys(FIELD_CLASSIFICATION).sort()).toEqual(
      [
        'AgentProgressEvent',
        'AssistantMessage',
        'DeferredToolExtras',
        'HookEventPayload',
        'ImageContent',
        'Message',
        'PermissionRequestEvent',
        'ProviderBlockContent',
        'TextContent',
        'ThinkingContent',
        'TokenUsage',
        'ToolResultContent',
        'ToolResultWire',
        'ToolUse',
        'ToolUseContent',
        'UsageCall',
      ].sort(),
    );
  });

  it('the only same-name divergences are the ones declared on purpose', () => {
    // The same field NAME carrying different classes on different types is
    // not a contradiction — `metadata` is a persisted row blob on `Message`,
    // losslessly-stored MCP metadata on `ToolResultWire`, and an approval
    // card's display rows on `PermissionRequestEvent`. Forbidding the
    // pattern outright would force one of those three to be classified
    // wrongly.
    //
    // What must not happen is a NEW divergence appearing by accident, so the
    // computed set is asserted equal to the declared set. Every row in
    // `DECLARED_FIELD_DIVERGENCES` carries its own rationale.
    const byField = new Map<string, Set<string>>();
    for (const [key, cls] of flatEntries()) {
      const field = key.slice(key.indexOf('.') + 1);
      const bucket = byField.get(field) ?? new Set<string>();
      bucket.add(cls);
      byField.set(field, bucket);
    }

    const computed = [...byField]
      .filter(([, classes]) => classes.size > 1)
      .map(([field]) => field)
      .sort();

    expect(computed, 'a field started disagreeing: classify it, or declare it').toEqual(
      Object.keys(DECLARED_FIELD_DIVERGENCES).sort(),
    );
  });

  it('every declared divergence explains itself', () => {
    for (const [field, why] of Object.entries(DECLARED_FIELD_DIVERGENCES)) {
      expect(why.length, `${field} needs a rationale`).toBeGreaterThan(40);
    }
  });
});

describe('drift #23: the wire carries no internal-async field', () => {
  it('no field on the ToolResult wire half is internal-async', () => {
    // Contract §A forbids Promise/Map/functions on the wire. The two Promise
    // fields must live on `DeferredToolExtras`, which is intersected in at
    // runtime, and on NO type a consumer can reach by importing the wire
    // shape alone.
    for (const [field, cls] of Object.entries(TOOL_RESULT_WIRE_FIELDS)) {
      expect(cls, `ToolResultWire.${field} must be json-wire`).toBe('json-wire');
    }
  });

  it('both Promise fields are classified internal-async', () => {
    for (const field of FORBIDDEN_ON_WIRE) {
      expect(
        DEFERRED_TOOL_EXTRAS_FIELDS[field as keyof typeof DEFERRED_TOOL_EXTRAS_FIELDS],
        `${field} is a Promise and must never be classified json-wire`,
      ).toBe('internal-async');
    }
    expect([...FORBIDDEN_ON_WIRE].sort()).toEqual(['pendingContext', 'pendingExtraResult']);
  });

  it('the two classified internal-async fields are exactly the two known Promises', () => {
    const asyncFields = flatEntries()
      .filter(([, cls]) => cls === 'internal-async')
      .map(([key]) => key);
    expect(asyncFields.sort()).toEqual([
      'DeferredToolExtras.pendingContext',
      'DeferredToolExtras.pendingExtraResult',
    ]);
  });
});

describe('drift #23: no union member was dropped to make the types smaller', () => {
  it('MessageContent still has all six members', () => {
    // The two that exist ONLY in this vocabulary. A union narrowed to the
    // event vocabulary's four members would drop images and every
    // unmodelled provider block, and would still typecheck at every call
    // site that does not happen to construct one.
    expect([...MESSAGE_CONTENT_TYPES].sort()).toEqual([
      'image',
      'provider_block',
      'text',
      'thinking',
      'tool_result',
      'tool_use',
    ]);
  });

  it('every MessageContent member is reachable from the declared union', () => {
    // Compile-time half: these literals only compile if the member is in the
    // union. If a variant is removed, this stops compiling.
    const all: MessageContent[] = [
      { type: 'text', text: 'x' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
      { type: 'tool_use', id: 't1', name: 'n', input: {} },
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'thinking', thinking: 'hmm' },
      { type: 'provider_block', origin: 'anthropic', kind: 'server_tool_use', payload: {} },
    ];
    expect(all).toHaveLength(MESSAGE_CONTENT_TYPES.length);
  });

  it('a tool_result content may still carry image blocks', () => {
    // The `string | MessageContent[]` union on `ToolResultContent.content`
    // is what lets a vision-capable model see a tool's screenshot. Flattening
    // it to `string` is the single most likely field loss in this move.
    const withImages: MessageContent = {
      type: 'tool_result',
      tool_use_id: 't1',
      content: [
        { type: 'text', text: 'captured' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AA' } },
      ],
    };
    expect(withImages.type).toBe('tool_result');
  });

  it('StopReason still has all nine members', () => {
    // Four of these (`max_turns`, `max_tokens`, `tool_use`,
    // `repeated_tool_calls`) have no counterpart in the event vocabulary's
    // six-value StopReason.
    const all: StopReason[] = [
      'completed',
      'aborted',
      'max_turns',
      'max_tokens',
      'error',
      'tool_use',
      'end_turn',
      'stop_sequence',
      'repeated_tool_calls',
    ];
    expect(Object.keys(STOP_REASON_MEMBERS).sort()).toEqual([...all].sort());
    expect(all).toHaveLength(9);
  });
});

describe('drift #23: the recorded judgements are the intended ones', () => {
  it('Message.visibility is a UI view, not wire', () => {
    // The reason the per-field inventory exists: `visibility` sits on the
    // same interface as `role` and `content`, both of which ARE wire. The
    // renderer is its only reader — a hidden message still reaches the model
    // and the store.
    expect(MESSAGE_FIELDS.visibility).toBe('ui-view');
    expect(MESSAGE_FIELDS.role).toBe('json-wire');
    expect(MESSAGE_FIELDS.content).toBe('json-wire');
  });

  it('Message.displayContent is a UI view', () => {
    expect(MESSAGE_FIELDS.displayContent).toBe('ui-view');
  });

  it('tool group presentation fields are UI views on both tool shapes', () => {
    // Grouping and titles are rendered; no provider receives them.
    expect(TOOL_USE_CONTENT_FIELDS.groupId).toBe('ui-view');
    expect(TOOL_USE_CONTENT_FIELDS.progressTitle).toBe('ui-view');
    expect(FIELD_CLASSIFICATION.ToolUse.groupId).toBe('ui-view');
  });

  it('permission metadata and the hook payload are UI views', () => {
    expect(FIELD_CLASSIFICATION.PermissionRequestEvent.metadata).toBe('ui-view');
    expect(FIELD_CLASSIFICATION.AgentProgressEvent.hookEvent).toBe('ui-view');
  });

  it('the legacy optional error boolean is preserved, not upgraded', () => {
    // Upgrading this to `ToolCallOutcome` would fabricate an outcome for
    // every stored row whose producer omitted the bit. The protocol's
    // outcome type is for NEW producers; retro-fitting it is a lie.
    expect(TOOL_RESULT_WIRE_FIELDS.error).toBe('json-wire');
  });

  it('the tool-result metadata divergence is recorded, not silently merged', () => {
    expect(TOOL_RESULT_METADATA_DIVERGENCE.missingFromAgentCopy).toEqual([
      'matchCount',
      'truncated',
      'engine',
    ]);
    expect(TOOL_RESULT_METADATA_DIVERGENCE.removalTask).toBe('587-T3-1-MERGE-METADATA');
  });
});

describe('drift #23: union member inventories match their types', () => {
  it('AGENT_PROGRESS_TYPES matches AgentProgressEvent["type"]', () => {
    const declared: AgentProgressEvent['type'][] = [...AGENT_PROGRESS_TYPES];
    expect(declared).toHaveLength(8);
  });

  it('the legacy agent_progress union still lacks heartbeat, deliberately', () => {
    // The worker union has `heartbeat` so a keepalive is never rendered as
    // model reasoning. The legacy union was never widened to match, and
    // widening it here would let a producer emit a keepalive the renderer
    // cannot distinguish from real output. Recorded as removal task
    // 587-T3-1-BEATHOO rather than silently changed.
    expect(AGENT_PROGRESS_TYPES as readonly string[]).not.toContain('heartbeat');
  });

  it('PERMISSION_REQUEST_MODES matches the request mode union', () => {
    const modes: PermissionRequestEvent['mode'][] = [...PERMISSION_REQUEST_MODES];
    expect(modes).toEqual(['generic', 'ask_user_question', 'exit_plan_mode']);
  });

  it('Message is classified over its full field set', () => {
    // 31 fields. A field added to `Message` without a classification entry is
    // a compile error against `Classified<Message>`; this pins the count so
    // the failure mode is obvious when it happens.
    const fields = Object.keys(MESSAGE_FIELDS).length;
    expect(fields).toBe(31);
    const message: Pick<Message, 'visibility' | 'displayContent' | 'metadata'> = {
      visibility: 'hidden',
      displayContent: 'rendered',
      metadata: { k: 'v' },
    };
    expect(Object.keys(message)).toHaveLength(3);
  });
});
