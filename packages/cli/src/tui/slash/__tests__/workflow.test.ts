/**
 * packages/cli/src/tui/slash/__tests__/workflow.test.ts
 *
 * `/workflow` — the workflow runs this Host recorded.
 *
 * ## What these cases pin
 *
 *  1. Every run is listed with its workflow, state, origin and the time it
 *     was last updated.
 *
 *  2. A run that belongs to THIS session is marked, so the whole history
 *     and this conversation's slice of it can be read from one list.
 *
 *  3. "No runs" and "this Host cannot answer" are different facts and are
 *     rendered differently. A Host that answers 404
 *     `workflow_run_api_unavailable` must NOT be shown an empty list: the
 *     question was never asked of an authority that could answer it.
 *
 *  4. A transport failure is an error, and it says what failed.
 *
 * The handler is called directly rather than through the registry: the
 * registry entry is another writer's file, and a test that depended on it
 * would fail here for a reason that has nothing to do with this command.
 */

import { describe, expect, it, vi } from 'vitest';

import type { HostSessionHttpClient } from '@duya/host/http-client';

import { WORKFLOW_COMMANDS } from '../workflow.js';
import type { TuiSlashContext, TuiSlashHost } from '../types.js';

const SESSION_ID = 's-workflow-1';

const COMMAND = WORKFLOW_COMMANDS[0];
if (COMMAND === undefined) throw new Error('the workflow command is not exported');

/** A Host HTTP error, shaped like the one the client throws. */
function hostError(status: number, code: string): Error {
  return Object.assign(
    new Error(`Duya Host request failed (${status}: ${code})`),
    { status, code },
  );
}

interface Harness {
  readonly notices: string[];
  readonly errors: string[];
  readonly panels: Array<{ title: string; lines: readonly string[] }>;
  /** Everything the command put on the screen, in one string. */
  readonly output: string;
}

/** Run `/workflow` against a client whose run read answers or fails. */
async function run(options: {
  readonly runs?: unknown;
  readonly error?: Error;
  readonly busy?: boolean;
}): Promise<Harness> {
  const notices: string[] = [];
  const errors: string[] = [];
  const panels: Array<{ title: string; lines: readonly string[] }> = [];

  const client = {
    listRuns: vi.fn(async () => {
      if (options.error !== undefined) throw options.error;
      return options.runs ?? [];
    }),
  };
  const tui: TuiSlashHost = {
    printNotice: (text) => { notices.push(text); },
    printError: (text) => { errors.push(text); },
    choose: async () => null,
    showPanel: (title: string, lines: readonly string[]) => { panels.push({ title, lines }); },
  };
  const ctx = {
    client: client as unknown as HostSessionHttpClient,
    session: { id: SESSION_ID },
    tui,
    busy: options.busy ?? false,
  } as unknown as TuiSlashContext;

  await COMMAND.run(ctx, '');

  return {
    notices,
    errors,
    panels,
    output: [
      ...notices,
      ...panels.flatMap((panel) => [panel.title, ...panel.lines]),
      ...errors,
    ].join('\n'),
  };
}

/** One workflow run. */
function workflowRun(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'w-1',
    workflowName: 'build-docs',
    workflowVersionId: null,
    status: 'complete',
    triggerKind: 'manual',
    dedupKey: null,
    params: {},
    waitTill: null,
    retryOf: null,
    pauseMessage: null,
    origin: 'cron',
    scope: 'project',
    projectDir: null,
    parentSessionId: null,
    artifacts: [],
    summary: null,
    finishedAt: 1_700_000_100_000,
    spentTokens: null,
    agentModel: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    ...overrides,
  };
}

describe('/workflow', () => {
  it('lists every run with its workflow, state, origin and update time', async () => {
    const harness = await run({
      runs: [
        workflowRun(),
        workflowRun({ id: 'w-2', workflowName: 'review', status: 'active', origin: 'agent' }),
      ],
    });

    expect(harness.panels).toHaveLength(1);
    expect(harness.panels[0]?.title).toBe('Workflow runs');
    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('2 workflow runs');
    expect(body).toContain('build-docs');
    expect(body).toContain('complete');
    expect(body).toContain('cron');
    expect(body).toContain('review');
    expect(body).toContain('active');
    expect(body).toContain('agent');
    // The timestamp is printed in UTC so two terminals agree on the column.
    expect(body).toContain('2023-11-14 22:15');
  });

  it('marks the runs that belong to this session', async () => {
    const harness = await run({
      runs: [
        workflowRun({ id: 'w-1', workflowName: 'mine', parentSessionId: SESSION_ID }),
        workflowRun({ id: 'w-2', workflowName: 'other', parentSessionId: 's-other' }),
      ],
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    const mineRow = body.split('\n').find((line) => line.includes('mine')) ?? '';
    const otherRow = body.split('\n').find((line) => line.includes('other')) ?? '';
    expect(mineRow).toContain('← this session');
    expect(otherRow).not.toContain('← this session');
  });

  it('says an empty list is an empty list', async () => {
    const harness = await run({ runs: [] });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('No workflow runs.');
    expect(harness.output).not.toContain('cannot answer');
  });

  it('tells a Host that cannot answer apart from one with no runs', async () => {
    const harness = await run({
      error: hostError(404, 'workflow_run_api_unavailable'),
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('This Host does not serve the workflow runs, so it cannot answer.');
    expect(body).toContain('workflow_run_api_unavailable');
    expect(body).not.toContain('No workflow runs.');
  });

  it('reports a transport failure as an error', async () => {
    const harness = await run({ error: hostError(500, 'internal_error') });

    expect(harness.errors.join('\n')).toContain('Could not read the workflow runs');
    expect(harness.errors.join('\n')).toContain('internal_error');
  });

  it('keeps a malformed record from taking the listing down', async () => {
    const harness = await run({
      runs: [workflowRun(), 'not-a-record', null],
    });

    const body = harness.panels[0]?.lines.join('\n') ?? '';
    expect(body).toContain('1 workflow run');
    expect(body).toContain('build-docs');
  });

  it('reads while a turn is streaming', async () => {
    const harness = await run({ runs: [workflowRun()], busy: true });

    expect(harness.errors).toEqual([]);
    expect(harness.panels).toHaveLength(1);
  });
});
