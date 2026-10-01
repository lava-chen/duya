/**
 * bash-task-handlers.test.ts — unit tests for the `bash-task:read-output`
 * IPC channel (plan 566).
 *
 * Coverage:
 *   - missing / non-string outputFile     → { ok: false, error: 'missing outputFile' }
 *   - non-regular file                    → { ok: false, error: 'not a regular file' }
 *   - empty file                          → { ok: true, output: '', truncated: false }
 *   - tail read honours maxBytes          → truncated: true, tail bytes only
 *   - missing file (ENOENT)               → { ok: false, error: 'not found' }
 *
 * Mirrors the pattern in `git-handlers.test.ts`: mock `electron` to capture
 * `ipcMain.handle` calls and mock `node:fs` to drive the read path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => {
  const fsState = {
    statSync: vi.fn(),
    openSync: vi.fn(() => 7),
    readSync: vi.fn(),
    closeSync: vi.fn(),
  };
  return {
    fs: fsState,
    captured: {
      handle: new Map<string, (event: unknown, ...args: unknown[]) => unknown>(),
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: {
    handle: (channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) => {
      mocks.captured.handle.set(channel, fn);
    },
  },
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
  LogComponent: { Main: 'Main' },
}));

vi.mock('node:fs', () => ({
  statSync: mocks.fs.statSync,
  openSync: mocks.fs.openSync,
  readSync: mocks.fs.readSync,
  closeSync: mocks.fs.closeSync,
}));

import { registerBashTaskHandlers } from '../bash-task-handlers';

function invoke(payload: unknown) {
  const handler = mocks.captured.handle.get('bash-task:read-output');
  if (!handler) throw new Error('bash-task:read-output not registered');
  return handler(undefined, payload) as Record<string, unknown>;
}

describe('bash-task:read-output', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.captured.handle.clear();
    registerBashTaskHandlers();
  });

  it('rejects a missing outputFile', () => {
    expect(invoke({})).toEqual({ ok: false, error: 'missing outputFile' });
    expect(invoke({ outputFile: 42 })).toEqual({ ok: false, error: 'missing outputFile' });
  });

  it('rejects a non-regular file target', () => {
    mocks.fs.statSync.mockReturnValue({ isFile: () => false, size: 10 });
    expect(invoke({ outputFile: '/dev/null' })).toEqual({
      ok: false,
      error: 'not a regular file',
    });
  });

  it('returns an empty tail for an empty file', () => {
    mocks.fs.statSync.mockReturnValue({ isFile: () => true, size: 0 });
    const result = invoke({ outputFile: '/tmp/out.log' });
    expect(result).toEqual({ ok: true, output: '', size: 0, truncated: false });
    expect(mocks.fs.openSync).not.toHaveBeenCalled();
  });

  it('reads the tail and reports truncation beyond maxBytes', () => {
    const size = 300;
    mocks.fs.statSync.mockReturnValue({ isFile: () => true, size });
    mocks.fs.readSync.mockImplementation(
      (_fd: number, buf: Buffer, _off: number, length: number, position: number) => {
        buf.write('x'.repeat(length), 0);
        return length;
      },
    );
    const result = invoke({ outputFile: '/tmp/out.log', maxBytes: 100 });
    expect(result).toEqual({ ok: true, output: 'x'.repeat(100), size: 300, truncated: true });
    // Tail starts at size - maxBytes.
    expect(mocks.fs.readSync).toHaveBeenCalledWith(7, expect.any(Buffer), 0, 100, 200);
  });

  it('maps ENOENT to a recoverable "not found" error', () => {
    mocks.fs.statSync.mockImplementation(() => {
      const err = new Error('enoent') as NodeJS.ErrnoException;
      err.code = 'ENOENT';
      throw err;
    });
    expect(invoke({ outputFile: '/tmp/gone.log' })).toEqual({ ok: false, error: 'not found' });
  });

  it('maps other fs failures to "read failed"', () => {
    mocks.fs.statSync.mockImplementation(() => {
      const err = new Error('eacces') as NodeJS.ErrnoException;
      err.code = 'EACCES';
      throw err;
    });
    expect(invoke({ outputFile: '/tmp/secret.log' })).toEqual({ ok: false, error: 'read failed' });
  });
});
