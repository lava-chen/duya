/**
 * The compaction REPLACEMENT must reach the model as a real transcript.
 *
 * ## The regression this file exists to catch
 *
 * `#modelRequest` prefers `ctx.compacted.current` over the assembly whenever a
 * compaction replaced the transcript (`run-engine.ts:1975-1977`), and
 * `port-guards.ts:1084` states that re-applying the host's transform to the
 * replacement is a HOST-side obligation, discharged inside the
 * `CompactionPort` adapter. The adapter discharges it by mapping the
 * coordinator's re-projection through `toRuntimeMessage`
 * (`run-engine-compaction.ts:429`).
 *
 * That mapping was written for its FIRST caller. `buildInterTurnPort` projects
 * the mailbox capture array, and every row in it is a runtime-context injection
 * the projector already built as a `user` message with text-only content
 * (`message-projectors.ts:104-117`), so a mapping that forced `role: 'user'`
 * and degraded every other block was indistinguishable from a faithful one.
 *
 * The compaction caller is not the mailbox. `executePreTurn` re-projects the
 * timeline after the checkpoint entry was appended
 * (`CompactionCoordinator.ts:691-695`), and that projection restores `user`,
 * `assistant` and `tool` roles (`message-projectors.ts:145-155`) carrying
 * `tool_use` and `tool_result` blocks. Through the mailbox-shaped mapping,
 * every assistant turn arrived as something the USER said and every tool call
 * and result was replaced by an `[unprojectable ...]` text marker -- on the one
 * path where the model reads the replacement INSTEAD of the assembly.
 *
 * The failure is invisible to every other test in this package: the engine
 * correctly forwards whatever the port returns, and a transcript flattened to
 * all-`user` is still a well-formed `ModelMessage[]`.
 *
 * ## What is asserted, and why it is not vacuous
 *
 * Every expectation reads a value the TEST planted in a transcript `Message`
 * and reads it back out of the `ModelMessage` the real coordinator -> controller
 * -> adapter chain produced. Nothing compares two values derived from the same
 * computation, and the strings are minted here so the engine cannot know them.
 *
 * The chain under test is the real one end to end:
 *
 *   MessageCompactionController -> CompactionCoordinator
 *     -> buildCoordinatorCompactionSources -> toRuntimeMessage
 *
 * The summarizer itself is scripted (it has to be), but the REPLACEMENT is not
 * scripted -- it is whatever the controller re-projects from the timeline the
 * summarizer's result was appended to, which is the only thing worth asserting
 * about.
 */

import { describe, expect, it } from 'vitest';
import { runCompactionPass, RunEventEmitter, RunSession } from '@duya/agent-runtime';
import type {
  CompactionDecisionInput,
  ModelMessage,
  RunEnginePorts,
} from '@duya/agent-runtime';
// `RunEvent` is the PROTOCOL's union (`events/registry.ts:35`), not the runtime's
// re-export. Sourced from where it is declared so this file adds no type error
// under the temporary test-inclusive config.
import type { RunEvent, RunEventEnvelope, RunId } from '@duya/agent-protocol';
import type { AgentMessage, MessageEntry } from '../../message/message-framework.js';
import { MessageTimeline } from '../../message/message-framework.js';
import { MessageCompactionController } from '../../message/message-compaction-controller.js';
import { CompactionCoordinator } from '../../agent/CompactionCoordinator.js';
import type { CompactionManager } from '../../compact/CompactionManager.js';
import type { Message } from '../../types.js';
import { buildEnginePorts } from '../run-engine-ports.js';
import { buildCoordinatorCompactionSources } from '../run-engine-compaction.js';

const RUN_ID = 'run-a3-replacement-fidelity' as RunId;
const CREATED_AT = 1_700_000_000_000;
const TURN = 3;
const COMPACTION_ID = 'cmp-replacement-1';
const ENTRY_ID = 'entry-replacement-1';

// Facts planted here and read back out of the replacement. Distinct from every
// id in the harness so a replacement that merely echoes its input cannot pass.
const ASSISTANT_TEXT = 'ASSISTANT-TURN-7c1f04: the file is at src/index.ts';
const TOOL_CALL_ID = 'call-9a3d21';
const TOOL_NAME = 'ReadTool';
const TOOL_RESULT_TEXT = 'TOOL-RESULT-5b8e17: exports buildEnginePorts';
const USER_TEXT = 'USER-TURN-2d6a90: where is the entry point';
const FIRST_KEPT_ID = 'u-kept';

// ============================================================================
// Fixtures
// ============================================================================

function agent(role: 'user' | 'assistant' | 'tool', id: string, content: unknown): AgentMessage {
  return {
    role,
    id,
    timestamp: CREATED_AT,
    visibility: 'visible',
    content,
  } as unknown as AgentMessage;
}

function entry(id: string, message: AgentMessage): MessageEntry {
  return { type: 'message', id, parentId: null, createdAt: CREATED_AT, message };
}

/**
 * A conversation that contains all three roles AND both tool blocks.
 *
 * The roles are the point: a mapping that flattens to `user` passes every test
 * that seeds text-only `user` rows, which is what the mailbox caller produces
 * and what this package asserted before.
 */
function seedToolUsingTimeline(): MessageTimeline {
  const timeline = new MessageTimeline();
  timeline.appendMessage(entry('e-u1', agent('user', 'u1', USER_TEXT)));
  // The model's own turn, as TEXT, and as a tool call. Two rows so a mapping
  // that handles one and not the other is distinguishable.
  timeline.appendMessage(entry('e-a1', agent('assistant', 'a1', ASSISTANT_TEXT)));
  timeline.appendMessage(
    entry('e-a2', agent('assistant', 'a2', [{ type: 'tool_use', id: TOOL_CALL_ID, name: TOOL_NAME, input: { path: 'src/index.ts' } }])),
  );
  timeline.appendMessage(
    entry('e-t1', agent('tool', 't1', [{ type: 'tool_result', tool_use_id: TOOL_CALL_ID, content: TOOL_RESULT_TEXT }])),
  );
  // The first KEPT row, so the replacement has a real tail after the summary.
  timeline.appendMessage(entry('e-u2', agent('user', FIRST_KEPT_ID, 'and what does it export')));
  return timeline;
}

// ============================================================================
// The harness
// ============================================================================

function emitterFor(emitted: RunEvent[]): RunEventEmitter {
  const session = new RunSession({
    runId: RUN_ID,
    sessionId: 'sess-replacement-fidelity',
    now: () => 1_000,
    startedAt: 0,
    clock: () => 0,
    persistence: { append: async () => undefined, complete: async () => undefined },
    flushEvery: 1,
  });
  return new RunEventEmitter({
    runId: RUN_ID,
    session,
    stream: {
      push: (envelope: RunEventEnvelope) => {
        emitted.push(envelope.payload);
      },
    },
  });
}

/**
 * Drive the REAL chain and return the `replacement` the port produced.
 *
 * The summarizer is scripted because it has to produce a marker for the
 * controller to record a checkpoint; everything downstream of its RESULT is the
 * production code path, including the re-projection this file is about.
 */
async function replacementFromRealCoordinator(): Promise<readonly ModelMessage[]> {
  const emitted: RunEvent[] = [];

  // Replaces the first three rows with a summary marker, keeping the tail. The
  // marker is what makes `applyCompactionResult` record a real entry, and the
  // tail is what the re-projection has to carry faithfully.
  const compact = async (input: readonly Message[]) => ({
    messages: [
      { role: 'system', content: 'COMPACTED-SUMMARY-1f3a6d', timestamp: CREATED_AT } as unknown as Message,
      ...input.slice(3),
    ],
    tokensRemoved: 900,
    tokensRetained: 180,
    strategy: 'session_memory',
  });

  const timeline = seedToolUsingTimeline();
  const controller = new MessageCompactionController({
    timeline,
    compactionManager: { compact, shouldCompact: () => true } as unknown as CompactionManager,
    idGenerator: () => ENTRY_ID,
    clock: () => CREATED_AT,
  });

  // The gate, over the REAL manager surface the coordinator calls. It fires, so
  // the pass reaches the summarizer.
  const manager = {
    maybeStartPrefire: () => {},
    probeCompaction: () => ({
      tokens: 12_345,
      imageCount: 0,
      imageTriggered: false,
      overTriggerLine: true,
      overHardLimit: false,
    }),
    maybeRearm: () => false,
    isSuppressed: () => false,
    getObservedPromptTokens: () => undefined,
    addEventHandler: () => {},
    removeEventHandler: () => {},
  } as unknown as CompactionManager;

  const coordinator = new CompactionCoordinator({
    compactionController: controller,
    compactionManager: manager,
    // The real re-projection shape: the legacy rebuilds the provider messages
    // from the TIMELINE the compaction just appended to
    // (`CompactionCoordinator.ts:691-695`).
    projectModelMessages: (systemPromptContent) => ({
      systemPromptContent,
      messages: controller.projectInputMessages(),
    }),
    getMessages: () => controller.projectInputMessages(),
    getLastCompactionTurn: () => 0,
    setLastCompactionTurn: () => {},
    getLastCompactionObservedTokens: () => undefined,
    setLastCompactionObservedTokens: () => {},
    getMinTurnsSinceCompact: () => 3,
    getMinTokensGrowthSinceCompact: () => 1_000,
  });

  const sources = buildCoordinatorCompactionSources({
    coordinator,
    systemPromptContent: () => 'SYSTEM-PROMPT-replacement',
    messages: () => controller.projectInputMessages(),
    nextCompactionId: () => COMPACTION_ID,
    noteUsage: () => {},
  });

  const ports: RunEnginePorts = buildEnginePorts({
    openModelStream: () => (async function* () {})(),
    queueTool: () => {},
    drainTools: () => (async function* () {})(),
    discardTools: () => {},
    lookup: { sideEffectOf: () => null, toolNames: () => [], describe: () => null },
    assembleTurn: () =>
      Promise.resolve({
        systemPrompt: 'SYSTEM-PROMPT-replacement',
        messages: [],
        tools: [],
        catalogRevision: 'c',
        revision: 'r',
      }),
    askApproval: () => Promise.resolve({ allowed: true, scope: 'once' as const }),
    emitter: emitterFor(emitted),
    proposeTerminal: () => {},
    interTurn: {
      claim: () => Promise.resolve({ action: 'continue' as const, absorbed: false }),
      seqIndex: 0,
      wakeRun: false,
    },
    compaction: sources,
  });

  // The REAL runtime pass, so the outcome shape under test is the one the
  // engine reads rather than one this file reshaped.
  const result = await runCompactionPass({
    port: ports.compaction,
    events: ports.events,
    decision: {
      turn: TURN,
      // The transcript the engine measures. Irrelevant to the assertions below
      // -- they are about the REPLACEMENT -- but present because the contract
      // requires it.
      transcript: [{ role: 'user', content: USER_TEXT, id: 'probe-1' }],
      trigger: 'auto',
    } satisfies CompactionDecisionInput,
    signal: new AbortController().signal,
  });

  if (result.kind !== 'replaced') {
    throw new Error(`expected a replacement, got '${result.kind}'`);
  }
  return result.transcript;
}

/** Every block of a message, flattened to a searchable string. */
function blockText(message: ModelMessage): string {
  return typeof message.content === 'string'
    ? message.content
    : message.content.map((block) => JSON.stringify(block)).join('\n');
}

// ============================================================================
// 1. Roles survive the replacement
// ============================================================================

describe('the compaction replacement keeps the roles the transcript had', () => {
  it("does not report the model's own turn as something the user said", async () => {
    const replacement = await replacementFromRealCoordinator();

    // POSITIVE EVIDENCE first. Without it, "the assistant row is an assistant
    // row" would also describe a replacement that dropped the row entirely.
    const withAssistantText = replacement.filter((m) => blockText(m).includes(ASSISTANT_TEXT));
    expect(withAssistantText).toHaveLength(1);
    // The row is PRESENT, and the string is the one this file planted -- read
    // out of the runtime's own vocabulary, not echoed from a local.
    expect(withAssistantText[0]!.id).toBe('a1');

    // THE REGRESSION. A mailbox-shaped mapping answers 'user' here, which tells
    // the model it produced its own answer. `ModelMessage['role']` admits
    // 'assistant', so the loss is the mapping's, not the port's.
    expect(withAssistantText[0]!.role).toBe('assistant');

    // And the user turn stays a user turn -- a mapping that hardcoded
    // 'assistant' would pass the assertion above and fail this one.
    const withUserText = replacement.filter((m) => blockText(m).includes(USER_TEXT));
    expect(withUserText).toHaveLength(1);
    expect(withUserText[0]!.role).toBe('user');
  });

  it('keeps a tool result a tool result rather than a user turn', async () => {
    const replacement = await replacementFromRealCoordinator();

    const withResult = replacement.filter((m) => blockText(m).includes(TOOL_RESULT_TEXT));
    // The result is present and carries its text: the block crossed, it did not
    // become `[unprojectable tool_result block omitted]`.
    expect(withResult).toHaveLength(1);
    expect(withResult[0]!.role).toBe('tool');

    // A tool row the model cannot pair with its call is a result it has to
    // ignore, so the call id has to survive too. Read off the block the runtime
    // carries, not off the transcript row the test planted.
    const blocks = withResult[0]!.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;
    const toolResults = blocks.filter((b) => b.type === 'tool_result');
    expect(toolResults).toHaveLength(1);
    expect(toolResults[0]!.type === 'tool_result' && toolResults[0]!.callId).toBe(TOOL_CALL_ID);
  });
});

// ============================================================================
// 2. Tool blocks survive as blocks
// ============================================================================

describe('the compaction replacement carries tool blocks, not prose about them', () => {
  it('projects tool_use into the runtime block the model port can send', async () => {
    const replacement = await replacementFromRealCoordinator();

    // POSITIVE EVIDENCE: the call row is present at all.
    const callRow = replacement.find((m) => m.id === 'a2');
    expect(callRow).toBeDefined();
    if (callRow === undefined) return;

    // The name and the call id are the two facts a provider needs to pair the
    // call with its result. Both are planted by this file; neither is derivable
    // from anything the mapping computed.
    const blocks = callRow.content;
    expect(Array.isArray(blocks)).toBe(true);
    if (!Array.isArray(blocks)) return;
    const uses = blocks.filter((b) => b.type === 'tool_use');
    expect(uses).toHaveLength(1);
    const use = uses[0]!;
    expect(use.type === 'tool_use' && use.name).toBe(TOOL_NAME);
    expect(use.type === 'tool_use' && use.callId).toBe(TOOL_CALL_ID);
    // The arguments, so the model can see WHAT it asked for. The mailbox-shaped
    // mapping emitted a single text marker and this assertion is unreachable.
    expect(use.type === 'tool_use' && use.input).toEqual({ path: 'src/index.ts' });
  });

  it('still degrades a block the runtime genuinely cannot express', async () => {
    // The honest counterweight to the two assertions above: the mapping is not
    // "everything crosses". An `image` block has no `ModelContentBlock` arm, so
    // it must become VISIBLE TEXT rather than vanish -- a caller could
    // otherwise not tell an absent row from a dropped block.
    const { toRuntimeMessage } = await import('../run-engine-ports.js');
    const projected = toRuntimeMessage({
      role: 'user',
      id: 'img-1',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: 'image/png', data: 'iVBORw0KGgo=' },
        },
      ],
    } as unknown as Message);

    const text = blockText(projected);
    expect(text).toContain('image');
    expect(text).toContain('omitted');
    // And the role is unaffected by the degraded block.
    expect(projected.role).toBe('user');
  });
});

// ============================================================================
// 3. The mailbox caller is unchanged
// ============================================================================

describe('the mailbox caller is not disturbed by the shared mapping', () => {
  it('still projects an injected row as a user turn', async () => {
    // `buildInterTurnPort` maps the capture array the legacy claim fills, and
    // every row in it is a runtime-context injection already built as
    // `role: 'user'` (`message-projectors.ts:104-117`). The mapping no longer
    // FORCES that, so this is the assertion that the input still justifies it --
    // it is the behaviour the old hardcoding produced by accident.
    const { buildInterTurnPort } = await import('../run-engine-ports.js');
    const port = buildInterTurnPort({
      claim: async (input) => {
        // Exactly what `projectRuntimeContextToProviderMessage` produces.
        input.messages.push({
          id: 'mailbox-1',
          role: 'user',
          content: 'MAILBOX-GUIDANCE-3e0b52: check the failing test',
          timestamp: CREATED_AT,
          metadata: { runtimeContext: true, source: 'mailbox' },
        } as unknown as Message);
        return { action: 'continue', absorbed: true };
      },
      seqIndex: 0,
      wakeRun: false,
    });

    const swept = await port.sweep({ runId: RUN_ID, checkpoint: 'before_model_turn' });
    expect(swept.injected).toHaveLength(1);
    const injected = swept.injected[0]!;
    expect(injected.role).toBe('user');
    expect(injected.id).toBe('mailbox-1');
    expect(injected.content).toBe('MAILBOX-GUIDANCE-3e0b52: check the failing test');
  });
});
