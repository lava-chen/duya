/**
 * run-log.ts — per-run workflow runtime log files (plan 564 follow-up).
 *
 * Every workflow run gets ONE append-only text file under
 * `~/.duya/workflow-logs/` (`<workflow>-<runId>.log`), separate from the
 * definition directory (`~/.duya/workflows/` is scanned for `.dwf.ts` files
 * and must stay clean) and from the core-db journal (structured evidence).
 * The text log is the human debugging surface: launch args, every journal
 * record in seq order, and the terminal error — grep-able, no tooling needed.
 *
 * The journal stays the durable structured record (core-db blobs); this file
 * is a best-effort projection. Any fs failure degrades to a no-op writer —
 * logging must never break a run (same discipline as TransportJournalSink).
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import type { JournalRecord } from './journal.js';

export type RunLogLevel = 'info' | 'warn' | 'error';

/** `~/.duya/workflow-logs` — sibling of `workflow-artifacts`, NOT inside `workflows/`. */
export function defaultWorkflowLogsRoot(): string {
  // Test/dev override: keeps suites from writing into the real home directory.
  const override = process.env.DUYA_WORKFLOW_LOGS_ROOT;
  if (override && override.length > 0) return override;
  return join(homedir(), '.duya', 'workflow-logs');
}

/** Filename-safe workflow name for the log filename (keep it greppable). */
function sanitizeName(name: string): string {
  const cleaned = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return cleaned.length > 0 ? cleaned.slice(0, 40) : 'workflow';
}

export interface RunLog {
  /** Absolute file path, or undefined when the writer degraded to a no-op. */
  readonly path: string | undefined;
  line(level: RunLogLevel, message: string): void;
  /** Human-readable one-liner for a journal record (seq/kind/status/summary). */
  record(record: JournalRecord): void;
  close(): void;
}

class NoopRunLog implements RunLog {
  readonly path: string | undefined = undefined;
  line(): void {}
  record(): void {}
  close(): void {}
}

class FileRunLog implements RunLog {
  readonly path: string;

  constructor(
    private readonly fsModule: typeof import('node:fs'),
    filePath: string,
    header: Record<string, unknown>,
  ) {
    this.path = filePath;
    this.line('info', `workflow run log — ${JSON.stringify(header)}`);
  }

  line(level: RunLogLevel, message: string): void {
    try {
      const ts = new Date().toISOString();
      this.fsModule.appendFileSync(this.path, `${ts} [${level}] ${message}\n`, 'utf8');
    } catch {
      // Best-effort: a failed append must never break the run itself.
    }
  }

  record(record: JournalRecord): void {
    const parts: string[] = [`#${record.seq}`, record.kind, record.status];
    if (record.nodeKind !== undefined) parts.push(`<${record.nodeKind}>`);
    if (record.action !== undefined) parts.push(record.action);
    if (record.inputSummary !== undefined) parts.push(`— ${record.inputSummary}`);
    if (record.errorClass !== undefined) parts.push(`errorClass=${record.errorClass}`);
    if (record.durationMs !== undefined) parts.push(`(${record.durationMs}ms)`);
    if (record.usage !== undefined) {
      parts.push(`tokens=${record.usage.inputTokens}+${record.usage.outputTokens}`);
    }
    const level: RunLogLevel = record.status === 'failed' ? 'error' : 'info';
    this.line(level, parts.join(' '));
  }

  close(): void {
    // Append-only per-line writes need no flush; close is a marker only.
  }
}

/**
 * Open (create) the run's log file. Never throws: any filesystem failure —
 * unwritable home, bad path, disk full — degrades to a no-op writer so the
 * run itself is unaffected.
 */
export function openRunLog(
  fsModule: typeof import('node:fs'),
  runId: string,
  workflowName: string,
  header: Omit<Record<string, unknown>, 'runId' | 'workflow'> = {},
): RunLog {
  try {
    const root = defaultWorkflowLogsRoot();
    fsModule.mkdirSync(root, { recursive: true });
    const filePath = join(root, `${sanitizeName(workflowName)}-${sanitizeName(runId)}.log`);
    return new FileRunLog(fsModule, filePath, { runId, workflow: workflowName, ...header });
  } catch {
    return new NoopRunLog();
  }
}
