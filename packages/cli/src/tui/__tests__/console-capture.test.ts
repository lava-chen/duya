/**
 * The TUI's claim on the terminal.
 *
 * blessed renders through its own writer, so `console.log` from anything else
 * in the process lands inline in the transcript with no way to scroll it out.
 * These tests pin the two halves of the fix: console output is diverted, and
 * `process.stdout` — the stream blessed actually draws to — is left alone.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { captureConsoleToFile } from '../console-capture.js';

const roots: string[] = [];

function tempLog(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-console-capture-'));
  roots.push(dir);
  return path.join(dir, 'logs', 'host-run.log');
}

afterEach(() => {
  for (const dir of roots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('captureConsoleToFile', () => {
  it('diverts console output away from the terminal', () => {
    const logPath = tempLog();
    const capture = captureConsoleToFile(logPath);
    try {
      console.info('[host-run] Worker spawned');
      expect(capture.capturedCount()).toBe(1);
    } finally {
      capture.restore();
    }

    const text = fs.readFileSync(logPath, 'utf8');
    expect(text).toContain('[INFO] [host-run] Worker spawned');
  });

  it('does not touch process.stdout — that is the stream blessed draws on', () => {
    const before = process.stdout.write;
    const capture = captureConsoleToFile(tempLog());
    try {
      expect(process.stdout.write).toBe(before);
    } finally {
      capture.restore();
    }
    expect(process.stdout.write).toBe(before);
  });

  it('restores the original console methods, idempotently', () => {
    const logPath = tempLog();
    const info = console.info;
    const capture = captureConsoleToFile(logPath);

    expect(console.info).not.toBe(info);
    capture.restore();
    expect(console.info).toBe(info);

    capture.restore();
    expect(console.info).toBe(info);

    // And the console a LATER capture installs is the truly original one, not
    // a previously-captured wrapper.
    const afterFirst = console.info;
    captureConsoleToFile(logPath).restore();
    expect(console.info).toBe(afterFirst);
  });

  it('keeps Error objects readable instead of stringifying them as {}', () => {
    const logPath = tempLog();
    const capture = captureConsoleToFile(logPath);
    try {
      console.error(new Error('worker exploded'));
    } finally {
      capture.restore();
    }
    expect(fs.readFileSync(logPath, 'utf8')).toContain('worker exploded');
  });

  it('never throws when the log cannot be written', () => {
    // A path whose parent is a file, not a directory: mkdirSync will fail.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-cc-'));
    roots.push(base);
    const blocker = path.join(base, 'blocker');
    fs.writeFileSync(blocker, 'not a directory');

    const capture = captureConsoleToFile(path.join(blocker, 'nested', 'host-run.log'));
    try {
      expect(() => console.warn('still must not throw')).not.toThrow();
      expect(capture.capturedCount()).toBe(1);
    } finally {
      capture.restore();
    }
  });
});
