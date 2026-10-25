/**
 * packages/cli/src/tui/slash/workflow.ts
 *
 * `/workflow` — the workflow runs this Host has recorded.
 *
 * ## Why the CLI asks the Host
 *
 * The TUI is a pure HTTP client of the Host (see packages/cli/src/chat.ts),
 * so the run list is a Host read: `GET /v1/workflow-runs`. The Host owns
 * the workflow engine and its journal, so the CLI asks it rather than
 * re-deriving anything.
 *
 * ## What this list is
 *
 * Every run the Host recorded — the runs of a project as well as the ones
 * of other sessions. A run that belongs to THIS session is marked, so the
 * list can be read at two levels: the whole history, and the slice of it
 * that this conversation actually caused.
 *
 * ## "No runs" and "this Host cannot answer" are different answers
 *
 * A Host without the workflow-run API answers 404
 * `workflow_run_api_unavailable`. That is not "no workflow runs exist" — it
 * is "this Host cannot answer the question", and the two are rendered
 * differently. An empty list is a fact that was observed; a refusal is not,
 * and a panel that said "no runs" for a Host that never answered would
 * report a fact it never observed.
 */

import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode, showPanel } from './shared.js';

const FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';

/** One workflow run, as the Host reports it. */
interface WorkflowRunEntry {
  readonly id: string;
  readonly workflowName: string;
  readonly status: string;
  readonly origin: string;
  readonly parentSessionId: string | null;
  readonly updatedAt: number | null;
  readonly summary: string | null;
}

/**
 * Narrow one unknown record into the fields this command shows.
 *
 * The payload arrives over HTTP as JSON, so the declared type describes the
 * happy path and not a guarantee: one malformed entry must not take the
 * whole listing down.
 */
function narrowRun(value: unknown): WorkflowRunEntry | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const parentSessionId = record['parentSessionId'];
  const updatedAt = record['updatedAt'];
  const summary = record['summary'];
  return {
    id: typeof record['id'] === 'string' ? record['id'] : '',
    workflowName: typeof record['workflowName'] === 'string' ? record['workflowName'] : '',
    status: typeof record['status'] === 'string' ? record['status'] : 'unknown',
    origin: typeof record['origin'] === 'string' ? record['origin'] : 'unknown',
    parentSessionId: typeof parentSessionId === 'string' && parentSessionId !== ''
      ? parentSessionId
      : null,
    updatedAt: typeof updatedAt === 'number' && Number.isFinite(updatedAt) ? updatedAt : null,
    summary: typeof summary === 'string' && summary !== '' ? summary : null,
  };
}

/**
 * The runs in a payload.
 *
 * `undefined` means the payload is not a run list at all — a different fact
 * from "no workflow runs exist", and one the caller has to report
 * differently.
 */
function readRuns(payload: unknown): readonly WorkflowRunEntry[] | undefined {
  if (!Array.isArray(payload)) return undefined;
  const runs: WorkflowRunEntry[] = [];
  for (const item of payload) {
    const entry = narrowRun(item);
    if (entry !== undefined) runs.push(entry);
  }
  return runs;
}

/** A timestamp in UTC, so two terminals in two zones print the same column. */
function formatTime(value: number | null): string {
  if (value === null) return '(unknown)';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '(unknown)';
  return date.toISOString().replace('T', ' ').slice(0, 16);
}

/** The listing, one row per run. */
function runLines(runs: readonly WorkflowRunEntry[], sessionId: string): string[] {
  if (runs.length === 0) {
    return [
      'No workflow runs.',
      '',
      '  This Host has recorded no workflow run at all — not just none for',
      '  this session.',
    ];
  }

  const rows = runs.map((entry) => ({
    workflow: entry.workflowName !== '' ? entry.workflowName : '(unnamed)',
    status: entry.status,
    origin: entry.origin,
    updated: formatTime(entry.updatedAt),
    mine: entry.parentSessionId !== null && entry.parentSessionId === sessionId,
  }));
  const workflowWidth = Math.max(8, ...rows.map((row) => row.workflow.length));
  const statusWidth = Math.max(6, ...rows.map((row) => row.status.length));
  const originWidth = Math.max(6, ...rows.map((row) => row.origin.length));

  const lines = [`${rows.length} workflow run${rows.length === 1 ? '' : 's'}`];
  for (const row of rows) {
    lines.push(
      `  ${row.workflow.padEnd(workflowWidth)}  ${row.status.padEnd(statusWidth)}  `
      + `${row.origin.padEnd(originWidth)}  ${row.updated}${row.mine ? '  ← this session' : ''}`,
    );
  }
  return lines;
}

const WORKFLOW_COMMAND: TuiSlashCommandDef = {
  name: 'workflow',
  description: 'List the workflow runs this Host recorded',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    let payload: unknown;
    try {
      payload = await ctx.client.listRuns();
    } catch (error) {
      // A Host without the workflow-run API cannot answer. That is not the
      // same as an empty list, and it is rendered differently.
      if (hostErrorCode(error) === 'workflow_run_api_unavailable') {
        showPanel(ctx, 'Workflow runs', [
          'This Host does not serve the workflow runs, so it cannot answer.',
          '',
          '  That is different from "no workflow runs" — here the question was',
          '  never asked of an authority that could answer it.',
          '',
          '  Source: Host workflow runs (GET /v1/workflow-runs),',
          '  404 workflow_run_api_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      ctx.tui.printError(`Could not read the workflow runs: ${describeError(error)}`);
      return { kind: 'handled' };
    }

    const runs = readRuns(payload);
    if (runs === undefined) {
      ctx.tui.printError(
        'Could not read the workflow runs: the Host answered with something that is not a run list.',
      );
      return { kind: 'handled' };
    }

    showPanel(ctx, 'Workflow runs', runLines(runs, ctx.session.id), { footer: FOOTER, scrollable: true });
    return { kind: 'handled' };
  },
};

export const WORKFLOW_COMMANDS: readonly TuiSlashCommandDef[] = [WORKFLOW_COMMAND];
