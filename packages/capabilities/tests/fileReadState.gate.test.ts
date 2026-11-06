import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, statSync, utimesSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EditTool } from '../src/EditTool/EditTool.js';
import { ReadTool } from '../src/ReadTool/ReadTool.js';
import { WriteTool } from '../src/WriteTool/WriteTool.js';
import {
  beginFileReadSession,
  clearFileReadState,
  computeContentSha,
  evaluateReadFreshness,
  invalidateFileRead,
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

describe('read-first gate switch is session-scoped', () => {
  it('does not let one session\'s config govern another session\'s tool call', async () => {
    // The bug a single module-level boolean introduced: session B turning the
    // gate off silently relaxed it for session A, whose tool calls are still
    // in flight in the same worker process.
    setReadFirstGateEnabled(true, 'session-a');
    setReadFirstGateEnabled(false, 'session-b');
    expect(isReadFirstGateEnabled('session-a')).toBe(true);
    expect(isReadFirstGateEnabled('session-b')).toBe(false);

    const path = join(root, 'a.txt');
    const ctx = (sessionId: string) =>
      ({ toolUseId: 'tu', options: { sessionId } } as unknown as Parameters<EditTool['execute']>[2]);
    const input = { file_path: path, old_string: 'beta', new_string: 'BETA' };

    const refused = await new EditTool().execute(input, root, ctx('session-a'));
    expect(refused.error).toBe(true);
    expect(String(refused.result)).toContain('File has not been read yet');

    const allowed = await new EditTool().execute(input, root, ctx('session-b'));
    expect(allowed.error).toBeFalsy();
  });

  it('falls back to the process default for a scope that was never bound', () => {
    // Delegated child sessions get their own read-ledger scope but never go
    // through the worker session factory, so they must inherit the default.
    setReadFirstGateEnabled(false);
    setReadFirstGateEnabled(true, 'bound-session');
    expect(isReadFirstGateEnabled('unbound-child')).toBe(false);
    expect(isReadFirstGateEnabled('bound-session')).toBe(true);
  });

  it('drops the previous session\'s bindings on a new top-level session', () => {
    setReadFirstGateEnabled(false, 'session-a');
    expect(isReadFirstGateEnabled('session-a')).toBe(false);

    beginFileReadSession('session-b');
    // The stale binding is gone; session-b has not been configured yet, so it
    // reads the process default rather than session-a's value.
    expect(isReadFirstGateEnabled('session-a')).toBe(true);
    expect(isReadFirstGateEnabled('session-b')).toBe(true);
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

describe('per-session ledgers', () => {
  it('does not let one session borrow another session\'s read', () => {
    const path = join(root, 'a.txt');
    beginFileReadSession('parent');
    const s = statSync(path);
    recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size, isFullView: true }, 'parent');

    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'parent')).toBe('fresh');
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'child')).toBe('never-read');
  });

  it('keeps a child session\'s read out of the active parent ledger', () => {
    const path = join(root, 'a.txt');
    beginFileReadSession('parent');
    const s = statSync(path);
    recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size, isFullView: true }, 'child');

    // Active session is still the parent; a scopeless read must not see it.
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'))).toBe('never-read');
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'child')).toBe('fresh');
  });

  it('invalidates one session without touching another', () => {
    const path = join(root, 'a.txt');
    const s = statSync(path);
    recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size, isFullView: true }, 'parent');
    recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size, isFullView: true }, 'child');

    invalidateFileRead(path, 'child');
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'child')).toBe('never-read');
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'parent')).toBe('fresh');
  });

  it('clears a single session by scope, and everything without one', () => {
    const path = join(root, 'a.txt');
    const s = statSync(path);
    recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size, isFullView: true }, 'parent');
    recordFileRead(path, { mtimeMs: s.mtimeMs, size: s.size, isFullView: true }, 'child');

    clearFileReadState('child');
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'child')).toBe('never-read');
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'parent')).toBe('fresh');

    clearFileReadState();
    expect(evaluateReadFreshness(path, s, readFileSync(path, 'utf-8'), 'parent')).toBe('never-read');
  });

  it('keeps a spawned child from resetting the parent ledger', () => {
    const path = join(root, 'a.txt');
    beginFileReadSession('parent');
    anchorFullRead(path);

    // A child session is a different scope, not a new top-level session: it
    // must not call beginFileReadSession, so the parent entry survives.
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'), 'child')).toBe('never-read');
    expect(evaluateReadFreshness(path, statSync(path), readFileSync(path, 'utf-8'), 'parent')).toBe('fresh');
  });
});

describe('tool-level scoping', () => {
  const ctx = (sessionId: string) =>
    ({ toolUseId: 'tu', options: { sessionId } } as unknown as Parameters<EditTool['execute']>[2]);

  it('refuses a parent edit anchored only by the child session', async () => {
    const path = join(root, 'a.txt');
    // Child reads the file under its own session id.
    const read = await new ReadTool().execute({ file_path: path }, root, ctx('child-session'));
    expect(read.error).toBeFalsy();

    const result = await new EditTool().execute(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      root,
      ctx('parent-session'),
    );
    expect(result.error).toBe(true);
    expect(String(result.result)).toContain('File has not been read yet');
  });

  it('allows an edit anchored by the same session that read', async () => {
    const path = join(root, 'a.txt');
    const read = await new ReadTool().execute({ file_path: path }, root, ctx('parent-session'));
    expect(read.error).toBeFalsy();

    const result = await new EditTool().execute(
      { file_path: path, old_string: 'beta', new_string: 'BETA' },
      root,
      ctx('parent-session'),
    );
    expect(result.error).toBeFalsy();
    expect(readFileSync(path, 'utf-8')).toContain('BETA');
  });

  it('keeps a parent write out of the child ledger', async () => {
    const path = join(root, 'a.txt');
    const result = await new WriteTool().execute(
      { file_path: path, content: 'rewritten\n' },
      root,
      ctx('parent-session'),
    );
    // Parent never read it, so the write is refused — proving the gate ran
    // against the parent's (empty) ledger.
    expect(result.error).toBe(true);
    expect(String(result.result)).toContain('File has not been read yet');
  });
});
