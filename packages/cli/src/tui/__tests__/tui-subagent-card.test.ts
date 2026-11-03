/**
 * A subagent spawn: what the transcript says it is, and what the lifecycle is
 * allowed to change about it.
 *
 * The two halves are tested together on purpose, because their ORDER is the
 * design: identity comes from the `task` call's own arguments (durable, in the
 * transcript, replayable) and only the outcome comes from the `agent_progress`
 * frames (best-effort, droppable). A test that only fed frames would pass with
 * the priority reversed and would hide the bug this exists to prevent — an
 * agent row that says nothing when the event stream goes quiet.
 */

import { describe, expect, it } from 'vitest';

import { TranscriptModel } from '../blocks.js';
import { renderOneBlock, renderTranscript, type RenderOptions } from '../transcript-view.js';
import { formatToolResult } from '../tool-render.js';
import {
  isSubagentTool,
  readSubagentSpec,
  shortAgentId,
  subagentBudgetLabel,
  subagentDisplayName,
  subagentIdentityParts,
  subagentIdentityText,
  subagentOutcomeLabel,
} from '../subagent.js';

const OPTIONS: RenderOptions = { expanded: false, showToolResults: true, toolResultLines: 5 };

/** What the reader actually sees: the tagged string minus its colour markup. */
function plain(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

const SPAWN = {
  name: 'Robie',
  subagent_type: 'explorer',
  model: 'gpt-5',
  effort: 'high',
  description: 'find the typecheck command',
  prompt: 'Find the command the repo uses to typecheck.\nReport the exact command.',
};

describe('reading a spawn off the tool call', () => {
  it('recognises both names the runtime has used for the tool', () => {
    expect(isSubagentTool('task')).toBe(true);
    // A saved transcript replayed through this renderer still says `Agent`.
    expect(isSubagentTool('Agent')).toBe(true);
    expect(isSubagentTool('  task  ')).toBe(true);
    expect(isSubagentTool('bash')).toBe(false);
    expect(isSubagentTool('tasks')).toBe(false);
  });

  it('takes name, role, budget and brief from the arguments', () => {
    expect(readSubagentSpec('task', SPAWN)).toEqual({
      name: 'Robie',
      agentType: 'explorer',
      model: 'gpt-5',
      effort: 'high',
      brief: 'find the typecheck command',
    });
  });

  it('defaults the role instead of leaving it blank', () => {
    const spec = readSubagentSpec('task', { prompt: 'do a thing' });
    // A row with no role reads as an agent of unknown kind; this one really is
    // a general-purpose agent, and the runtime's own default says so.
    expect(spec?.agentType).toBe('general-purpose');
    expect(spec?.model).toBe('');
    expect(spec?.effort).toBe('');
    expect(spec?.name).toBe('');
  });

  it('falls back to the first non-empty prompt line for the brief', () => {
    expect(readSubagentSpec('task', { prompt: '\n\n  do the thing  \nand more' })?.brief).toBe('do the thing');
    // `description` wins when it is there: it is the line the model wrote to be
    // read, while the prompt's first line is often a heading.
    expect(readSubagentSpec('task', { ...SPAWN, description: 'short' })?.brief).toBe('short');
    expect(readSubagentSpec('task', { prompt: '   \n\n' })?.brief).toBe('');
  });

  it('refuses input that is not a record', () => {
    expect(readSubagentSpec('task', undefined)).toBeNull();
    expect(readSubagentSpec('task', 'find the thing')).toBeNull();
    expect(readSubagentSpec('task', ['find the thing'])).toBeNull();
    // Not a spawn tool: no spec even with a well-formed record.
    expect(readSubagentSpec('bash', { description: 'x' })).toBeNull();
  });
});

describe('the identity parts', () => {
  const spec = readSubagentSpec('task', SPAWN)!;

  it('joins model and effort into one budget label', () => {
    expect(subagentBudgetLabel('gpt-5', 'high')).toBe('gpt-5 high');
    // A child that inherits one of the two says only the half it was given.
    expect(subagentBudgetLabel('', 'high')).toBe('high');
    expect(subagentBudgetLabel('gpt-5', '')).toBe('gpt-5');
    expect(subagentBudgetLabel('', '')).toBe('');
  });

  it('disambiguates unnamed agents by the LAST id segment', () => {
    // Ids minted in one breath share their leading bytes, so a prefix names the
    // batch rather than the agent.
    expect(shortAgentId('0192f0aa-7c31-4f9a-9b7e-2d1c4f2a1c33')).toBe('2a1c33');
    expect(shortAgentId('sub_1a2b3c4d')).toBe('2b3c4d');
    expect(shortAgentId('abcdefgh')).toBe('cdefgh');
    expect(shortAgentId('')).toBe('');
    expect(shortAgentId('sub-1')).toBe('1');
  });

  it('names a named agent by its nickname, and an unnamed one by role + id', () => {
    expect(subagentDisplayName(spec, 'call-1')).toBe('Robie');
    const unnamed = readSubagentSpec('task', { prompt: 'x' })!;
    expect(subagentDisplayName(unnamed, 'sub-1a2b3c4d')).toBe('general-purpose (2b3c4d)');
  });

  it('keeps the role as a separate part only when a name is in front of it', () => {
    expect(subagentIdentityParts(spec, 'call-1')).toEqual({
      name: 'Robie',
      role: 'explorer',
      budget: 'gpt-5 high',
    });
    // For an unnamed agent the name already IS the role; printing both would
    // read `general-purpose (2b3c4d) [general-purpose]`.
    const parts = subagentIdentityParts(readSubagentSpec('task', { subagent_type: 'general-purpose' })!, 'sub-2b3c4d');
    expect(parts.role).toBe('');
    expect([parts.name, parts.role, parts.budget].filter((part) => part !== '')).toHaveLength(1);
  });

  it('joins the parts for a surface with no colour to spend', () => {
    expect(subagentIdentityText(spec, 'call-1')).toBe('Robie [explorer] (gpt-5 high)');
    expect(subagentIdentityText(readSubagentSpec('task', { prompt: 'x' })!, 'sub-2b3c4d'))
      .toBe('general-purpose (2b3c4d)');
  });

  it('spells the outcome a reader can act on', () => {
    // `no report` is the honest answer for a settled call whose completion
    // never arrived; `running` there would outlive the work.
    expect(subagentOutcomeLabel('unknown')).toBe('no report');
    expect(subagentOutcomeLabel('running')).toBe('running');
  });
});

describe('the spawn row', () => {
  it('draws name, role and budget in three different colours', () => {
    const model = new TranscriptModel();
    const block = model.upsertTool('call-1', 'task', SPAWN);
    const rendered = renderOneBlock(block, OPTIONS);

    // Each part answers a different question, so each is painted differently:
    // the handle is the accent, the classification is muted, and the spend is
    // the thinking colour. Printing them all one way is what makes a reader
    // read `Robie [explorer]` as two agents.
    expect(rendered).toContain('{cyan-fg}Robie{/cyan-fg}');
    expect(rendered).toContain('{gray-fg}[explorer]{/gray-fg}');
    expect(rendered).toContain('{magenta-fg}(gpt-5 high){/magenta-fg}');
    expect(plain(rendered).split('\n')[0]).toContain('Robie [explorer] (gpt-5 high)');
  });

  it('prints the brief without the fold, and the result behind it', () => {
    const model = new TranscriptModel();
    const block = model.upsertTool('call-1', 'task', SPAWN);
    model.apply({ type: 'tool_result', data: { id: 'call-1', result: 'the command is `npm run typecheck`' } });

    // Collapsed, no tool results: the answer is hidden, the brief is not. The
    // brief is what identifies the agent — behind a fold it would be an agent
    // the reader cannot recognise.
    const folded = plain(renderOneBlock(block, { ...OPTIONS, showToolResults: false }));
    expect(folded).toContain('find the typecheck command');
    expect(folded).not.toContain('npm run typecheck');

    const shown = plain(renderOneBlock(block, OPTIONS));
    expect(shown).toContain('find the typecheck command');
    expect(shown).toContain('the command is `npm run typecheck`');
  });

  it('adds a duration or an outcome only when the child reported one', () => {
    const model = new TranscriptModel();
    const block = model.upsertTool('call-1', 'task', SPAWN);
    expect(plain(renderOneBlock(block, OPTIONS))).not.toContain(' · ');

    model.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_started', subagentId: 'sub-1', parentToolCallId: 'call-1' },
    });
    model.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_completed', subagentId: 'sub-1', status: 'completed', durationMs: 63_000 },
    });
    // A plain completion shows the time it took and nothing else: `completed`
    // is the unmarked default and saying it costs a column.
    expect(plain(renderOneBlock(block, OPTIONS)).split('\n')[0]).toContain(' · 1m 03s');
    expect(plain(renderOneBlock(block, OPTIONS))).not.toContain('completed');

    const failed = new TranscriptModel();
    const failedBlock = failed.upsertTool('call-2', 'task', SPAWN);
    failed.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_started', subagentId: 'sub-2', parentToolCallId: 'call-2' },
    });
    failed.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_completed', subagentId: 'sub-2', status: 'failed', durationMs: 1_000 },
    });
    // A failure is the exception, so it is spelled out instead of the duration.
    expect(plain(renderOneBlock(failedBlock, OPTIONS)).split('\n')[0]).toContain(' · failed');
  });

  it('never folds three spawns into one `3 calls` header', () => {
    const model = new TranscriptModel();
    for (const [index, name] of ['Robie', 'Atlas', 'Wren'].entries()) {
      model.upsertTool(`call-${index}`, 'task', {
        name,
        subagent_type: 'explorer',
        description: `${name} brief`,
      });
      model.apply({ type: 'tool_result', data: { id: `call-${index}`, result: 'done' } });
    }

    const rendered = plain(renderTranscript(model, OPTIONS));
    // The batch header names the VERB, which would erase the three identities
    // that are the entire point of these rows.
    expect(rendered).not.toContain('task 3 calls');
    for (const name of ['Robie', 'Atlas', 'Wren']) expect(rendered).toContain(name);
  });
});

describe('the lifecycle frames', () => {
  function spawned(): { model: TranscriptModel; block: ReturnType<TranscriptModel['upsertTool']> } {
    const model = new TranscriptModel();
    const block = model.upsertTool('call-1', 'task', SPAWN);
    return { model, block };
  }

  it('links a start to the call that spawned it and remembers the child id', () => {
    const { model, block } = spawned();
    const result = model.apply({
      type: 'agent_progress',
      data: {
        agentEventType: 'subagent_started',
        subagentId: 'sub-1',
        parentToolCallId: 'call-1',
      },
    });

    // `mutate`, not `append`: the lifecycle belongs to the existing row.
    expect(result.kind).toBe('mutate');
    expect(block.subagent?.subagentId).toBe('sub-1');
    // The arguments still own the identity; the frame only added the id.
    expect(block.subagent?.spec.name).toBe('Robie');
  });

  it('resolves a completion by child id, without a second lookup table', () => {
    const { model, block } = spawned();
    model.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_started', subagentId: 'sub-1', parentToolCallId: 'call-1' },
    });
    model.apply({
      type: 'agent_progress',
      data: {
        agentEventType: 'subagent_completed',
        subagentId: 'sub-1',
        status: 'completed',
        durationMs: 2_500,
        summary: 'found it in package.json',
      },
    });

    expect(block.subagent?.outcome).toBe('completed');
    expect(block.subagent?.durationMs).toBe(2_500);
    expect(block.subagent?.summary).toBe('found it in package.json');
  });

  it('keeps failed and cancelled as the outcomes they reported', () => {
    for (const status of ['failed', 'cancelled'] as const) {
      const { model, block } = spawned();
      model.apply({
        type: 'agent_progress',
        data: { agentEventType: 'subagent_started', subagentId: 'sub-1', parentToolCallId: 'call-1' },
      });
      model.apply({
        type: 'agent_progress',
        data: { agentEventType: 'subagent_completed', subagentId: 'sub-1', status },
      });
      expect(block.subagent?.outcome).toBe(status);
    }
  });

  it('ignores frames that name a call this transcript never saw', () => {
    const { model } = spawned();
    // A replayed segment, or a run a Desktop started that this terminal is only
    // watching: there is no row to update, so the frame is not content.
    expect(model.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_started', subagentId: 'sub-9', parentToolCallId: 'call-nope' },
    }).kind).toBe('none');
    expect(model.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_completed', subagentId: 'sub-9', status: 'completed' },
    }).kind).toBe('none');
  });

  it('ignores a start that carries no parent call id', () => {
    const { model, block } = spawned();
    // This is the shape the Host used to emit: the field is required by the
    // protocol but was never populated, and the row stayed unattached. The
    // renderer must not guess a parent — a wrong guess paints one agent's
    // outcome onto another's row.
    const result = model.apply({
      type: 'agent_progress',
      data: { agentEventType: 'subagent_started', subagentId: 'sub-1' },
    });
    expect(result.kind).toBe('none');
    expect(block.subagent?.subagentId).toBeUndefined();
  });

  it('leaves every other subagent event out of the transcript', () => {
    const { model } = spawned();
    for (const agentEventType of ['heartbeat', 'subagent_message']) {
      expect(model.apply({ type: 'agent_progress', data: { agentEventType, subagentId: 'sub-1' } }).kind)
        .toBe('none');
    }
  });
});

describe('the receipt as a report', () => {
  const RECEIPT = JSON.stringify({
    status: 'completed',
    totalToolUseCount: 3,
    totalDurationMs: 63_000,
    totalTokens: 12_340,
    content: 'The command is `npm run typecheck`.',
  });

  it('turns the JSON receipt into a headline and the answer', () => {
    const report = formatToolResult('task', RECEIPT);
    // Tokens are compacted the way the footer does it: one decimal only while
    // the number is small enough for the decimal to mean something.
    expect(report).toContain('completed · 3 tools · 1m 03s · 12k tokens');
    expect(report).toContain('The command is `npm run typecheck`.');
    // The reader wanted the answer, not the punctuation around it.
    expect(report).not.toContain('"content"');
    expect(formatToolResult('task', JSON.stringify({ status: 'completed', totalTokens: 9_400, content: 'x' })))
      .toContain('9.4k tokens');
  });

  it('says `background` for a spawn that has not finished', () => {
    const report = formatToolResult('task', JSON.stringify({
      status: 'running',
      background: true,
      content: 'started',
    }));
    // Neither `completed` nor `failed` is honest here: the work has not
    // happened yet in one direction and was not rejected in the other.
    expect(report).toContain('background');
    expect(report).not.toContain('completed');
  });

  it('leads with the error, then still shows what came back', () => {
    const report = formatToolResult('task', JSON.stringify({
      status: 'failed',
      error: 'child ran out of turns',
      content: 'partial answer',
    }));
    expect(report?.indexOf('error: child ran out of turns'))
      .toBeLessThan(report?.indexOf('partial answer') ?? 0);
  });

  it('passes through anything that is not a receipt', () => {
    // Not JSON, or a JSON object with neither half of a receipt: the raw text
    // is the honest thing to print.
    expect(formatToolResult('task', 'not json at all')).toBe('not json at all');
    expect(formatToolResult('task', JSON.stringify({ status: 'completed' })))
      .toBe(JSON.stringify({ status: 'completed' }));
  });
});
