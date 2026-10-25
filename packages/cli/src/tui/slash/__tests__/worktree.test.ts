import { describe, expect, it, vi } from 'vitest';
import { parseWorktreeArguments } from '../worktree.js';
import { resolveTuiSlashCommand } from '../registry.js';
import type { TuiSlashContext } from '../types.js';

describe('/worktree', () => {
  it.each([
    ['', { action: 'status' }],
    ['create feature --base head --branch feature/task', { action: 'enter', name: 'feature', base: 'head', branchName: 'feature/task' }],
    ['enter "/repo/path with spaces"', { action: 'enter', path: '/repo/path with spaces' }],
    ['exit remove', { action: 'exit', disposition: 'remove' }],
    ['sync origin/main', { action: 'sync', base: 'origin/main' }],
    ['abort', { action: 'sync', abort: true }],
    ['recover', { action: 'recover' }],
  ])('parses %s', (input, expected) => expect(parseWorktreeArguments(input)).toEqual(expected));

  it('dispatches through the registered command and refreshes the session cursor', async () => {
    const session = { id: 'session', extensions: { executionLocation: { cwd: '/new' } } };
    const controlSessionCheckout = vi.fn(async () => ({ state: { cwd: '/new', checkout: null, pending: null }, outcome: 'entered' }));
    const ctx = { busy: false, session: { id: 'session' }, client: { controlSessionCheckout, get: async () => session },
      tui: { printError: vi.fn(), showPanel: vi.fn(), printNotice: vi.fn() } } as unknown as TuiSlashContext;
    expect(await resolveTuiSlashCommand('worktree')!.run(ctx, 'create feature')).toEqual({ kind: 'session_updated', session });
    expect(controlSessionCheckout).toHaveBeenCalledWith('session', { action: 'enter', name: 'feature' });
  });
});
