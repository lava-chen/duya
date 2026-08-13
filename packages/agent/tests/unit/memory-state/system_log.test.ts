import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { writeSystemLog, listSystemLog, systemLogPathFor } from '../../../src/memory-state/system_log';

describe('memory-system-log', () => {
  let tmpRoot: string;

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-syslog-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes one line per event to the correct daily file', () => {
    const ts = Date.UTC(2026, 7, 13, 10, 0, 0); // 2026-08-13
    writeSystemLog(
      {
        phase: 'phase1',
        eventType: 'extract_committed',
        message: 'Rollout abc-123 extracted',
        rolloutId: 'abc-123',
        ts,
      },
      tmpRoot
    );

    const dailyPath = systemLogPathFor(ts, tmpRoot);
    expect(fs.existsSync(dailyPath)).toBe(true);
    const lines = fs.readFileSync(dailyPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.phase).toBe('phase1');
    expect(parsed.event_type).toBe('extract_committed');
    expect(parsed.message).toBe('Rollout abc-123 extracted');
    expect(parsed.rollout_id).toBe('abc-123');
    expect(parsed.ts).toBe(ts);
    expect(parsed.level).toBe('info');
  });

  it('appends to the same daily file for multiple events', () => {
    const ts = Date.UTC(2026, 7, 13, 10, 0, 0);
    writeSystemLog({ phase: 'phase1', eventType: 'event1', message: 'first', ts }, tmpRoot);
    writeSystemLog({ phase: 'phase2', eventType: 'event2', message: 'second', ts }, tmpRoot);

    const dailyPath = systemLogPathFor(ts, tmpRoot);
    const lines = fs.readFileSync(dailyPath, 'utf8').split('\n').filter(Boolean);
    expect(lines).toHaveLength(2);
  });

  it('creates separate daily files for different days', () => {
    const day1 = Date.UTC(2026, 7, 13, 10, 0, 0);
    const day2 = Date.UTC(2026, 7, 14, 10, 0, 0);
    writeSystemLog({ phase: 'phase1', eventType: 'e1', message: 'day1', ts: day1 }, tmpRoot);
    writeSystemLog({ phase: 'phase1', eventType: 'e2', message: 'day2', ts: day2 }, tmpRoot);

    const p1 = systemLogPathFor(day1, tmpRoot);
    const p2 = systemLogPathFor(day2, tmpRoot);
    expect(p1).not.toBe(p2);
    expect(fs.existsSync(p1)).toBe(true);
    expect(fs.existsSync(p2)).toBe(true);

    const lines1 = fs.readFileSync(p1, 'utf8').split('\n').filter(Boolean);
    const lines2 = fs.readFileSync(p2, 'utf8').split('\n').filter(Boolean);
    expect(lines1).toHaveLength(1);
    expect(lines2).toHaveLength(1);
  });

  it('does not throw on write failure (best-effort)', () => {
    // Passing a non-existent root should be caught internally.
    const badRoot = path.join(os.tmpdir(), 'nonexistent-dir-that-will-never-exist');
    expect(() => {
      writeSystemLog({ phase: 'phase1', eventType: 'test', message: 'noop' }, badRoot);
    }).not.toThrow();
  });

  it('listSystemLog returns entries newest-first across multiple daily files', () => {
    const day1 = Date.UTC(2026, 7, 13, 10, 0, 0);
    const day2 = Date.UTC(2026, 7, 14, 10, 0, 0);
    writeSystemLog({ phase: 'phase1', eventType: 'old', message: 'oldest', ts: day1 }, tmpRoot);
    writeSystemLog({ phase: 'phase2', eventType: 'new', message: 'newest', ts: day2 }, tmpRoot);

    const result = listSystemLog({ limit: 5 }, tmpRoot);
    expect(result.total).toBe(2);
    expect(result.entries).toHaveLength(2);
    // Newest first
    expect(result.entries[0].event_type).toBe('new');
    expect(result.entries[0].phase).toBe('phase2');
    expect(result.entries[1].event_type).toBe('old');
    expect(result.entries[1].phase).toBe('phase1');
  });

  it('listSystemLog filters by phase', () => {
    const ts = Date.UTC(2026, 7, 13, 10, 0, 0);
    writeSystemLog({ phase: 'phase1', eventType: 'extract', message: 'e1', ts }, tmpRoot);
    writeSystemLog({ phase: 'phase2', eventType: 'curate', message: 'c1', ts }, tmpRoot);

    const phase1 = listSystemLog({ limit: 5, phase: 'phase1' }, tmpRoot);
    expect(phase1.total).toBe(2);
    expect(phase1.entries).toHaveLength(1);
    expect(phase1.entries[0].event_type).toBe('extract');

    const phase2 = listSystemLog({ limit: 5, phase: 'phase2' }, tmpRoot);
    expect(phase2.entries).toHaveLength(1);
    expect(phase2.entries[0].event_type).toBe('curate');
  });

  it('listSystemLog filters by runId', () => {
    const ts = Date.UTC(2026, 7, 13, 10, 0, 0);
    writeSystemLog({ phase: 'phase2', eventType: 'run_started', message: 'run A', runId: 'run-a', ts }, tmpRoot);
    writeSystemLog({ phase: 'phase2', eventType: 'run_started', message: 'run B', runId: 'run-b', ts }, tmpRoot);

    const result = listSystemLog({ limit: 5, runId: 'run-a' }, tmpRoot);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0].run_id).toBe('run-a');
  });

  it('listSystemLog returns empty when no log directory exists', () => {
    const emptyRoot = path.join(os.tmpdir(), 'duya-syslog-empty-' + Date.now());
    const result = listSystemLog({ limit: 5 }, emptyRoot);
    expect(result.entries).toHaveLength(0);
    expect(result.total).toBe(0);
  });
});