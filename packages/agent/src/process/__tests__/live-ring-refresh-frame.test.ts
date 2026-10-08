/**
 * Plan 610 follow-up: the live context-ring refresh selection.
 *
 * ## The defect this pins
 *
 * `handleStreamEvent` refreshed the context ring on two frame types --
 * `tool_result` and `done` -- selected on the PRE-codec names. Since the
 * S4c-d3 flip, `driveRunWithEngine` runs `request.legacyFrameCodec` BEFORE it
 * calls `onFrame`, so the live drain hands this handler frames that have
 * ALREADY been converted: `chat:tool_result` and `chat:done`. The bare names
 * never arrive. Both arms were dead, so the ring froze for the whole of a
 * tool-heavy turn and only moved again on the next provider `result` or at
 * turn end -- which is the freeze the arms' own comments say they exist to
 * prevent.
 *
 * The fix keys the selection on the NORMALIZED frame
 * (`refreshesLiveRing`), because `admitChatFrame` is already the one place
 * both vocabularies are reconciled.
 *
 * ## Why the premise is measured here and not assumed
 *
 * The claim that killed the old arms is that the drain is post-codec. That is
 * a property of `engine-run-driver.ts`, so the first test reads the DRIVER
 * and asserts the structural invariant that produces it: no `onFrame` call
 * site is fed the raw projected frame. If someone re-points `onFrame` at the
 * pre-codec frame, that test goes red and this file's remaining cases are
 * re-read as describing a path that no longer exists.
 *
 * ## The oracles are not the thing under test
 *
 * Every frame below is built by the REAL codec
 * (`convertSSEToAgentMessage`, via `admitChatFrame`) and the legacy input
 * shapes are the ones the real projector writes (`legacy-sse-projector.ts`).
 * The expectation is a literal type name. Nothing here compares a value with
 * itself, and no expectation is read back out of `refreshesLiveRing`.
 */
import { describe, expect, it, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ENTRY_URL = new URL('../agent-process-entry.ts', import.meta.url).href;
const DRIVER_URL = new URL('../engine-run-driver.ts', import.meta.url).href;

interface EntrySeam {
  admitChatFrame: (event: { type: string; [field: string]: unknown }) => Record<string, unknown> | null;
  refreshesLiveRing: (chatFrame: Record<string, unknown> | null) => boolean;
}

/**
 * The entry, imported ONCE for the whole file.
 *
 * Dynamic for the same reason `agent-process-entry-import.test.ts` is: a
 * static import is hoisted and evaluated before any test body, so a
 * before/after observation would bracket nothing. The module is safe to
 * import -- that file pins that importing it registers no process-level
 * handler.
 *
 * The import is a real cost (it pulls the agent's whole dependency graph), so
 * it happens in `beforeAll` under a generous hook budget rather than inside
 * the first `it`, where it raced the 10s per-test timeout.
 */
let seam: EntrySeam;

beforeAll(async () => {
  seam = (await import(ENTRY_URL)) as unknown as EntrySeam;
}, 120_000);

describe('the drain is post-codec, which is why the ring keys on chat:* names', () => {
  it('never hands the raw projected frame to onFrame', () => {
    const source = readFileSync(fileURLToPath(DRIVER_URL), 'utf8');

    // Every `onFrame(` ARGUMENT in the driver, as written. The declaration
    // (`onFrame: (frame: ...) => void`) is not a call site and does not match.
    // Each argument is a cast expression, so compare on the HEAD of the
    // expression rather than the whole string.
    const args = [...source.matchAll(/\bonFrame\(\s*([^,)]+)/g)].map((m) => m[1].trim());
    const heads = args.map((a) => (a.match(/^[A-Za-z_$][\w$]*/) ?? [''])[0]);

    // Two call sites, both after conversion: the usage `result` the surface
    // projects, and `chatFrame` from the codec.
    expect(heads.length).toBeGreaterThanOrEqual(2);
    expect(heads).toContain('chatFrame');
    expect(heads).toContain('result');

    // The invariant. The bare projected frame is what the old arms were
    // written against, so passing it here is the regression, spelled out.
    expect(heads).not.toContain('frame');
    expect(heads).not.toContain('typed');
    expect(heads).not.toContain('payload');
  });
});

describe('refreshesLiveRing', () => {
  it('refreshes for the tool result the drain actually delivers', () => {
    const { admitChatFrame, refreshesLiveRing } = seam;

    // `projectToLegacyFrame` writes `data: { id, result, error }`, and the
    // codec spreads that flat onto `chat:tool_result`.
    const drained = admitChatFrame({
      type: 'tool_result',
      data: { id: 't1', result: 'file body', error: false },
    });

    // The premise of the whole fix, read off the codec rather than assumed:
    // the frame the drain delivers is not the name the old arm selected on.
    expect(drained?.type).toBe('chat:tool_result');
    expect(refreshesLiveRing(drained)).toBe(true);
  });

  it('refreshes for the turn end the drain actually delivers', () => {
    const { admitChatFrame, refreshesLiveRing } = seam;

    const drained = admitChatFrame({ type: 'done', data: { reason: 'end_turn' } });

    expect(drained?.type).toBe('chat:done');
    expect(refreshesLiveRing(drained)).toBe(true);
  });

  it('still refreshes for a pre-codec frame, via the same normalization', () => {
    const { admitChatFrame, refreshesLiveRing } = seam;

    // The orchestrator leg passes pre-codec `SSEEvent`s. It must not lose the
    // refresh the way the drain did: the arms have to work in BOTH
    // vocabularies, and normalization is what makes that one predicate rather
    // than a per-caller alias list.
    expect(refreshesLiveRing(admitChatFrame({ type: 'tool_result', data: { id: 't1', result: 'x' } }))).toBe(true);
    expect(refreshesLiveRing(admitChatFrame({ type: 'done', data: { reason: 'end_turn' } }))).toBe(true);
  });

  it('reads the normalized type, not a payload the codec does not forward', () => {
    const { refreshesLiveRing } = seam;

    // `chat:tool_result` carries `id`/`result` FLAT and has no `data`. The old
    // arm required `event.data`, which is `undefined` for every frame the
    // drain produces -- the guard could only ever be false there. A frame
    // built here by hand (a different source than the codec's own output)
    // has no `data` either, and still refreshes.
    expect(refreshesLiveRing({ type: 'chat:tool_result' })).toBe(true);
    expect(refreshesLiveRing({ type: 'chat:done' })).toBe(true);
  });

  it('has teeth: no other frame type refreshes the ring', () => {
    const { admitChatFrame, refreshesLiveRing } = seam;

    // Neighbours of the two refresh types, in both vocabularies, all built by
    // the real codec. Each one is a frame the turn really produces, and each
    // one must NOT re-anchor the ring -- `chat:tool_use` in particular is the
    // frame immediately BEFORE the one that does.
    const nonRefresh = [
      { type: 'tool_use', data: { id: 't1', name: 'Read', input: {} } },
      { type: 'tool_use_started', data: { id: 't1', name: 'Read', input: {} } },
      { type: 'text', data: { content: 'hello' } },
      { type: 'thinking', data: { content: 'hmm' } },
      { type: 'error', data: { message: 'boom', code: 'E1' } },
      { type: 'turn_start', data: { turnCount: 2 } },
      { type: 'agent_progress', data: { type: 'thinking', data: 'sub' } },
    ] as const;

    for (const raw of nonRefresh) {
      const normalized = admitChatFrame({ type: raw.type, data: raw.data });
      expect(refreshesLiveRing(normalized)).toBe(false);
    }

    // And the same frames in the vocabulary the drain delivers, so the guard
    // is not simply "anything starting with chat:".
    for (const type of [
      'chat:tool_use',
      'chat:tool_use_started',
      'chat:text',
      'chat:thinking',
      'chat:error',
      'chat:status',
      'chat:agent_progress',
    ]) {
      expect(refreshesLiveRing({ type })).toBe(false);
    }

    // A frame the codec dropped carries no type at all.
    expect(refreshesLiveRing(null)).toBe(false);
  });

  it('is disjoint from the billing arm, so a provider result cannot double-emit', () => {
    const { admitChatFrame, refreshesLiveRing } = seam;

    // `convertSSEToAgentMessage` returns `null` for `result`: the usage frame
    // is consumed upstream for token accounting. So the ring selection can
    // never claim it, and the `result` arm in the handler owns it alone.
    const usageFrame = admitChatFrame({
      type: 'result',
      data: { input_tokens: 10, output_tokens: 2, cache_hit_tokens: 5 },
    });
    expect(usageFrame).toBeNull();
    expect(refreshesLiveRing(usageFrame)).toBe(false);
  });
});

describe('the handler selects through the predicate', () => {
  /** The `handleStreamEvent` body: its declaration to the options object below it. */
  function handlerBody(): string {
    const source = readFileSync(fileURLToPath(ENTRY_URL), 'utf8');
    const start = source.indexOf('const handleStreamEvent');
    const end = source.indexOf('const chatOptions: ChatOptions');
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    return source.slice(start, end);
  }

  it('calls the predicate on the normalized frame', () => {
    const body = handlerBody();
    expect(body).toContain('refreshesLiveRing(agentMsg)');

    // Scoped to the accounting chain on purpose. The `DEBUG_IPC` trace filter
    // further up names both pre-codec types legitimately -- it logs the frame
    // as its producer sent it, before the codec. The regression is an
    // `else if` SELECTING on them as the ring trigger.
    expect(body).not.toMatch(/else if \(event\.type === '(tool_result|done)'/);
    expect(body).not.toMatch(/else if \(event\.type === 'tool_result' && event\.data\)/);
  });

  it('normalizes once, before the selection reads it', () => {
    const body = handlerBody();

    // One codec pass per event, as `admitChatFrame`'s own contract requires --
    // a second call would convert twice and log the codec's `default:` WARN
    // twice for every frame the codec does not know.
    expect(body.match(/admitChatFrame\(event\)/g) ?? []).toHaveLength(1);

    // Ordering is load-bearing: the predicate is handed the normalized frame,
    // so the conversion has to have happened first.
    const codec = body.indexOf('const agentMsg = admitChatFrame(event);');
    const selection = body.indexOf('refreshesLiveRing(agentMsg)');
    expect(codec).toBeGreaterThan(-1);
    expect(selection).toBeGreaterThan(-1);
    expect(codec).toBeLessThan(selection);
  });

  it('still refreshes from the billing arm, and still reads result pre-codec', () => {
    const body = handlerBody();

    // `result` cannot be read off the normalized frame (the codec drops it),
    // so the billing arm stays on the raw type. Both arms emit; they are
    // different frames, not two paths onto one.
    expect(body).toMatch(/event\.type === 'result' && event\.data/);
    const emits = body.match(/emitTokenUsage\(\)/g) ?? [];
    expect(emits.length).toBe(2);
  });
});
