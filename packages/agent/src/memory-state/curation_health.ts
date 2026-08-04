import * as fs from 'fs';
import * as path from 'path';

/**
 * Curation health report (design §13).
 *
 * Each successful publication appends a JSONL record to
 * `~/.duya/memory-snapshots/manifests/health.log.jsonl`. This feeds
 * future prompt canary metrics and lets the user audit curation
 * behavior over time.
 */

export interface HealthReport {
  run_id: string;
  timestamp: string;
  duration_ms: number;
  inputs: number;
  added: number;
  merged: number;
  retired: number;
  no_change: number;
  rejected: number;
  duplicate_rate: number;
  memory_md_size: number;
  summary_md_size: number;
  entity_files: number;
  policy_version: number | null;
  layout_version: number | null;
}

/**
 * Append a health report as a single JSONL line to
 * `<snapshotRoot>/manifests/health.log.jsonl`.
 *
 * Creates the manifests/ directory if it does not exist. The report
 * is appended (not overwritten) so the log accumulates across runs.
 */
export function appendHealthReport(snapshotRoot: string, report: HealthReport): void {
  const manifestsDir = path.join(snapshotRoot, 'manifests');
  fs.mkdirSync(manifestsDir, { recursive: true });

  const logPath = path.join(manifestsDir, 'health.log.jsonl');
  const line = JSON.stringify(report) + '\n';
  fs.appendFileSync(logPath, line, 'utf8');
}