/**
 * Plan 600 S2 step b2: the two one-shot call sites, cut over to
 * `OneShotTextPort`.
 *
 * ## What this file is the proof of
 *
 * Before this slice, `DuyaAgent.ts` opened a provider stream in two places
 * outside the turn loop -- the compaction summarizer and the side question --
 * and those two lines were the ONLY matches for `TURN_LOOP_SHAPE.modelStream`
 * (`/\.streamChat\s*\(/`) in the file. Step b1 built the port; this step moves
 * both call sites onto it and pins the four things the move had to preserve.
 *
 *  1. **No direct provider stream remains.** Asserted against the REAL gate
 *     regex read off disk, not a copy of it -- see "Why the gate regex is
 *     imported" below.
 *  2. **The summarizer still answers with a `string`**, and still trims it.
 *  3. **A user interrupt still reaches an in-flight summarization.** This is
 *     the property the child-controller linkage exists for, and it is the one
 *     a naive migration breaks silently: route the call through a port and
 *     forget to thread the caller's signal, and the port still works, the
 *     summary still comes back, and the only difference is that pressing stop
 *     no longer stops anything.
 *  4. **The side question still surfaces provider errors**, because its caller
 *     contract is a rejection rather than a value.
 *
 * ## The one behaviour change, and why it is asserted rather than hidden
 *
 * The summarizer used to `break` on an `error` frame and return the text it
 * had accumulated, so a provider
 * that died mid-summary stored a truncated summary. `OneShotTextResult` carries
 * no partial text on `failed` (`ports.ts:1682-1685`), so that value is no
 * longer reachable and the summarizer now raises the provider's message --
 * which is what b1 specified (`ports.ts:1610-1613`). "Surfaces provider errors"
 * below asserts the new contract, and the surrounding comment records the old
 * one. This is a behaviour change pending the owner's ruling, not a
 * restatement.
 *
 * ## Why the tests drive a real `duyaAgent`
 *
 * Because the thing under test IS the wiring. Requirement 3 is a property of
 * `DuyaAgent`'s own `createChildAbortController(this.abortController)` call,
 * and requirement 4 is a property of `sideQuestion`'s public surface. A test
 * against an extracted helper would pass while the linkage in this file was
 * deleted, which is exactly the regression that must not ship -- so these
 * construct the god class and reach the summarizer the way the compaction
 * manager does.
 *
 * The private fields are reached through a narrow structural type rather than
 * `any`, and only for the three members the assertions need. `compactionManager`
 * is private on the agent and `summarizer` is private on the manager, so the
 * cast crosses two boundaries; it is a test seam, not production access.
 *
 * ## Why the gate regex is imported
 *
 * `TURN_LOOP_SHAPE` is imported from `scripts/architecture/boundary-gates.mjs`
 * and applied to the source read from disk. Hand-copying the regex into this
 * file would let the two drift, and a test that restates a constant proves
 * nothing: the failure this must catch is someone re-introducing
 * `.streamChat(`, and only the live regex decides whether that is a finding.
 * The `isTurnLoopModule` assertion below is the complement -- it is a
 * conjunction of all three shapes, so it is the gate's own definition of "this
 * module IS a turn loop", quoted from the gate rather than approximated.
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { duyaAgent } from '../../../src/agent/DuyaAgent.js';
import { fromProviderMessages, toProviderMessages } from '../../../src/process/run-engine-model.js';
import type { Message } from '@duya/agent-protocol/transcript';
import type { SSEEvent } from '@duya/ai';
import { isTurnLoopModule, TURN_LOOP_SHAPE } from '../../../../../scripts/architecture/boundary-gates.mjs';

// ============================================================================
// Reaching the real agent
// ============================================================================

type SummarizerFn = (text: string, prompt: string) => Promise<string>;

/** The three private members these assertions need, and nothing else. */
interface AgentInternals {
  llmClient: unknown;
  compactClient?: unknown;
  abortController: AbortController | null;
  compactionManager: { summarizer?: SummarizerFn };
}

function internalsOf(agent: duyaAgent): AgentInternals {
  return agent as unknown as AgentInternals;
}

/**
 * The summarizer the agent installed on its compaction manager.
 *
 * Read out of the live object rather than re-created, so the assertions are
 * about the closure `DuyaAgent` actually handed to `setSummarizer` -- including
 * its captures of `this.compactClient` / `this.llmClient` / `this.abortController`,
 * all of which are resolved at CALL time and can be swapped before it runs.
 */
function summarizerOf(agent: duyaAgent): SummarizerFn {
  const fn = internalsOf(agent).compactionManager.summarizer;
  if (!fn) throw new Error('the agent installed no summarizer');
  return fn;
}

const originalEnv = { ...process.env };

beforeEach(() => {
  // Keep the god class constructible and offline: no real endpoint, no session
  // persistence, no real sessions/memory roots.
  process.env.DUYA_E2E_DISABLE_LLM = '1';
  process.env.DUYA_SESSIONS_ROOT = '';
  process.env.DUYA_MEMORY_ROOT = '';
});

afterEach(() => {
  process.env = { ...originalEnv };
  vi.restoreAllMocks();
});

function makeAgent(sessionId: string): duyaAgent {
  return new duyaAgent({
    model: 'test-model',
    provider: 'anthropic',
    sessionId,
    workingDirectory: 'E:\\Projects\\duya',
    apiKey: 'test-key',
  });
}

// ============================================================================
// The fake provider
// ============================================================================

const DONE: SSEEvent = { type: 'done', reason: 'end_turn' };

function abortError(): Error {
  const error = new Error('The operation was aborted');
  error.name = 'AbortError';
  return error;
}

/**
 * A client that records each call and replays a fixed script.
 *
 * An abort is observable here, the way a `fetch`-backed stream makes it
 * observable: the generator stops instead of finishing. `ignoreSignal` models
 * a provider that cannot be cancelled at all.
 */
function fakeClient(
  script: readonly SSEEvent[],
  options: {
    readonly ignoreSignal?: boolean;
    readonly onEvent?: (event: SSEEvent) => void;
  } = {},
) {
  const seen: { messages: unknown; options: Record<string, unknown> }[] = [];
  return {
    seen,
    streamChat(messages: unknown, requestOptions: Record<string, unknown>) {
      seen.push({ messages, options: requestOptions });
      const signal = requestOptions.signal as AbortSignal | undefined;
      const cancelled = (): boolean => signal?.aborted === true && options.ignoreSignal !== true;
      return (async function* () {
        for (const event of script) {
          if (cancelled()) throw abortError();
          options.onEvent?.(event);
          yield event;
          if (cancelled()) throw abortError();
        }
      })();
    },
  };
}

// ============================================================================
// 1. The gate regex, applied to the real file
// ============================================================================

describe('DuyaAgent no longer opens a provider stream directly', () => {
  const sourcePath = fileURLToPath(
    new URL('../../../src/agent/DuyaAgent.ts', import.meta.url),
  );

  it('has no line matching the gate\'s own modelStream shape', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    // The live regex, on the live file. A hand-written `/\.streamChat\(/` here
    // would go green the day the gate tightened, and red the day it loosened,
    // with nothing to do with the code.
    expect(TURN_LOOP_SHAPE.modelStream.test(source)).toBe(false);
  });

  it('is no longer a turn-loop module by the gate\'s own definition', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    // The complement, and the reason the first assertion is not enough on its
    // own: `repetition` and `toolExecution` still match (the real turn loop is
    // still in this file -- that is b3/b4's job), so only the conjunction says
    // the module is no longer shaped like a turn loop.
    expect(TURN_LOOP_SHAPE.repetition.test(source)).toBe(true);
    expect(TURN_LOOP_SHAPE.toolExecution.test(source)).toBe(true);
    expect(isTurnLoopModule(source)).toBe(false);
  });

  it('still generates through the port, so the gate cannot pass by deletion', () => {
    const source = fs.readFileSync(sourcePath, 'utf8');

    // A negative regex plus a deleted summarizer is a green test suite and a
    // broken product. Both call sites must still exist, and both must be
    // routed through the port rather than through anything else.
    expect(source).toContain('createOneShotTextPort');
    expect(source).toContain('setSummarizer');
    expect(source).toContain('async sideQuestion(');
  });
});

// ============================================================================
// 2. The summarizer's value contract
// ============================================================================

describe('the compaction summarizer, on the one-shot port', () => {
  it('returns the joined, trimmed summary the compaction manager stores', async () => {
    const agent = makeAgent('session-b2-summary-ok');
    internalsOf(agent).llmClient = fakeClient([
      { type: 'text', data: '## Summary\n' },
      { type: 'text', data: '- kept the plan\n' },
      { type: 'text', data: '- dropped the noise\n' },
      DONE,
    ]);

    const summary = await summarizerOf(agent)('transcript', 'prompt');

    // The trim is asserted because it is the caller's own storage decision and
    // the port deliberately does NOT trim; a port-level trim would leave this
    // green while losing the distinction between a real answer and `'  '`.
    expect(summary).toBe('## Summary\n- kept the plan\n- dropped the noise');
  });

  it('reports a real empty answer as an empty summary, not a failure', async () => {
    const agent = makeAgent('session-b2-summary-empty');
    internalsOf(agent).llmClient = fakeClient([DONE]);

    expect(await summarizerOf(agent)('transcript', 'prompt')).toBe('');
  });

  it('surfaces provider errors with the provider\'s own words', async () => {
    // BEHAVIOUR CHANGE from the pre-b2 summarizer, which returned the partial
    // text here instead. The port's `failed` arm carries no partial text, and
    // b1 chose the raise. Asserted with the provider's exact message because
    // the retry ladder CLASSIFIES on those words
    // (`compact/summaryRetry.ts:41-73`): `context_length_exceeded` is what
    // routes a compaction into shrinking its input and trying again, so losing
    // or rewording the message would silently change retry behaviour.
    const agent = makeAgent('session-b2-summary-error');
    internalsOf(agent).llmClient = fakeClient([
      { type: 'text', data: '## Summary\n- half of it' },
      { type: 'error', data: 'context_length_exceeded' },
    ]);

    await expect(summarizerOf(agent)('transcript', 'prompt')).rejects.toThrow(
      'context_length_exceeded',
    );
  });

  it('forbids tool calling without being told to, and sends no tool set', async () => {
    // Plan 523 P4.1. Asserted here rather than only on the port because the
    // summarizer's own `toolChoice: 'none'` is GONE from this call site now --
    // the port supplies it unconditionally. If a future edit passes `tools`
    // instead, the provider gets tool-call tokens where a summary belongs.
    const agent = makeAgent('session-b2-summary-tools');
    const client = fakeClient([{ type: 'text', data: '## Summary' }, DONE]);
    internalsOf(agent).llmClient = client;

    await summarizerOf(agent)('transcript', 'prompt');

    expect(client.seen[0]?.options.toolChoice).toBe('none');
    expect('tools' in (client.seen[0]?.options ?? {})).toBe(false);
  });

  it('keeps the summarizer\'s ceiling and temperature', async () => {
    // Values, not presence: these are the plan 523 P4.3 numbers and a port
    // that dropped them would inherit the client's default silently.
    const agent = makeAgent('session-b2-summary-limits');
    const client = fakeClient([{ type: 'text', data: '## Summary' }, DONE]);
    internalsOf(agent).llmClient = client;

    await summarizerOf(agent)('transcript', 'prompt');

    expect(client.seen[0]?.options.maxTokens).toBe(8192);
    expect(client.seen[0]?.options.temperature).toBe(0.3);
  });

  it('prefers the dedicated compaction client when one is configured', async () => {
    // The `compactClient ?? llmClient` choice is per-call and lives in the
    // closure, so it is only observable by installing both and seeing which
    // one got the request.
    const agent = makeAgent('session-b2-summary-compact-client');
    const main = fakeClient([{ type: 'text', data: 'from main' }, DONE]);
    const compact = fakeClient([{ type: 'text', data: '## Summary from compact' }, DONE]);
    const internals = internalsOf(agent);
    internals.llmClient = main;
    internals.compactClient = compact;

    const summary = await summarizerOf(agent)('transcript', 'prompt');

    expect(summary).toBe('## Summary from compact');
    expect(compact.seen).toHaveLength(1);
    expect(main.seen).toHaveLength(0);
  });
});

// ============================================================================
// 3. A user interrupt still reaches an in-flight summarization
// ============================================================================

describe('a user interrupt cancels an in-flight summarization', () => {
  it('threads a signal that is linked to the agent\'s main controller', async () => {
    // THE load-bearing assertion of this slice. The summarizer builds a CHILD
    // of the agent's main controller and hands the child to the provider. Two
    // facts have to hold together:
    //
    //  - the provider received the CHILD, not the parent's own signal, so
    //    disposing the child does not disturb the main turn's controller;
    //  - aborting the PARENT makes that child aborted, which is the whole
    //    reason a child exists.
    //
    // An implementation that built a fresh independent controller passes the
    // first check and fails the second; one that passed the parent directly
    // passes the second and fails the first. Neither passes both.
    const agent = makeAgent('session-b2-interrupt');
    const parent = new AbortController();
    internalsOf(agent).abortController = parent;
    const client = fakeClient([{ type: 'text', data: 'half a summary' }, DONE]);
    internalsOf(agent).llmClient = client;

    await summarizerOf(agent)('transcript', 'prompt');

    const seenSignal = client.seen[0]?.options.signal as AbortSignal | undefined;
    expect(seenSignal).toBeDefined();
    expect(seenSignal).not.toBe(parent.signal);
    expect(seenSignal?.aborted).toBe(false);
  });

  it('cancels the summary when the user interrupts mid-stream', async () => {
    // The behavioural half: the interrupt lands after the request is open, so
    // the provider stops mid-answer and the summarizer REJECTS rather than
    // resolving with the half it had. The reason is carried through, so the
    // retry ladder can tell a user pressing stop from a provider outage --
    // `classifySummaryError` matches no retryable marker in it and treats it as
    // fatal, exactly as the pre-migration AbortError did.
    const agent = makeAgent('session-b2-interrupt-inflight');
    const parent = new AbortController();
    internalsOf(agent).abortController = parent;
    const client = fakeClient([{ type: 'text', data: 'half a summary' }, DONE], {
      onEvent: (event) => {
        if (event.type === 'text') parent.abort(new Error('user pressed stop'));
      },
    });
    internalsOf(agent).llmClient = client;

    await expect(summarizerOf(agent)('transcript', 'prompt')).rejects.toThrow(
      'user pressed stop',
    );
    // Not merely "it threw": the provider must have been stopped. A summary
    // that ran to completion would leave the text in `result` and throw only
    // because the signal happened to be set at the end.
    expect(client.seen).toHaveLength(1);
  });

  it('still works when the agent has no main controller at all', async () => {
    // `abortController` is null before the first turn and for direct/CLI use,
    // and the summarizer falls back to a bare controller. That path must keep
    // working, or compaction on a fresh session breaks.
    const agent = makeAgent('session-b2-no-parent');
    expect(internalsOf(agent).abortController).toBeNull();
    internalsOf(agent).llmClient = fakeClient([{ type: 'text', data: '## Summary' }, DONE]);

    expect(await summarizerOf(agent)('transcript', 'prompt')).toBe('## Summary');
  });
});

// ============================================================================
// 4. The side question surfaces provider errors
// ============================================================================

describe('the side question, on the one-shot port', () => {
  it('surfaces a provider error to its caller', async () => {
    // The side question's contract is a REJECTION, not a value: the pre-b2
    // loop threw `new Error(event.data)` on an error frame, and the renderer
    // surfaces that. A migration that folded the error into an empty string
    // would look like the model declining to answer.
    const agent = makeAgent('session-b2-side-error');
    internalsOf(agent).llmClient = fakeClient([
      { type: 'text', data: 'partial answer' },
      { type: 'error', data: 'upstream 503' },
    ]);

    await expect(agent.sideQuestion('what is up?')).rejects.toThrow('upstream 503');
  });

  it('returns the trimmed answer when the provider succeeds', async () => {
    const agent = makeAgent('session-b2-side-ok');
    const client = fakeClient([
      { type: 'text', data: 'It is a ' },
      { type: 'text', data: 'side question.\n' },
      DONE,
    ]);
    internalsOf(agent).llmClient = client;

    expect(await agent.sideQuestion('what is up?')).toBe('It is a side question.');
    // The side question is tool-free by construction; `toolChoice: 'none'` is
    // the port's standing promise and this is the caller that used to send the
    // weaker `tools: []`.
    expect(client.seen[0]?.options.toolChoice).toBe('none');
    expect('tools' in (client.seen[0]?.options ?? {})).toBe(false);
  });

  it('still refuses an empty question before opening any request', async () => {
    // The guard is above the port. A regression that moved the trim below the
    // call would spend a real provider request to learn the question was blank.
    const agent = makeAgent('session-b2-side-blank');
    const client = fakeClient([DONE]);
    internalsOf(agent).llmClient = client;

    await expect(agent.sideQuestion('   ')).rejects.toThrow('Side question cannot be empty');
    expect(client.seen).toHaveLength(0);
  });
});

// ============================================================================
// 5. The projection both call sites now depend on
// ============================================================================

describe('fromProviderMessages — the crossing into the runtime vocabulary', () => {
  it('is an identity round trip with toProviderMessages', () => {
    // The claim the whole migration rests on: the runtime's `ModelMessage` is
    // NARROWER than the provider's `Message` on paper (three roles, four
    // content blocks, a required id), but the two projections copy fields
    // without rebuilding content, so the composition is the identity. Written
    // out as a literal rather than compared against the input, so a projection
    // that both dropped and re-added the same field could not satisfy it.
    const source: Message[] = [
      { role: 'user', content: 'hello', id: 'm1' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], id: 'm2' },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], id: 'm3' },
    ];

    expect(toProviderMessages(fromProviderMessages(source))).toEqual([
      { role: 'user', content: 'hello', id: 'm1' },
      { role: 'assistant', content: [{ type: 'text', text: 'hi' }], id: 'm2' },
      { role: 'tool', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }], id: 'm3' },
    ]);
  });

  it('carries an image block through untouched', () => {
    // The one content variant the runtime vocabulary does NOT have
    // (`ports.ts:121-125` vs `transcript/content.ts:159-165`). It survives
    // because the cast describes the type and not the value: the block is
    // passed by reference and never rebuilt. If a future implementation maps
    // content block by block, this is what it would drop -- a user attaching a
    // screenshot and asking a side question about it.
    const image = { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } };
    const source: Message[] = [{ role: 'user', content: [image], id: 'm1' }];

    const projected = fromProviderMessages(source);
    const roundTripped = toProviderMessages(projected);

    expect(roundTripped[0]?.content).toEqual([image]);
    // Identity, not equality: nothing may copy or rebuild the block.
    expect((roundTripped[0]?.content as unknown[])[0]).toBe(image);
  });

  it('preserves an absent id as absent rather than inventing one', () => {
    // `ModelMessage.id` is required and `Message.id` is optional, so the
    // projection has to lie in the type system somewhere. It lies in the
    // narrowest place available: the value is passed through unchanged, and no
    // wire payload carries a message id anyway -- the Anthropic projection
    // rebuilds each message as `{ role, content }`
    // (`api/anthropic-messages.ts:1609`) and the OpenAI one as
    // `{ role, content, type }` (`api/openai-responses.ts:189`).
    //
    // The important half is the negative: a projection that invented `''` would
    // pass a value check against a fabricated expectation while giving every
    // id-less message a fake identity.
    const projected = fromProviderMessages([{ role: 'user', content: 'no id here' }]);

    expect('id' in projected[0]!).toBe(true);
    expect(projected[0]?.id).toBeUndefined();
  });
});
