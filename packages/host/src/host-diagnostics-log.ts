/**
 * Where Host-owned run diagnostics go.
 *
 * ## Why the sink is a choice
 *
 * The Host runs in two very different places. `duya serve` owns its terminal,
 * so writing `[host-run] …` to stderr is exactly right. `duya tui` starts an
 * EPHEMERAL Host inside the same process as a full-screen terminal UI, and
 * blessed drives rendering through its own writer — `console.error` bypasses
 * that writer entirely and lands inline in the middle of the transcript.
 * A worker whose stderr is echoed once per chunk (the previous behaviour, which
 * also logged every chunk twice) is therefore enough to make the TUI unreadable:
 * the user sees diagnostics instead of the answer they asked for.
 *
 * The fix is not "log less" for the TUI's benefit — the same diagnostics are
 * genuinely useful when something goes wrong. The fix is that an EMBEDDED Host
 * must not assume it owns the terminal. {@link resolveDiagnosticsSink} encodes
 * that: ephemeral means embedded means file.
 *
 * ## Why the file sink is bounded
 *
 * Diagnostics that can fill the disk are not diagnostics. The file rotates at
 * {@link MAX_LOG_BYTES} by renaming one generation back, and every write is
 * best-effort: a logger that throws takes the run down with it.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { HostRunExecutionLogger } from './run-execution.js';

/**
 * `stdio` writes to this process's console; `file` appends to
 * `<dataRoot>/logs/host-run.log`. `stdio` is only correct when the Host owns
 * the terminal.
 */
export type HostDiagnosticsSink = 'stdio' | 'file';

/** Rotate once the live file passes this size, keeping one prior generation. */
const MAX_LOG_BYTES = 8 * 1024 * 1024;

/** Per-record cap so one runaway chunk cannot write an unbounded line. */
const MAX_RECORD_CHARS = 4000;

/** The log file for a given data root. */
export function resolveHostDiagnosticsLogPath(dataRoot: string): string {
  return path.join(dataRoot, 'logs', 'host-run.log');
}

/**
 * The sink an embedded Host must use.
 *
 * `ephemeral` is the signal, because that is exactly what "embedded" means
 * here: no runtime descriptor, no process lock, a caller-owned lifetime — the
 * shape `duya tui` uses when it opens a Host inside its own process.
 */
export function resolveDiagnosticsSink(options: {
  readonly ephemeral?: boolean;
  readonly diagnostics?: HostDiagnosticsSink;
}): HostDiagnosticsSink {
  return options.diagnostics ?? (options.ephemeral === true ? 'file' : 'stdio');
}

/** The console sink used by `duya serve` and any long-lived Host. */
export function createStdioDiagnosticsLogger(
  write: (level: string, line: string) => void = defaultStdioWriter,
): HostRunExecutionLogger {
  const emit = (level: string) => (message: string, ...rest: unknown[]): void => {
    write(level, `[host-run] ${message}${formatRest(rest)}`);
  };
  return {
    debug: emit('DEBUG'),
    info: emit('INFO'),
    warn: emit('WARN'),
    error: (message: string, error?: Error, context?: Record<string, unknown>): void => {
      write(
        'ERROR',
        `[host-run] ${message}${error === undefined ? '' : ` ${error.message}`}${formatRest([context])}`,
      );
    },
  };
}

/**
 * The file sink. Never throws: diagnostics are strictly best-effort, and a
 * failed append must not surface as a failed run.
 */
export function createFileDiagnosticsLogger(logPath: string): HostRunExecutionLogger {
  const append = (line: string): void => {
    try {
      rotateIfOversized(logPath);
      fs.mkdirSync(path.dirname(logPath), { recursive: true });
      fs.appendFileSync(logPath, line, 'utf8');
    } catch {
      // Swallowed on purpose — see the module doc.
    }
  };

  const emit = (level: string) => (message: string, ...rest: unknown[]): void => {
    append(`${formatRecord(level, message, rest)}\n`);
  };

  return {
    debug: emit('DEBUG'),
    info: emit('INFO'),
    warn: emit('WARN'),
    error: (message: string, error?: Error, context?: Record<string, unknown>): void => {
      append(
        formatRecord('ERROR', message, error === undefined ? [context] : [error, context]),
      );
    },
  };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatRecord(level: string, message: string, rest: readonly unknown[]): string {
  let line = `[${new Date().toISOString()}] [${level}] ${message}`;
  for (const part of rest) {
    const rendered = renderPart(part);
    if (rendered !== '') line += ` ${rendered}`;
  }
  return truncate(line);
}

/** Render the variadic tail of a log call (error and/or context bag). */
function formatRest(rest: readonly unknown[]): string {
  const rendered = rest.map(renderPart).filter((part) => part !== '');
  return rendered.length === 0 ? '' : ` ${rendered.join(' ')}`;
}

function renderPart(part: unknown): string {
  if (part === undefined || part === null) return '';
  if (part instanceof Error) return part.stack ?? part.message;
  if (typeof part === 'string') return part;
  try {
    const json = JSON.stringify(part);
    return json === undefined ? '' : json;
  } catch {
    // A context bag with a cycle or a BigInt must not kill the log line.
    return '[unserializable]';
  }
}

function truncate(line: string): string {
  return line.length <= MAX_RECORD_CHARS
    ? line
    : `${line.slice(0, MAX_RECORD_CHARS)}… [${line.length} chars total]`;
}

function defaultStdioWriter(level: string, line: string): void {
  if (level === 'ERROR') console.error(line);
  else if (level === 'WARN') console.warn(line);
  else if (level === 'DEBUG') console.debug(line);
  else console.info(line);
}

function rotateIfOversized(logPath: string): void {
  let size: number;
  try {
    size = fs.statSync(logPath).size;
  } catch {
    return; // No file yet.
  }
  if (size < MAX_LOG_BYTES) return;
  try {
    fs.renameSync(logPath, `${logPath}.1`);
  } catch {
    // A locked or missing previous generation is not worth failing a run over.
  }
}
