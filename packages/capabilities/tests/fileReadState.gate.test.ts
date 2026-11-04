import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../src/EditTool/EditTool.js';
import {
  beginFileReadSession,
  clearFileReadState,
  computeContentSha,
  evaluateReadFreshness,
  isReadFirstGateEnabled,
  recordFileRead,
  setReadFirstGateEnabled,
} from '../src/file-read-state.js';

let root: string;

function anchorFullRead(path: string): void {
  const s = statSync(path);
  const content = readFileSync(path, 'utf-8');
  recordFileRead(path, {
    mtimeMs: s.mtimeMs,
    size: s.size,
    isFullView: true,
    contentSha: computeContentSha(content),
  });
}

/** Move mtime far enough that the 1ms tolerance cannot absorb it. */
function touchLater(path: string, secondsLater = 5): void {
  const future = new Date(Date.now() + secondsLater * 1000);
  utimesSync(path, future, future);
}

beforeEach(() => {
  clearFileReadState();
  setReadFirstGateEnabled(true);
  root = mkdtempSync(join(tmpdir(), 'duya-read-state-'));
  writeFileSync(join(root, 'a.txt'), 'alpha\nbeta\n');
});

afterEach(() => {
  setReadFirstGateEnabled(true);
  clearFileReadState();
  rmSync(root, { recursive: true, force: true });
});

describe('evaluateReadFreshness', () => {
  it('reports never-read for an unanchored path', () => {
    const path = join(root, 'a.txt');
    const s = statSync(path);
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'))).toBe('never-read');
  });

  it('reports fresh for an unchanged file', () => {
    const path = join(root, 'a.txt');
    anchorFullRead(path);
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'))).toBe('fresh');
  });

  it('reports stale when size changed', () => {
    const path = join(root, 'a.txt');
    anchorFullRead(path);
    writeFileSync(path, 'alpha\nbeta\ngamma\n');
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'))).toBe('stale');
  });

  it('exempts cosmetic mtime churn when the full-view sha still matches', () => {
    const path = join(root, 'a.txt');
    anchorFullRead(path);
    touchLater(path);
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'))).toBe('fresh');
  });

  it('does not exempt a partial view from mtime drift', () => {
    const path = join(root, 'a.txt');
    const s = statSync(path);
    recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size, isFullView: false });
    touchLater(path);
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'))).toBe('stale');
  });
});

describe('read-first gate switch', () => {
  it('is enabled by default', () => {
    expect(isReadFirstGateEnabled()).toBe(true);
  });

  it('refuses an unread file while enabled', async () => {
    const path = join(root, 'a.txt');
    const result = await new EditTool().execute(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(result.error).toBe(true);
    expect(String(result.result)).toContain('File has not been read yet');
  });

  it('allows an unread file once disabled', async () => {
    setReadFirstGateEnabled(false);
    const path = join(root, 'a.txt');
    const result = await new EditTool().execute(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(path, 'utf-8')).toContain('BETA');
  });

  it('still refuses a stale read while disabled', async () => {
    setReadFirstGateEnabled(false);
    const path = join(root, 'a.txt');
    anchorFullRead(path);
    writeFileSync(path, 'alpha\nbeta changed\n');
    const result = await new EditTool().execute(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      root,
    );
    expect(result.error).toBe(true);
    expect(String(result.result)).toContain('modified after the last read');
  });
});

describe('beginFileReadSession', () => {
  it('drops entries when the session key changes', () => {
    const path = join(root, 'a.txt');
    beginFileReadSession('session-a');
    anchorFullRead(path);
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'))).toBe('fresh');

    beginFileReadSession('session-b');
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'))).toBe('never-read');
  });

  it('keeps entries for a repeated call with the same session key', () => {
    const path = join(root, 'a.txt');
    beginFileReadSession('session-a');
    anchorFullRead(path);
    beginFileReadSession('session-a');
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'))).toBe('fresh');
  });
});
