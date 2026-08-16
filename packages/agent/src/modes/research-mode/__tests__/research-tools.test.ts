/**
 * Research mode tools tests (plan 423 Phase 2).
 *
 * Verifies research_start / research_report drive the tracker lifecycle and
 * persist on real transitions. The db-client is mocked so async persist calls
 * resolve against a fake without a live IPC channel.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  modeStateDb: {
    get: vi.fn(),
    upsert: vi.fn(),
    setStatus: vi.fn(),
    listBySession: vi.fn(),
  },
}));

vi.mock('../../../ipc/db-client.js', () => ({ modeStateDb: mocks.modeStateDb }));

import { researchModeTracker } from '../research-tracker.js';
import {
  getResearchTools,
  RESEARCH_START_TOOL_NAME,
  RESEARCH_REPORT_TOOL_NAME,
  RESEARCH_CONTINUE_TOOL_NAME,
  RESEARCH_ADVANCE_TOOL_NAME,
  RESEARCH_FANOUT_TOOL_NAME,
  RESEARCH_ERROR_CODES,
} from '../research-tools.js';

function resetTracker(): void {
  // The tracker is a module singleton — reset it to idle between tests.
  if (researchModeTracker.state() !== 'idle') {
    researchModeTracker.transition({ type: 'clear' });
  }
}

describe('research tools', () => {
  beforeEach(() => {
    resetTracker();
    mocks.modeStateDb.upsert.mockReset();
  });

  it('injects research_start, research_report, research_continue, research_advance, and research_fanout', () => {
    const tools = getResearchTools();
    expect(tools.map((t) => t.definition.name)).toEqual([
      RESEARCH_START_TOOL_NAME,
      RESEARCH_REPORT_TOOL_NAME,
      RESEARCH_CONTINUE_TOOL_NAME,
      RESEARCH_ADVANCE_TOOL_NAME,
      RESEARCH_FANOUT_TOOL_NAME,
    ]);
  });

  it('research_start transitions idle → clarifying and persists', async () => {
    const [tool] = getResearchTools();
    const res = await tool.executor.execute(
      { query: 'State of RAG in 2026' },
      '/wd',
      { options: { sessionId: 'sess-1' } } as never,
    );
    expect(res.error).toBe(false);
    const parsed = JSON.parse(res.result) as { started: boolean; state: string };
    expect(parsed.started).toBe(true);
    expect(parsed.state).toBe('clarifying');
    expect(researchModeTracker.query()).toBe('State of RAG in 2026');
    await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
  });

  it('research_start rejects an empty query', async () => {
    const [tool] = getResearchTools();
    const res = await tool.executor.execute({ query: '   ' }, '/wd');
    expect(res.error).toBe(true);
    expect(researchModeTracker.state()).toBe('idle');
  });

  it('research_start reports already-active instead of restarting', async () => {
    researchModeTracker.transition({ type: 'start', query: 'Existing' });
    const [tool] = getResearchTools();
    const res = await tool.executor.execute({ query: 'New' }, '/wd');
    const parsed = JSON.parse(res.result) as { started: boolean; state: string };
    expect(parsed.started).toBe(false);
    expect(res.error).toBe(true);
    expect(researchModeTracker.query()).toBe('Existing');
  });

  it('research_report carries report_markdown through to the result', async () => {
    const [, report] = getResearchTools();
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    researchModeTracker.transition({ type: 'synthesize' });

    const md = '# Report\n\nBody text.';
    const done = await report.executor.execute(
      { completed: true, title: 'My Report', report_markdown: md },
      '/wd',
      { options: { sessionId: 'sess-1' } } as never,
    );
    expect(done.error).toBe(false);
    const parsed = JSON.parse(done.result) as { report_markdown?: string; title?: string };
    expect(parsed.report_markdown).toBe(md);
    expect(parsed.title).toBe('My Report');
  });

  it('research_report reads report content from a local file_path', async () => {
    const [, report] = getResearchTools();
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    researchModeTracker.transition({ type: 'synthesize' });

    const { writeFile, mkdtemp } = await import('node:fs/promises');
    const { join } = await import('node:path');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'research-report-'));
    const file = join(dir, 'report.md');
    const md = '# Report\n\nWritten to disk.';
    await writeFile(file, md, 'utf-8');

    const done = await report.executor.execute(
      { completed: true, title: 'File Report', file_path: file },
      '/wd',
      { options: { sessionId: 'sess-1' } } as never,
    );
    expect(done.error).toBe(false);
    const parsed = JSON.parse(done.result) as { report_markdown?: string; title?: string };
    expect(parsed.report_markdown).toBe(md);
    expect(parsed.title).toBe('File Report');
    expect(researchModeTracker.state()).toBe('complete');
  });

  it('research_report rejects a missing report file', async () => {
    const [, report] = getResearchTools();
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    researchModeTracker.transition({ type: 'synthesize' });

    const done = await report.executor.execute(
      { completed: true, title: 'Nope', file_path: '/does/not/exist/report.md' },
      '/wd',
    );
    expect(done.error).toBe(true);
    const parsed = JSON.parse(done.result) as { error_code: string };
    expect(parsed.error_code).toBe(RESEARCH_ERROR_CODES.REPORT_FILE_READ_FAILED);
    expect(researchModeTracker.state()).toBe('synthesizing');
  });

  it('research_report rejects completed=true with no report content', async () => {
    const [, report] = getResearchTools();
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    researchModeTracker.transition({ type: 'synthesize' });

    const done = await report.executor.execute({ completed: true }, '/wd');
    expect(done.error).toBe(true);
    const parsed = JSON.parse(done.result) as { error_code: string };
    expect(parsed.error_code).toBe(RESEARCH_ERROR_CODES.REPORT_NO_CONTENT);
    expect(researchModeTracker.state()).toBe('synthesizing');
  });

  it('research_report only finalizes from synthesizing', async () => {
    const [, report] = getResearchTools();

    // Not synthesizing → rejected with NOT_SYNTHESIZING.
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    const early = await report.executor.execute({ completed: true }, '/wd');
    expect(early.error).toBe(true);
    const earlyParsed = JSON.parse(early.result) as { error_code: string };
    expect(earlyParsed.error_code).toBe(RESEARCH_ERROR_CODES.NOT_SYNTHESIZING);
    expect(researchModeTracker.state()).toBe('gathering');

    // Advance to synthesizing → accepted, transitions to complete + persists.
    researchModeTracker.transition({ type: 'synthesize' });
    const done = await report.executor.execute(
      { completed: true, title: 'My Report', report_markdown: '# Ready' },
      '/wd',
      { options: { sessionId: 'sess-1' } } as never,
    );
    expect(done.error).toBe(false);
    const doneParsed = JSON.parse(done.result) as { state: string; message: string };
    expect(doneParsed.state).toBe('complete');
    expect(researchModeTracker.state()).toBe('complete');
    await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
  });

  it('research_report with no active run is rejected', async () => {
    const [, report] = getResearchTools();
    const res = await report.executor.execute({ completed: true }, '/wd');
    expect(res.error).toBe(true);
  });

  it('research_report(completed: false) is a status-only no-op', async () => {
    researchModeTracker.transition({ type: 'start', query: 'X' });
    const [, report] = getResearchTools();
    const res = await report.executor.execute({ completed: false, message: 'progress' }, '/wd');
    expect(res.error).toBe(false);
    expect(researchModeTracker.state()).toBe('clarifying');
  });

  it('research_continue is a no-op in an active (non-paused) state', async () => {
    researchModeTracker.transition({ type: 'start', query: 'X' });
    const [, , cont] = getResearchTools();
    const res = await cont.executor.execute({}, '/wd');
    expect(res.error).toBe(true);
    const parsed = JSON.parse(res.result) as { error_code: string; state: string };
    expect(parsed.error_code).toBe(RESEARCH_ERROR_CODES.NOT_PAUSED);
    expect(parsed.state).toBe('clarifying');
  });

  it('research_continue resumes from awaiting_input back to the workflow state and persists', async () => {
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    researchModeTracker.transition({ type: 'ask_user' });
    expect(researchModeTracker.state()).toBe('awaiting_input');

    const [, , cont] = getResearchTools();
    const res = await cont.executor.execute(
      { instruction: 'focus on the 2026 benchmarks' },
      '/wd',
      { options: { sessionId: 'sess-1' } } as never,
    );
    expect(res.error).toBe(false);
    const parsed = JSON.parse(res.result) as { resumed: boolean; state: string };
    expect(parsed.resumed).toBe(true);
    expect(parsed.state).toBe('gathering');
    expect(researchModeTracker.state()).toBe('gathering');
    await vi.waitFor(() => expect(mocks.modeStateDb.upsert).toHaveBeenCalledTimes(1));
  });

  it('research_continue resumes from blocked back to the workflow state', async () => {
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'plan' });
    researchModeTracker.transition({ type: 'block' });
    expect(researchModeTracker.state()).toBe('blocked');

    const [, , cont] = getResearchTools();
    const res = await cont.executor.execute({}, '/wd');
    expect(res.error).toBe(false);
    const parsed = JSON.parse(res.result) as { resumed: boolean; state: string };
    expect(parsed.resumed).toBe(true);
    expect(parsed.state).toBe('planning');
  });

  it('research_continue rejects when no run is active', async () => {
    const [, , cont] = getResearchTools();
    const res = await cont.executor.execute({}, '/wd');
    expect(res.error).toBe(true);
  });

  it('research_continue rejects a completed run', async () => {
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    researchModeTracker.transition({ type: 'synthesize' });
    researchModeTracker.transition({ type: 'report_done' });
    expect(researchModeTracker.state()).toBe('complete');

    const [, , cont] = getResearchTools();
    const res = await cont.executor.execute({}, '/wd');
    expect(res.error).toBe(true);
  });

  it('research_continue resumes a cold-restore folded run', async () => {
    // Fold: active workflow state restore → awaiting_input (plan 423 §3.5).
    researchModeTracker.transition({ type: 'start', query: 'X' });
    researchModeTracker.transition({ type: 'search' });
    const snap = researchModeTracker.snapshot();
    // Simulate a cold start: clear to idle, then restore the persisted snapshot.
    researchModeTracker.transition({ type: 'clear' });
    researchModeTracker.restore(snap);
    expect(researchModeTracker.state()).toBe('awaiting_input');

    const [, , cont] = getResearchTools();
    const res = await cont.executor.execute({}, '/wd');
    expect(res.error).toBe(false);
    const parsed = JSON.parse(res.result) as { resumed: boolean; state: string };
    expect(parsed.resumed).toBe(true);
    expect(researchModeTracker.state()).toBe('gathering');
  });

  it('research_advance walks the full lifecycle clarifying → planning → gathering → evaluating → synthesizing', async () => {
    const tools = getResearchTools();
    const [, , , advance] = tools;
    const start = tools[0];
    await start.executor.execute({ query: 'X' }, '/wd');
    expect(researchModeTracker.state()).toBe('clarifying');

    const expectAdvanceTo = async (next: string) => {
      const res = await advance.executor.execute({}, '/wd');
      expect(res.error).toBe(false);
      const parsed = JSON.parse(res.result) as { advanced: boolean; state: string };
      expect(parsed.advanced).toBe(true);
      expect(parsed.state).toBe(next);
      expect(researchModeTracker.state()).toBe(next);
    };

    await expectAdvanceTo('planning');
    await expectAdvanceTo('gathering');
    await expectAdvanceTo('evaluating');
    await expectAdvanceTo('synthesizing');
  });

  it('research_advance is rejected from synthesizing (use research_report instead)', async () => {
    const tools = getResearchTools();
    const [, , , advance] = tools;
    const start = tools[0];
    await start.executor.execute({ query: 'X' }, '/wd');
    await advance.executor.execute({}, '/wd');
    await advance.executor.execute({}, '/wd');
    await advance.executor.execute({}, '/wd');
    await advance.executor.execute({}, '/wd');
    expect(researchModeTracker.state()).toBe('synthesizing');

    const res = await advance.executor.execute({}, '/wd');
    expect(res.error).toBe(true);
    const parsed = JSON.parse(res.result) as { error_code: string; state: string };
    expect(parsed.error_code).toBe(RESEARCH_ERROR_CODES.NO_ADVANCE);
    expect(parsed.state).toBe('synthesizing');
  });

  it('research_advance is rejected when no run is active', async () => {
    const [, , , advance] = getResearchTools();
    const res = await advance.executor.execute({}, '/wd');
    expect(res.error).toBe(true);
  });
});