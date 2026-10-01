/**
 * computer-use-audit.test.ts — plan 454 §6.1.
 *
 * Verifies:
 *   - logComputerUseAction writes JSONL to the date-based path
 *   - truncateArg limits text length and recurses into objects/arrays
 *   - auditFilePathFor produces the expected YYYY-MM-DD.log filename
 *   - I/O failures are non-fatal (warn but do not throw)
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  auditFilePathFor,
  awaitPendingAudits,
  getComputerUseAuditDir,
  logComputerUseAction,
  type ComputerUseAuditRecord,
} from '../computer-use-audit.js';

// We don't actually use Electron's `app`; the implementation falls
// back to os.tmpdir() when the require fails. Override the dir for
// the test by setting the internal mockDir.
function setAuditDir(dir: string): void {
  (getComputerUseAuditDir as unknown as { mockDir?: string }).mockDir = dir;
}

describe('computer-use audit', () => {
  let tempDir: string;
  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'duya-cu-audit-'));
    setAuditDir(tempDir);
  });

  afterEach(async () => {
    delete (getComputerUseAuditDir as unknown as { mockDir?: string }).mockDir;
    await rm(tempDir, { recursive: true, force: true });
  });

  it('auditFilePathFor produces YYYY-MM-DD.log filenames', () => {
    const d = new Date('2026-08-28T12:34:56.000Z');
    expect(auditFilePathFor(d, tempDir)).toMatch(/[/\\]2026-08-28\.log$/);
  });

  it('logComputerUseAction writes one JSONL line', async () => {
    const record: ComputerUseAuditRecord = {
      ts: new Date().toISOString(),
      action: 'click',
      sessionId: 'session-x',
      ok: true,
      userConfirmed: true,
      durationMs: 12,
    };
    logComputerUseAction(record);
    // Wait for the fire-and-forget writer to flush.
    await awaitPendingAudits();
    const file = auditFilePathFor(new Date(record.ts), tempDir);
    const content = await readFile(file, 'utf-8');
    const lines = content.trim().split('\n');
    expect(lines.length).toBe(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.action).toBe('click');
    expect(parsed.ok).toBe(true);
    expect(parsed.userConfirmed).toBe(true);
    expect(parsed.sessionId).toBe('session-x');
  });

  it('truncates long text values', async () => {
    const record: ComputerUseAuditRecord = {
      ts: new Date().toISOString(),
      action: 'type',
      sessionId: 's',
      ok: true,
      userConfirmed: false,
      durationMs: 0,
      args: { text: 'x'.repeat(500) },
    };
    logComputerUseAction(record);
    await awaitPendingAudits();
    const file = auditFilePathFor(new Date(record.ts), tempDir);
    const content = await readFile(file, 'utf-8');
    const parsed = JSON.parse(content.trim());
    expect(typeof parsed.args.text).toBe('string');
    expect(parsed.args.text.endsWith('\u2026')).toBe(true);
    expect(parsed.args.text.length).toBeLessThanOrEqual(201);
  });

  it('recurses into arrays + nested objects when truncating', async () => {
    const record: ComputerUseAuditRecord = {
      ts: new Date().toISOString(),
      action: 'scroll',
      sessionId: 's',
      ok: true,
      userConfirmed: false,
      durationMs: 0,
      args: {
        mods: ['ctrl', 'shift', 'a'.repeat(400)],
        nested: { inner: 'b'.repeat(400) },
      },
    };
    logComputerUseAction(record);
    await awaitPendingAudits();
    const file = auditFilePathFor(new Date(record.ts), tempDir);
    const parsed = JSON.parse((await readFile(file, 'utf-8')).trim());
    expect(parsed.args.mods[2].endsWith('\u2026')).toBe(true);
    expect(parsed.args.nested.inner.endsWith('\u2026')).toBe(true);
  });

  it('does not throw when the audit directory is unwritable', () => {
    // /this/path/does/not/exist is not creatable on Windows the same
    // way — but appendFile will reject. The contract is "fire and
    // forget; never throw". We just verify no exception escapes.
    setAuditDir('/this/path/does/not/exist');
    const record: ComputerUseAuditRecord = {
      ts: new Date().toISOString(),
      action: 'wait',
      sessionId: 's',
      ok: true,
      userConfirmed: false,
      durationMs: 0,
    };
    expect(() => logComputerUseAction(record)).not.toThrow();
    // Restore for cleanup.
    setAuditDir(tempDir);
  });
});