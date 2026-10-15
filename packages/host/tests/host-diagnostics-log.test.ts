/**
 * Where Host run diagnostics go.
 *
 * The property under test is not "a file gets written" — it is the DECISION:
 * an embedded Host must not write to a terminal it does not own. That decision
 * is one function, and getting it wrong is what made `duya tui` unreadable, so
 * it gets pinned directly.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  createFileDiagnosticsLogger,
  createStdioDiagnosticsLogger,
  resolveDiagnosticsSink,
  resolveHostDiagnosticsLogPath,
} from '../src/host-diagnostics-log.js';

const roots: string[] = [];

function tempRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-diag-'));
  roots.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('resolveDiagnosticsSink', () => {
  it('sends an ephemeral (embedded) Host to a file', () => {
    // `duya tui` starts its Host in-process, inside a full-screen terminal UI.
    // stdio here is what buried the user's turn under worker stderr.
    expect(resolveDiagnosticsSink({ ephemeral: true })).toBe('file');
  });

  it('keeps stdio for a long-lived Host that owns its terminal', () => {
    expect(resolveDiagnosticsSink({})).toBe('stdio');
    expect(resolveDiagnosticsSink({ ephemeral: false })).toBe('stdio');
  });

  it('lets the caller override the inferred sink', () => {
    expect(resolveDiagnosticsSink({ ephemeral: true, diagnostics: 'stdio' })).toBe('stdio');
    expect(resolveDiagnosticsSink({ diagnostics: 'file' })).toBe('file');
  });
});

describe('createFileDiagnosticsLogger', () => {
  it('writes a timestamped record carrying the message and its context', () => {
    const logPath = path.join(tempRoot(), 'logs', 'host-run.log');
    const logger = createFileDiagnosticsLogger(logPath);

    logger.info('Worker spawned', { sessionId: 'abc', pid: 42 });

    const text = fs.readFileSync(logPath, 'utf8');
    expect(text).toContain('[INFO] Worker spawned');
    expect(text).toContain('"sessionId":"abc"');
    expect(text).toContain('"pid":42');
  });

  it('records an error with its message', () => {
    const logPath = path.join(tempRoot(), 'logs', 'host-run.log');
    createFileDiagnosticsLogger(logPath).error('Worker crashed', new Error('boom'), {
      sessionId: 'abc',
    });

    const text = fs.readFileSync(logPath, 'utf8');
    expect(text).toContain('[ERROR] Worker crashed');
    expect(text).toContain('boom');
  });

  it('survives a context bag that cannot be serialized', () => {
    const logPath = path.join(tempRoot(), 'logs', 'host-run.log');
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;

    expect(() =>
      createFileDiagnosticsLogger(logPath).info('still recorded', cyclic),
    ).not.toThrow();
    expect(fs.readFileSync(logPath, 'utf8')).toContain('still recorded');
  });

  it('caps a runaway record instead of writing it whole', () => {
    const logPath = path.join(tempRoot(), 'logs', 'host-run.log');
    createFileDiagnosticsLogger(logPath).info('x'.repeat(100_000));

    const text = fs.readFileSync(logPath, 'utf8');
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain('chars total');
  });

  it('places the log under the data root', () => {
    const root = tempRoot();
    expect(resolveHostDiagnosticsLogPath(root)).toBe(path.join(root, 'logs', 'host-run.log'));
  });
});

describe('createStdioDiagnosticsLogger', () => {
  it('prefixes every line so console output is attributable', () => {
    const lines: string[] = [];
    const logger = createStdioDiagnosticsLogger((_level, line) => lines.push(line));

    logger.info('Worker spawned', { pid: 1 });
    logger.warn('Worker exited with error code');
    logger.error('Worker stderr', new Error('boom'));

    expect(lines[0]).toBe('[host-run] Worker spawned {"pid":1}');
    expect(lines[1]).toBe('[host-run] Worker exited with error code');
    expect(lines[2]).toBe('[host-run] Worker stderr boom');
  });
});
