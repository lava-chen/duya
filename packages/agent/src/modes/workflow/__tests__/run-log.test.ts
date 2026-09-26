/**
 * run-log.test.ts — per-run workflow text log (plan 564 follow-up).
 *
 * Pins the three behaviours the debugging workflow depends on:
 *   - the file lands under DUYA_WORKFLOW_LOGS_ROOT (or ~/.duya/workflow-logs)
 *     named `<workflow>-<runId>.log`, with a header line identifying the run;
 *   - `line()` appends human-readable `[level] message` rows;
 *   - `record()` projects a journal record (status/errorClass/duration) and a
 *     filesystem failure degrades to a no-op writer instead of throwing.
 */

import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultWorkflowLogsRoot, openRunLog } from '../run-log.js';
import type { JournalRecord } from '../journal.js';

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-run-log-'));
  process.env.DUYA_WORKFLOW_LOGS_ROOT = dir;
  return dir;
}

function makeRecord(overrides: Partial<JournalRecord> = {}): JournalRecord {
  return {
    seq: 3,
    kind: 'node_result',
    nodeId: 'browser:https://example.com',
    attempt: 1,
    status: 'failed',
    nodeKind: 'browser',
    action: 'browser:https://example.com',
    inputSummary: 'wait input[name=q]',
    errorClass: 'tool_error',
    durationMs: 15021,
    atMs: Date.now(),
    ...overrides,
  };
}

describe('run-log', () => {
  it('honours the env override, else defaults to ~/.duya/workflow-logs', () => {
    const dir = tmpRoot();
    try {
      expect(defaultWorkflowLogsRoot()).toBe(dir);
      delete process.env.DUYA_WORKFLOW_LOGS_ROOT;
      expect(defaultWorkflowLogsRoot()).toBe(path.join(os.homedir(), '.duya', 'workflow-logs'));
    } finally {
      process.env.DUYA_WORKFLOW_LOGS_ROOT = dir;
    }
  });

  it('creates <workflow>-<runId>.log with a header line', () => {
    const dir = tmpRoot();
    const log = openRunLog(fs, 'run-abc', 'hello-browser', { origin: 'library' });
    log.close();

    expect(log.path).toBeDefined();
    expect(path.dirname(log.path!)).toBe(dir);
    expect(path.basename(log.path!)).toBe('hello-browser-run-abc.log');
    const content = fs.readFileSync(log.path!, 'utf8');
    expect(content).toContain('[info] workflow run log —');
    expect(content).toContain('"runId":"run-abc"');
    expect(content).toContain('"workflow":"hello-browser"');
    expect(content).toContain('"origin":"library"');
  });

  it('appends levelled lines and journal record projections', () => {
    tmpRoot();
    const log = openRunLog(fs, 'run-xyz', 'nightly');
    log.line('info', 'launch args={"url":"https://example.com"}');
    log.record(makeRecord());
    log.line('error', 'run failed: browser step 1 (wait input[name=q]) failed: Timeout');
    log.close();

    const content = fs.readFileSync(log.path!, 'utf8');
    expect(content).toContain('[info] launch args={"url":"https://example.com"}');
    expect(content).toContain('[error] #3 node_result failed <browser>');
    expect(content).toContain('— wait input[name=q]');
    expect(content).toContain('errorClass=tool_error');
    expect(content).toContain('(15021ms)');
    expect(content).toContain(
      '[error] run failed: browser step 1 (wait input[name=q]) failed: Timeout',
    );
    // Every row is timestamped.
    for (const line of content.split('\n').filter((l) => l.length > 0)) {
      expect(line).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    }
  });

  it('degrades to a no-op writer when the filesystem fails', () => {
    // A root that cannot be created: a file already exists where the
    // directory should be.
    const blocker = path.join(os.tmpdir(), `duya-run-log-blocker-${process.pid}`);
    fs.writeFileSync(blocker, 'not a dir', 'utf8');
    process.env.DUYA_WORKFLOW_LOGS_ROOT = path.join(blocker, 'sub');
    try {
      const blocked = openRunLog(fs, 'run-bad', 'nightly');
      expect(blocked.path).toBeUndefined();
      expect(() => blocked.line('info', 'ignored')).not.toThrow();
      expect(() => blocked.record(makeRecord())).not.toThrow();
      expect(() => blocked.close()).not.toThrow();
    } finally {
      fs.rmSync(blocker, { force: true });
      tmpRoot(); // restore a writable root for the other tests
    }
  });
});
