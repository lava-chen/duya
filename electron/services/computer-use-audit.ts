/**
 * computer-use-audit.ts — audit log for OS-side actions (plan 454 §5 Task C).
 *
 * Writes one JSONL line per computer_use action to
 *   %APPDATA%/DUYA/logs/computer-use/YYYY-MM-DD.log
 *
 * (macOS: ~/Library/Application Support/DUYA/logs/computer-use/...)
 * (Linux: ~/.local/share/DUYA/logs/computer-use/...)
 *
 * Schema per line (compact, easy to grep):
 *   { ts, action, sessionId, ok, userConfirmed, durationMs, errorCode?, args? }
 *
 * Why a separate log directory:
 *   - Computer Use actions are sensitive enough to deserve their own
 *     review surface (different retention policy, separate rotation).
 *   - Aligns with the existing `LogComponent` rotation machinery
 *     (electron/logging/logger.ts) but with its own threshold so a
 *     long computer-use session doesn't drown the main app log.
 *
 * The writer is fire-and-forget — `logComputerUseAction` returns
 * immediately. I/O errors are logged via the structured logger but
 * never block the action itself.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { app } from 'electron';

import { getLogger, LogComponent } from '../logging/logger.js';

const logger = getLogger();

/** Shape of a single audit record. Keep this stable — the renderer
 *  UI replays from this same shape (Phase 3 Task E). */
export interface ComputerUseAuditRecord {
  /** ISO timestamp. */
  ts: string;
  /** Action name (e.g. 'click', 'type'). */
  action: string;
  /** Agent session ID — empty for wakeless runs. */
  sessionId: string;
  /** Whether the action succeeded. */
  ok: boolean;
  /** Whether the user explicitly confirmed (destructive actions). */
  userConfirmed: boolean;
  /** Approximate duration in ms (when available). */
  durationMs: number | null;
  /** Structured error code (when ok=false). */
  errorCode?: string;
  /** Compact argument preview (no raw PII; truncated). */
  args?: Record<string, unknown>;
}

/**
 * Resolve the audit log directory for the current platform. Uses
 * Electron's `app.getPath('logs')` when available so packaged builds
 * write into the standard userData location; falls back to `os.tmpdir()`
 * in headless contexts (tests, CLI).
 *
 * Test hook: callers may pre-set a mockDir (via {@link __setAuditDirForTest})
 * to redirect writes to a temporary location. Production code never sets
 * this.
 */
export function getComputerUseAuditDir(): string {
  const mockDir = (getComputerUseAuditDir as unknown as { mockDir?: string })
    .mockDir;
  if (mockDir) return mockDir;
  try {
    // app is only available in the Electron main process.
    return join(app.getPath('logs'), 'computer-use');
  } catch {
    // Fallback for unit tests / CLI runs.
    const { tmpdir } = require('node:os') as typeof import('node:os');
    return join(tmpdir(), 'duya-test-logs', 'computer-use');
  }
}

/**
 * Build the audit file path for a given date.
 */
export function auditFilePathFor(date: Date, dir = getComputerUseAuditDir()): string {
  const yyyy = date.getUTCFullYear();
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');
  return join(dir, `${yyyy}-${mm}-${dd}.log`);
}

/**
 * Truncate a string for safe audit logging. Avoids dumping PII or
 * huge blobs to the log.
 */
function truncateArg(v: unknown, maxLen = 200): unknown {
  if (typeof v === 'string') {
    return v.length > maxLen ? `${v.slice(0, maxLen)}\u2026` : v;
  }
  if (Array.isArray(v)) {
    return v.map((x) => truncateArg(x, maxLen));
  }
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v)) {
      out[k] = truncateArg(val, maxLen);
    }
    return out;
  }
  return v;
}

/**
 * Fire-and-forget audit log write.
 *
 * Never throws — I/O failures are logged via the structured logger
 * so the action itself is not blocked by audit problems.
 */
export function logComputerUseAction(record: ComputerUseAuditRecord): void {
  // Fire-and-forget: do NOT await — audits must not block actions.
  const pending = (async () => {
    try {
      const dir = getComputerUseAuditDir();
      const file = auditFilePathFor(new Date(record.ts), dir);
      await mkdir(dirname(file), { recursive: true });
      const safe: ComputerUseAuditRecord = {
        ...record,
        args: record.args
          ? (truncateArg(record.args) as Record<string, unknown>)
          : undefined,
      };
      await appendFile(file, JSON.stringify(safe) + '\n', 'utf-8');
    } catch (err) {
      logger.warn(
        'computer-use audit write failed',
        {
          action: record.action,
          error: err instanceof Error ? err.message : String(err),
        },
        LogComponent.ComputerUseAudit,
      );
    }
  })();
  pendingWrites.add(pending);
  void pending.finally(() => pendingWrites.delete(pending));
}

/**
 * Test-only: replace the directory resolver. Production code does
 * not call this.
 */
export function __setAuditDirForTest(dir: string): void {
  (getComputerUseAuditDir as unknown as { mockDir?: string }).mockDir = dir;
}

/**
 * Pending audit-write promises. Production code never awaits them
 * (audits must not block actions); tests use {@link awaitPendingAudits}
 * to wait for the file system to settle.
 */
const pendingWrites = new Set<Promise<void>>();

/**
 * Test-only: await every outstanding audit write. Returns when all
 * fire-and-forget tasks have resolved (success or failure). Tests
 * should call this before reading the audit log so they don't race
 * with the writer.
 */
export async function awaitPendingAudits(): Promise<void> {
  while (pendingWrites.size > 0) {
    const all = Array.from(pendingWrites);
    await Promise.all(all);
  }
}