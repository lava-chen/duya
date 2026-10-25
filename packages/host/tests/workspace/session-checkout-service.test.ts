import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { CoreDatabase } from '@duya/data/core-database';
import { SessionStore } from '@duya/data/session-store';
import { SessionCheckoutService } from '../../src/workspace/session-checkout-service.js';
import { readOwner } from '../../src/workspace/checkout-metadata.js';
import { createCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import { git, makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';

const databases: CoreDatabase[] = [];
let restore: () => void;
beforeAll(() => { restore = useIsolatedDataRoot(); });
afterAll(() => { for (const db of databases) db.close(); restore(); });

function fixture() {
  const repo = makeRepo();
  const db = new CoreDatabase({ filename: path.join(tempDir('duya-cursor-db-'), 'core.db'), migrations: SessionStore.migrations });
  databases.push(db);
  const sessions = new SessionStore(db.db);
  sessions.create({ id: 'session', workingDirectory: repo, extensions: { unrelated: { keep: true } } });
  const live = new Set<string>();
  let blocked = false;
  const options = { sessions, runs: { listRunsBySession: (id: string) => live.has(id) ? [{ status: 'running' }] : [] },
    backgroundBusy: async () => blocked, validateActor: () => {} };
  const service = new SessionCheckoutService(options);
  return { repo, sessions, service, live, options, block: (value: boolean) => { blocked = value; } };
}

describe('durable session checkout controls', () => {
  it('recovers a created checkout before its target was journaled without creating another', async () => {
    const f = fixture();
    const state = f.service.read('session');
    const pending = { id: 'enter-crash', command: { action: 'enter' as const, name: 'recovered' }, sourceCwd: f.repo, target: null };
    f.sessions.compareAndSetExecutionLocation('session', 0, f.repo, { ...state, revision: 1, pending });
    const provider = createCheckoutProvider();
    const created = await provider.create({ sourceCwd: f.repo, ownerSessionId: 'session', label: 'recovered', operationId: pending.id });
    const result = await new SessionCheckoutService(f.options).control('session', { action: 'recover' });
    expect(result.state.cwd).toBe(created.cwd);
    expect((await provider.list(f.repo)).length).toBe(1);
  });

  it('rejects stale location CAS and preserves concurrent extension writes', () => {
    const f = fixture();
    const state = f.service.read('session');
    f.sessions.setExtension('session', 'concurrent', { keep: true });
    expect(f.sessions.compareAndSetExecutionLocation('session', 0, f.repo, { ...state, revision: 1 })).toBe(true);
    expect(f.sessions.compareAndSetExecutionLocation('session', 0, f.repo, { ...state, revision: 1, cwd: '/stale' })).toBe(false);
    expect(f.sessions.get('session')!.extensions.concurrent).toEqual({ keep: true });
  });

  it('gives a child a branch and stable cursor even after the parent exits', async () => {
    const f = fixture();
    const parent = await f.service.control('session', { action: 'enter', name: 'parent' });
    f.sessions.create({ id: 'spawn:child:1', parentSessionId: 'session', workingDirectory: f.repo });
    const child = await f.service.createChildCheckout('spawn:child:1', parent.state.cwd, { sessionId: 'session' }, true);
    expect(child.state.cwd).not.toBe(parent.state.cwd);
    expect(git(child.state.cwd, 'branch', '--show-current')).toBe('duya/session/spawn-child-1');
    await f.service.control('session', { action: 'exit' });
    expect((await f.service.verifyCursor('spawn:child:1')).cwd).toBe(child.state.cwd);
    const exit = await f.service.control('spawn:child:1', { action: 'exit', disposition: 'remove' });
    expect(exit.checkpoint).toContain('spawn%3Achild%3A1');
    expect(exit.removal).toEqual({ removed: true });
  });
  it('isolates committed content from a dirty source, persists the cursor and returns without losing changes', async () => {
    const f = fixture();
    writeFileSync(path.join(f.repo, 'README.md'), 'source-only');
    const entered = await f.service.control('session', { action: 'enter', name: 'isolated' });
    const root = entered.state.checkout!.root;
    expect(entered.sourceChangesExcluded).toBe(true);
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# fixture\n');
    expect(f.sessions.get('session')!.workingDirectory).toBe(root);
    expect(f.sessions.get('session')!.extensions.unrelated).toEqual({ keep: true });
    writeFileSync(path.join(root, 'result.txt'), 'keep');
    const resumed = new SessionCheckoutService(f.options);
    expect(resumed.read('session').cwd).toBe(root);
    const left = await resumed.control('session', { action: 'exit', disposition: 'remove' });
    expect(left.state.cwd).toBe(f.repo);
    expect(left.removal).toMatchObject({ removed: false });
    expect(readFileSync(path.join(root, 'result.txt'), 'utf8')).toBe('keep');
    expect(await readOwner(root)).toBeNull();
    expect(readFileSync(path.join(f.repo, 'README.md'), 'utf8')).toBe('source-only');
  });

  it('blocks a client switch during a run, run admission during a switch, and background processes', async () => {
    const f = fixture();
    f.live.add('session');
    await expect(f.service.control('session', { action: 'enter', name: 'blocked' })).rejects.toMatchObject({ code: 'checkout_session_busy' });
    f.live.clear();
    const release = f.service.reserveRun('session');
    await expect(f.service.control('session', { action: 'enter', name: 'blocked' })).rejects.toMatchObject({ code: 'checkout_session_busy' });
    release();
    f.block(true);
    await expect(f.service.control('session', { action: 'enter', name: 'blocked' })).rejects.toMatchObject({ code: 'checkout_background_busy' });
    f.block(false);
    const pending = f.service.control('session', { action: 'enter', name: 'allowed' });
    expect(() => f.service.reserveRun('session')).toThrow();
    await pending;
  });

  it('removes an unchanged checkout safely and permits explicit entry into a retained checkout', async () => {
    const f = fixture();
    const entered = await f.service.control('session', { action: 'enter', name: 'clean' });
    const root = entered.state.cwd;
    expect(() => f.service.reserveRun('session', f.repo)).toThrow(expect.objectContaining({ code: 'checkout_context_stale' }));
    f.service.reserveRun('session', root)();
    await f.service.control('session', { action: 'exit' });
    const again = await f.service.control('session', { action: 'enter', path: root });
    expect(again.state.cwd).toBe(root);
    const left = await f.service.control('session', { action: 'exit', disposition: 'remove' });
    expect(left.removal).toEqual({ removed: true });
    expect(existsSync(root)).toBe(false);
    expect(existsSync(path.join(f.repo, 'README.md'))).toBe(true);
  });

  it('refuses another repository or invalid base and leaves the session usable', async () => {
    const f = fixture();
    const other = makeRepo();
    await expect(f.service.control('session', { action: 'enter', path: other })).rejects.toMatchObject({ code: 'checkout_invalid_target' });
    expect(f.service.read('session').pending).toBeNull();
    await expect(f.service.control('session', { action: 'enter', name: 'bad', base: 'missing-ref' })).rejects.toMatchObject({ code: 'checkout_base_invalid' });
    expect(f.service.read('session').pending).toBeNull();
    expect(() => f.service.reserveRun('session')()).not.toThrow();
  });

  it('recovers an interrupted exit after its cursor was durably returned', async () => {
    const f = fixture();
    const entered = await f.service.control('session', { action: 'enter', name: 'recover' });
    const pending = { id: 'recovery-operation', command: { action: 'exit' as const, disposition: 'keep' as const },
      sourceCwd: entered.state.cwd, target: entered.state.checkout };
    expect(f.sessions.compareAndSetExecutionLocation('session', entered.state.revision, entered.state.cwd,
      { ...entered.state, revision: entered.state.revision + 1, cwd: f.repo, checkout: null, pending })).toBe(true);
    const result = await new SessionCheckoutService(f.options).control('session', { action: 'recover' });
    expect(result.state.pending).toBeNull();
    expect(result.state.cwd).toBe(f.repo);
    expect(await readOwner(entered.state.checkout!.root)).toBeNull();
  });

  it('merges the selected base, retains conflicts and aborts only its own merge', async () => {
    const f = fixture();
    const entered = await f.service.control('session', { action: 'enter', name: 'sync', branchName: 'feature' });
    const root = entered.state.cwd;
    writeFileSync(path.join(root, 'README.md'), 'feature\n');
    git(root, 'add', '.'); git(root, 'commit', '-qm', 'feature');
    writeFileSync(path.join(f.repo, 'README.md'), 'main\n');
    git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'main');
    const conflict = await f.service.control('session', { action: 'sync', base: 'main' });
    expect(conflict.outcome).toBe('conflicts');
    expect(conflict.conflicts).toContain('README.md');
    const aborted = await f.service.control('session', { action: 'sync', abort: true });
    expect(aborted.outcome).toBe('aborted');
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('feature\n');
    await expect(f.service.control('session', { action: 'sync', abort: true })).rejects.toMatchObject({ code: 'checkout_no_owned_merge' });
  });

  it('refuses to abort an unrelated merge started after an external abort', async () => {
    const f = fixture();
    const entered = await f.service.control('session', { action: 'enter', name: 'foreign-merge', branchName: 'feature' });
    const root = entered.state.cwd;
    writeFileSync(path.join(root, 'README.md'), 'feature\n'); git(root, 'add', '.'); git(root, 'commit', '-qm', 'feature');
    writeFileSync(path.join(f.repo, 'README.md'), 'base\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'base');
    expect((await f.service.control('session', { action: 'sync', base: 'main' })).outcome).toBe('conflicts');
    git(root, 'merge', '--abort');
    writeFileSync(path.join(f.repo, 'README.md'), 'other\n'); git(f.repo, 'add', '.'); git(f.repo, 'commit', '-qm', 'other');
    expect(() => git(root, 'merge', '--no-edit', 'main')).toThrow();
    const mergeHead = git(root, 'rev-parse', 'MERGE_HEAD');
    await expect(f.service.control('session', { action: 'sync', abort: true })).rejects.toMatchObject({ code: 'checkout_git_busy' });
    expect(git(root, 'rev-parse', 'MERGE_HEAD')).toBe(mergeHead);
  });
});
