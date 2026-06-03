/**
 * electron/services/controlPlaneAudit.ts
 *
 * Audit log for CLI control plane write operations.
 *
 * Records events to a newline-delimited JSONL file at
 * `<userData>/control-plane-audit.log.jsonl`. Never logs API keys,
 * secrets, or session content.
 *
 * Phase 7 lock: the CLI does not write to the audit log; the main
 * process records events on behalf of CLI write requests. This
 * module is the main-process recorder.
 */

import { promises as fs } from 'node:fs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { getLogger, LogComponent } from '../logging/logger';

export type AuditEventKind =
  | 'skill.enable'
  | 'skill.disable'
  | 'plugin.enable'
  | 'plugin.disable';

export interface AuditEvent {
  kind: AuditEventKind;
  id: string;
  ts: number;
  invokedBy: 'cli';
  correlationId?: string;
  /** Optional human-readable note; no secrets. */
  note?: string;
}

const AUDIT_FILENAME = 'control-plane-audit.log.jsonl';

function getAuditPath(userDataDir: string): string {
  return join(userDataDir, AUDIT_FILENAME);
}

/**
 * Append an audit event to the JSONL log. Creates the file if
 * needed. Best-effort; never throws into the caller.
 */
export async function appendAuditEvent(
  userDataDir: string,
  event: AuditEvent,
): Promise<void> {
  const log = getLogger();
  const path = getAuditPath(userDataDir);
  try {
    await fs.mkdir(userDataDir, { recursive: true });
    const line = JSON.stringify(event) + '\n';
    await fs.appendFile(path, line, 'utf-8');
  } catch (err) {
    log.warn(
      'controlPlaneAudit: failed to append event',
      { kind: event.kind, id: event.id, error: err instanceof Error ? err.message : String(err) },
      LogComponent.Skills,
    );
  }
}

/**
 * Read the audit log entries (most recent N). Returns an empty
 * array if the file does not exist or is malformed. Never throws.
 */
export async function readAuditEvents(
  userDataDir: string,
  limit: number = 50,
): Promise<AuditEvent[]> {
  const path = getAuditPath(userDataDir);
  if (!existsSync(path)) return [];
  try {
    const raw = await fs.readFile(path, 'utf-8');
    const lines = raw.split('\n').filter((l) => l.length > 0);
    const recent = lines.slice(-limit);
    const out: AuditEvent[] = [];
    for (const line of recent) {
      try {
        out.push(JSON.parse(line) as AuditEvent);
      } catch {
        // skip malformed line
      }
    }
    return out;
  } catch {
    return [];
  }
}