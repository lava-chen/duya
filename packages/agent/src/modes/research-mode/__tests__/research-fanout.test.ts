/**
 * Research fan-out tool tests (plan 423 Phase 3).
 *
 * Verifies `research_fanout`:
 *  - is injected alongside start/report;
 *  - rejects when not gathering;
 *  - fans out one Research sub-agent per question (via the mocked
 *    SubagentTool), aggregates results, records sub-questions, and persists.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  modeStateDb: {
    get: vi.fn(),
    upsert: vi.fn(),
    setStatus: vi.fn(),
    listBySession: vi.fn(),
  },
  subagentTool: {
    execute: vi.fn(),
  },
}));

vi.mock('../../../ipc/db-client.js', () => ({ modeStateDb: mocks.modeStateDb }));
vi.mock('../../../tool/SubagentTool/SubagentTool.js', () => ({
  subagentTool: mocks.subagentTool,
}));

import { researchModeTracker } from '../research-tracker.js';
import {
  getResearchFanoutTool,
  RESEARCH_FANOUT_TOOL_NAME,
  RESEARCH_FANOUT_ERROR_CODES,
} from '../research-fanout.js';

function okResult(content: string, sessionId?: string) {
  return {
    id: crypto.randomUUID(),
    name: 'Agent',
    result: JSON.stringify({
      agentType: 'Research',
      resolvedAgentType: 'Research',
      description: 'research: q',
      content,
      sessionId: sessionId ?? 'sub-1',
    }),
    error: false,
  };
}

function resetTracker(): void {
  if (researchModeTracker.state() !== 'idle') {
    researchModeTracker.transition({ type: 'clear' });
  }
}

describe('research fan-out tool', () => {
  beforeEach(() => {
    resetTracker();
    mocks.modeStateDb.upsert.mockReset();
    mocks.subagentTool.execute.mockReset();
  });

  it('injects a research_fanout tool', () => {
    const { definition } = getResearchFanoutTool();
    expect(definition.name).toBe(RESEARCH_FANOUT_TOOL_NAME);
  });

  it('rejects when not gathering', async () => {
    researchModeTracker.transition({ type: 'start', query: 'X' }); // clarifying
    const { executor } = getResearchFanoutTool();
    const res = await executor.execute({ questions: ['q1'] }, '/wd');
    expect(res.error).toBe(true);
    const parsed = JSON.parse(res.result) as { error_code: string };
    expect(parsed.error_code).toBe(RESEARCH_FANOUT_ERROR_CODES.NOT_GATHERING);
    expect(mocks.subagentTool.execute).not.toHaveBeenCalled();
  });

  it('rejects invalid input', async () => {
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' }); // gathering
    const { executor } = getResearchFanoutTool();
    const res = await executor.execute({ questions: [] }, '/wd');
    expect(res.error).toBe(true);
    const parsed = JSON.parse(res.result) as { error_code: string };
    expect(parsed.error_code).toBe(RESEARCH_FANOUT_ERROR_CODES.INVALID_INPUT);
  });

  it('fans out one agent per question, aggregates, and persists', async () => {
    mocks.subagentTool.execute
      .mockResolvedValueOnce(okResult('Findings for q1', 'sub-1'))
      .mockResolvedValueOnce(okResult('Findings for q2', 'sub-2'));

    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' }); // gathering

    const { executor } = getResearchFanoutTool();
    const res = await executor.execute(
      { questions: ['q1', 'q2'] },
      '/wd',
      { options: { sessionId: 'sess-1' } } as never,
    );

    expect(res.error).toBe(false);
    expect(mocks.subagentTool.execute).toHaveBeenCalledTimes(2);

    const parsed = JSON.parse(res.result) as {
      launched: number;
      succeeded: number;
      failed: number;
      findings: Array<{ question: string; content: string }>;
    };
    expect(parsed.launched).toBe(2);
    expect(parsed.succeeded).toBe(2);
    expect(parsed.failed).toBe(0);
    expect(parsed.findings).toHaveLength(2);
    expect(parsed.findings[0].question).toBe('q1');
    expect(parsed.findings[1].question).toBe('q2');

    // Sub-questions recorded on the tracker.
    expect(researchModeTracker.subQuestions()).toEqual(['q1', 'q2']);
    // Still in gathering (no state migration).
    expect(researchModeTracker.state()).toBe('gathering');

    await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
  });

  it('tolerates a failing agent and reports the failure', async () => {
    mocks.subagentTool.execute
      .mockResolvedValueOnce(okResult('Findings for good', 'sub-good'))
      .mockResolvedValueOnce({
        id: crypto.randomUUID(),
        name: 'Agent',
        result: JSON.stringify({ error: 'boom' }),
        error: true,
      });

    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' }); // gathering

    const { executor } = getResearchFanoutTool();
    const res = await executor.execute(
      { questions: ['good', 'bad'] },
      '/wd',
      { options: { sessionId: 'sess-2' } } as never,
    );

    expect(res.error).toBe(false);
    const parsed = JSON.parse(res.result) as {
      launched: number;
      succeeded: number;
      failed: number;
    };
    expect(parsed.succeeded).toBe(1);
    expect(parsed.failed).toBe(1);
  });

  it('caps concurrency at RESEARCH_FANOUT_MAX_AGENTS', async () => {
    const questions = Array.from({ length: 8 }, (_, i) => `q${i + 1}`);
    mocks.subagentTool.execute.mockResolvedValue(okResult('x'));

    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });

    const { executor } = getResearchFanoutTool();
    const res = await executor.execute({ questions }, '/wd');
    expect(res.error).toBe(false);
    expect(mocks.subagentTool.execute).toHaveBeenCalledTimes(5);
  });
});