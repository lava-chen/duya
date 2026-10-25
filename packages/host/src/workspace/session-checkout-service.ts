/** One durable execution-location control path for workers and local clients. */
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import * as path from 'node:path';
import type { SessionStore } from '@duya/data/session-store';
import type { SessionCheckoutAttachment, SessionCheckoutCommand, SessionCheckoutJournal, SessionCheckoutResult, SessionCheckoutState } from '@duya/agent-protocol';
import { createCheckoutProvider } from './checkout-provider.js';
import { readCheckoutOrigin } from './checkout-origin.js';
import { readOwner } from './checkout-metadata.js';
import { canonicalPath, isDirectory, samePath } from './fs-utils.js';
import { cwdInsideRoot } from './aliveness.js';
import { git, gitOrNull, gitPathAbsolute } from './git.js';
import { inspectRegistration } from './registration.js';
import { hasBackgroundCheckoutLease } from './task-leases.js';

export class SessionCheckoutError extends Error {
  readonly status = 409;
  constructor(readonly code: string, message: string) { super(message); this.name = 'SessionCheckoutError'; }
}

export interface CheckoutControlActor { readonly sessionId: string; readonly runId?: string; readonly epoch?: number; readonly authorizedChildSessionId?: string }
export interface SessionCheckoutServiceOptions {
  readonly sessions: SessionStore;
  readonly runs: { listRunsBySession(id: string, limit?: number): Array<{ status: string; runId?: string }> };
  readonly validateActor?: (actor: CheckoutControlActor) => void;
  readonly backgroundBusy?: (cwd: string) => boolean | Promise<boolean>;
}

function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 4096 && !value.includes('\0'); }
function attachment(value: unknown): value is SessionCheckoutAttachment {
  return record(value) && text(value.root) && text(value.cwd) && text(value.returnCwd) && typeof value.baseSha === 'string'
    && (value.baseSha === '' || /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value.baseSha));
}
export function parseSessionCheckoutCommand(value: unknown): SessionCheckoutCommand {
  if (!record(value)) throw new SessionCheckoutError('invalid_checkout_command', 'A checkout command object is required.');
  if (value.action === 'status' || value.action === 'recover') return { action: value.action };
  if (value.action === 'enter') {
    if (text(value.name) === text(value.path) || (value.name !== undefined && !text(value.name)) || (value.path !== undefined && !text(value.path))) {
      throw new SessionCheckoutError('invalid_checkout_command', 'Specify exactly one of name or path.');
    }
    for (const key of ['base', 'branchName']) if (value[key] !== undefined && !text(value[key])) throw new SessionCheckoutError('invalid_checkout_command', `Invalid ${key}.`);
    if (value.path !== undefined && (value.base !== undefined || value.branchName !== undefined)) throw new SessionCheckoutError('invalid_checkout_command', 'base and branchName apply only when creating a checkout.');
    return { action: 'enter', ...(text(value.name) ? { name: value.name } : { path: value.path as string }),
      ...(text(value.base) ? { base: value.base } : {}), ...(text(value.branchName) ? { branchName: value.branchName } : {}) };
  }
  if (value.action === 'exit' && (value.disposition === undefined || value.disposition === 'keep' || value.disposition === 'remove')) {
    return { action: 'exit', ...(value.disposition ? { disposition: value.disposition } : {}) };
  }
  if (value.action === 'sync' && (value.base === undefined || text(value.base)) && (value.abort === undefined || typeof value.abort === 'boolean')) {
    if (value.abort && value.base !== undefined) throw new SessionCheckoutError('invalid_checkout_command', 'An abort cannot select a new base.');
    return { action: 'sync', ...(text(value.base) ? { base: value.base } : {}), ...(typeof value.abort === 'boolean' ? { abort: value.abort } : {}) };
  }
  throw new SessionCheckoutError('invalid_checkout_command', 'Unknown or invalid checkout action.');
}

export class SessionCheckoutService {
  private readonly changing = new Set<string>();
  private readonly starting = new Map<string, number>();
  private readonly provider;
  constructor(private readonly options: SessionCheckoutServiceOptions) {
    this.provider = createCheckoutProvider({
      isSessionAlive: async (id) => this.busy(id),
      cwdInUse: async (root) => (await this.backgroundBusy(root)) || options.sessions.list().some((row) => this.busy(row.id) && cwdInsideRoot(root, row.workingDirectory)),
    });
  }

  private busy(id: string): boolean { return this.options.runs.listRunsBySession(id, 50).some((r) => r.status === 'running'); }
  reclaim(root: string) { return this.provider.reclaim(root); }
  private backgroundBusy(cwd: string): Promise<boolean> { return Promise.resolve((this.options.backgroundBusy ?? hasBackgroundCheckoutLease)(cwd)); }

  /** Held throughout asynchronous run admission, so a switch cannot race a new run. */
  reserveRun(id: string, expectedCwd?: string): () => void {
    if (!this.options.sessions.get(id)) return () => {};
    if (this.changing.has(id) || this.read(id).pending) throw new SessionCheckoutError('checkout_transition_pending', 'Recover or finish the checkout transition before starting a run.');
    const cursor = this.read(id);
    if (expectedCwd !== undefined && cursor.revision > 0 && !samePath(expectedCwd, cursor.cwd)) throw new SessionCheckoutError('checkout_context_stale', 'The run was assembled before the execution directory changed. Start a new turn.');
    this.starting.set(id, (this.starting.get(id) ?? 0) + 1);
    let released = false;
    return () => { if (!released) { released = true; const count = (this.starting.get(id) ?? 1) - 1; if (count) this.starting.set(id, count); else this.starting.delete(id); } };
  }

  read(id: string): SessionCheckoutState {
    const row = this.options.sessions.get(id);
    if (!row) throw new SessionCheckoutError('checkout_session_missing', 'The session does not exist.');
    const saved = row.extensions.executionLocation;
    if (saved === undefined) return { version: 1, revision: 0, cwd: row.workingDirectory, checkout: null, pending: null };
    if (!record(saved) || saved.version !== 1 || !Number.isSafeInteger(saved.revision) || (saved.revision as number) < 0
      || saved.cwd !== row.workingDirectory || (saved.checkout !== null && !attachment(saved.checkout))
      || (saved.pending !== null && (!record(saved.pending) || !text(saved.pending.id) || !text(saved.pending.sourceCwd)
        || (saved.pending.target !== null && !attachment(saved.pending.target))))
      || (saved.mergeBase !== undefined && !/^[0-9a-f]{40,64}$/.test(String(saved.mergeBase)))) {
      throw new SessionCheckoutError('checkout_state_unreadable', 'The saved execution location is invalid; it cannot be silently replaced.');
    }
    if (record(saved.pending)) {
      const action = parseSessionCheckoutCommand(saved.pending.command).action;
      if (action === 'status' || action === 'recover') throw new SessionCheckoutError('checkout_state_unreadable', 'Invalid operation journal.');
    }
    return saved as unknown as SessionCheckoutState;
  }

  private save(id: string, before: SessionCheckoutState, next: Omit<SessionCheckoutState, 'version' | 'revision'>): SessionCheckoutState {
    const after: SessionCheckoutState = { ...next, version: 1, revision: before.revision + 1 };
    if (!this.options.sessions.compareAndSetExecutionLocation(id, before.revision, before.cwd, after)) throw new SessionCheckoutError('checkout_state_changed', 'The session execution location changed concurrently.');
    return after;
  }

  private async assertActor(id: string, actor?: CheckoutControlActor): Promise<void> {
    if ((this.starting.get(id) ?? 0) > 0) throw new SessionCheckoutError('checkout_session_busy', 'A run is starting in this session.');
    if (actor) {
      const ownChild = actor.authorizedChildSessionId === id && this.options.sessions.get(id)?.parentSessionId === actor.sessionId;
      if ((actor.sessionId !== id && !ownChild) || !this.options.validateActor) throw new SessionCheckoutError('checkout_actor_invalid', 'A trusted active session is required.');
      this.options.validateActor(actor);
      if (ownChild && this.busy(id)) throw new SessionCheckoutError('checkout_session_busy', 'The child is already running.');
    } else if (this.busy(id)) throw new SessionCheckoutError('checkout_session_busy', 'Finish the current run before changing its checkout from a client.');
    const current = this.read(id);
    if (await this.backgroundBusy(current.cwd)) throw new SessionCheckoutError('checkout_background_busy', 'A background shell still uses this execution directory. Finish or cancel it before switching.');
    for (const child of this.options.sessions.list()) {
      if (child.parentSessionId === id && this.busy(child.id) && cwdInsideRoot(current.checkout?.root ?? current.cwd, child.workingDirectory)) {
        throw new SessionCheckoutError('checkout_child_busy', 'A child session is still running in this checkout.');
      }
    }
    if (actor) this.options.validateActor!(actor);
  }

  async control(id: string, untrusted: SessionCheckoutCommand, actor?: CheckoutControlActor): Promise<SessionCheckoutResult> {
    const command = parseSessionCheckoutCommand(untrusted);
    if (command.action === 'status') return { state: this.read(id), outcome: 'status' };
    if (this.changing.has(id)) throw new SessionCheckoutError('checkout_transition_pending', 'Another checkout operation is in progress.');
    this.changing.add(id);
    try {
      await this.assertActor(id, actor);
      let state = this.read(id);
      if (state.pending) {
        const result = await this.finish(id, state, actor);
        if (command.action === 'recover') return { ...result, outcome: 'recovered' };
        throw new SessionCheckoutError('checkout_recovered', 'The previous operation was recovered. Read the current location before issuing a different command.');
      }
      if (command.action === 'recover') return { state, outcome: 'recovered' };
      if (command.action === 'enter') {
        if (state.checkout) throw new SessionCheckoutError('checkout_already_entered', 'Exit the current session checkout before entering another.');
        if (!await gitOrNull(state.cwd, ['rev-parse', '--show-toplevel'])) throw new SessionCheckoutError('checkout_invalid_target', 'Enter requires a Git repository with a local commit.');
        if (!await gitOrNull(state.cwd, ['rev-parse', '--verify', '--end-of-options', `${command.base === 'fresh' ? 'refs/remotes/origin/HEAD' : !command.base || command.base === 'head' ? 'HEAD' : command.base}^{commit}`])) {
          throw new SessionCheckoutError('checkout_base_invalid', 'The requested base is not available locally.');
        }
        if (command.branchName && await gitOrNull(state.cwd, ['check-ref-format', '--branch', command.branchName]) === null) throw new SessionCheckoutError('checkout_base_invalid', 'Invalid branch name.');
        if (command.branchName && await gitOrNull(state.cwd, ['show-ref', '--verify', `refs/heads/${command.branchName}`]) !== null) throw new SessionCheckoutError('checkout_base_invalid', 'The requested new branch already exists.');
        const operation: SessionCheckoutJournal = { id: randomUUID(), command, sourceCwd: state.cwd, target: null };
        state = this.save(id, state, { ...state, pending: operation });
        return await this.enter(id, state, actor);
      }
      if (!state.checkout) throw new SessionCheckoutError('checkout_not_entered', 'This session has no entered checkout.');
      state = this.save(id, state, { ...state, pending: { id: randomUUID(), command, sourceCwd: state.cwd, target: state.checkout } });
      return await this.finish(id, state, actor);
    } catch (error) {
      // Validation refusals happen before a Git mutation. Clear only that
      // intent so the user can fix local changes using the existing checkout.
      if (error instanceof SessionCheckoutError && ['checkout_dirty', 'checkout_git_busy', 'checkout_base_invalid', 'checkout_base_unknown',
        'checkout_filter_unsupported', 'checkout_invalid_target', 'checkout_not_owner', 'checkout_return_missing', 'checkout_no_owned_merge', 'checkout_remote_mismatch'].includes(error.code)) {
        const current = this.read(id);
        if (current.pending) this.save(id, current, { ...current, pending: null });
      }
      throw error;
    } finally { this.changing.delete(id); }
  }

  async createChildCheckout(id: string, sourceCwd: string, parent: CheckoutControlActor, isolated: boolean, base?: string, branchName?: string): Promise<SessionCheckoutResult> {
    if (this.options.sessions.get(id)?.parentSessionId !== parent.sessionId) throw new SessionCheckoutError('checkout_actor_invalid', 'The child does not belong to this caller.');
    this.options.validateActor?.(parent);
    if (this.changing.has(id) || this.starting.has(id) || this.busy(id)) throw new SessionCheckoutError('checkout_session_busy', 'The child is already starting or running.');
    let state = this.read(id);
    state = this.save(id, state, { ...state, cwd: canonicalPath(sourceCwd) });
    if (!isolated) return { state, outcome: 'status' };
    return this.control(id, { action: 'enter', name: `session-${id}`, branchName: branchName ?? `duya/session/${id.replace(/[^A-Za-z0-9._-]/g, '-')}`,
      ...(base ? { base } : {}) }, { ...parent, authorizedChildSessionId: id });
  }

  async verifyCursor(id: string): Promise<SessionCheckoutState> {
    const state = this.read(id);
    if (state.pending) throw new SessionCheckoutError('checkout_transition_pending', 'The child checkout requires recovery.');
    if (!isDirectory(state.cwd)) throw new SessionCheckoutError('checkout_missing', 'The child execution directory is missing.');
    if (state.checkout && !(await this.provider.assertWritable(state.cwd, id)).ok) throw new SessionCheckoutError('checkout_not_owner', 'The child checkout is no longer owned by this session.');
    return state;
  }

  private async enter(id: string, state: SessionCheckoutState, actor?: CheckoutControlActor): Promise<SessionCheckoutResult> {
    const journal = state.pending!;
    const command = journal.command;
    if (command.action !== 'enter') throw new SessionCheckoutError('checkout_state_unreadable', 'Invalid enter journal.');
    let target = journal.target;
    let excluded = false;
    if (!target) {
      if (command.path) {
        const root = canonicalPath(path.resolve(journal.sourceCwd, command.path));
        const registration = await inspectRegistration(root);
        const sourceCommon = await gitPathAbsolute(journal.sourceCwd, ['--git-common-dir']);
        if (!registration.registered || !sourceCommon || !registration.commonDir || !samePath(sourceCommon, registration.commonDir) || registration.locked) {
          throw new SessionCheckoutError('checkout_invalid_target', 'The target must be an unlocked registered worktree of the same repository.');
        }
        target = { root, cwd: root, baseSha: (await readCheckoutOrigin(root))?.baseSha ?? '', returnCwd: journal.sourceCwd };
      } else {
        excluded = Boolean((await git(journal.sourceCwd, ['status', '--porcelain'])).trim());
        const previous = await this.provider.list(journal.sourceCwd);
        const matching = [];
        for (const candidate of previous) if ((await readCheckoutOrigin(candidate.root))?.operationId === journal.id) matching.push(candidate);
        if (matching.length > 1) throw new SessionCheckoutError('checkout_recovery_ambiguous', 'Multiple checkouts match the saved operation.');
        const created = matching[0] ?? await this.provider.create({ sourceCwd: journal.sourceCwd, ownerSessionId: id,
          label: command.name!, allowDirtySource: true, operationId: journal.id,
          ...(command.base ? { base: command.base === 'fresh' ? 'refs/remotes/origin/HEAD' : command.base === 'head' ? 'HEAD' : command.base } : {}),
          ...(command.branchName ? { branchName: command.branchName } : {}) });
        const baseRef = command.base === 'fresh' ? 'refs/remotes/origin/HEAD'
          : command.base && command.base !== 'head' ? command.base
          : (await gitOrNull(journal.sourceCwd, ['symbolic-ref', '--quiet', 'HEAD']))?.trim();
        target = { root: created.root, cwd: created.cwd, baseSha: created.baseSha, returnCwd: journal.sourceCwd, ...(baseRef ? { baseRef } : {}) };
      }
      state = this.save(id, state, { ...state, pending: { ...journal, target } });
    }
    if (!isDirectory(target.cwd) || !cwdInsideRoot(target.root, target.cwd)) throw new SessionCheckoutError('checkout_missing', 'The saved checkout working directory is missing or redirected.');
    await this.provider.bind(target.root, id, 'fresh');
    await this.assertActor(id, actor);
    state = this.save(id, state, { cwd: target.cwd, checkout: target, pending: null });
    return { state, outcome: 'entered', sourceChangesExcluded: excluded };
  }

  private async finish(id: string, state: SessionCheckoutState, actor?: CheckoutControlActor): Promise<SessionCheckoutResult> {
    const journal = state.pending!;
    if (journal.command.action === 'enter') return this.enter(id, state, actor);
    const target = journal.target;
    if (!target) throw new SessionCheckoutError('checkout_state_unreadable', 'The operation has no checkout target.');
    if (await this.backgroundBusy(target.root)) throw new SessionCheckoutError('checkout_background_busy', 'A process still uses the checkout. It is retained.');
    const command = journal.command;
    if (command.action === 'sync') return this.sync(id, state, target, command, actor);
    if (!(await inspectRegistration(target.root)).registered) throw new SessionCheckoutError('checkout_missing', 'The checkout registration is missing.');
    if (!isDirectory(target.returnCwd)) throw new SessionCheckoutError('checkout_return_missing', 'The return directory is missing. The checkout is retained.');
    const owner = await readOwner(target.root);
    if (owner === 'unreadable' || (owner && owner.sessionId !== id)) throw new SessionCheckoutError('checkout_not_owner', 'The checkout owner changed.');
    const checkpoint = owner ? await this.provider.checkpoint(target.root, id) : undefined;
    await this.assertActor(id, actor);
    if (state.cwd !== target.returnCwd) state = this.save(id, state, { ...state, cwd: target.returnCwd, checkout: null });
    if (owner) await this.provider.release(target.root, id);
    state = this.save(id, state, { cwd: target.returnCwd, checkout: null, pending: null });
    const removal = command.disposition === 'remove' ? await this.provider.reclaim(target.root) : undefined;
    return { state, outcome: 'left', ...(checkpoint ? { checkpoint } : {}), ...(removal ? { removal } : {}) };
  }

  private async sync(id: string, state: SessionCheckoutState, target: SessionCheckoutAttachment, command: Extract<SessionCheckoutCommand, { action: 'sync' }>, actor?: CheckoutControlActor): Promise<SessionCheckoutResult> {
    const writable = await this.provider.assertWritable(target.cwd, id);
    if (!writable.ok) throw new SessionCheckoutError('checkout_not_owner', 'Only the checkout owner may synchronize it.');
    const mergeHead = await gitPathAbsolute(target.root, ['--git-path', 'MERGE_HEAD']);
    const merging = mergeHead && existsSync(mergeHead);
    if (merging && state.mergeBase && (await gitOrNull(target.root, ['rev-parse', '--verify', 'MERGE_HEAD']))?.trim() !== state.mergeBase) {
      throw new SessionCheckoutError('checkout_git_busy', 'A different merge is in progress; it cannot be aborted by checkout controls.');
    }
    if (command.abort) {
      if (!state.mergeBase || !mergeHead || !existsSync(mergeHead)) throw new SessionCheckoutError('checkout_no_owned_merge', 'There is no checkout synchronization merge to abort.');
      await git(target.root, ['merge', '--abort']);
      state = this.save(id, state, { cwd: state.cwd, checkout: state.checkout, pending: null });
      return { state, outcome: 'aborted' };
    }
    if (state.mergeBase && mergeHead && existsSync(mergeHead)) {
      const conflicts = (await git(target.root, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
      state = this.save(id, state, { ...state, pending: null });
      return { state, outcome: 'conflicts', conflicts };
    }
    if (state.mergeBase && await gitOrNull(target.root, ['merge-base', '--is-ancestor', state.mergeBase, 'HEAD']) !== null) {
      state = this.save(id, state, { cwd: state.cwd, checkout: state.checkout, pending: null });
      return { state, outcome: 'merged' };
    }
    for (const marker of ['MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD', 'rebase-merge', 'rebase-apply', 'BISECT_LOG']) {
      const markerPath = await gitPathAbsolute(target.root, ['--git-path', marker]);
      if (markerPath && existsSync(markerPath)) throw new SessionCheckoutError('checkout_git_busy', 'Another Git operation is in progress.');
    }
    if ((await git(target.root, ['status', '--porcelain'])).trim()) throw new SessionCheckoutError('checkout_dirty', 'Commit or save local changes before synchronizing.');
    const sourceOrigin = await gitOrNull(target.returnCwd, ['remote', 'get-url', 'origin']);
    const checkoutOrigin = await gitOrNull(target.root, ['remote', 'get-url', 'origin']);
    if (sourceOrigin?.trim() !== checkoutOrigin?.trim()) throw new SessionCheckoutError('checkout_remote_mismatch', 'The source and checkout origin remotes differ.');
    for (const attribute of (await git(target.root, ['ls-files', '-z', '--', '.gitattributes', ':(glob)**/.gitattributes'])).split('\0').filter(Boolean)) {
      const content = await gitOrNull(target.root, ['show', `HEAD:${attribute}`]);
      if (content && /filter\s*=\s*(?:lfs|git-crypt)/.test(content)) throw new SessionCheckoutError('checkout_filter_unsupported', 'LFS or git-crypt repositories require an explicit external synchronization workflow.');
    }
    const base = command.base ?? target.baseRef ?? target.baseSha;
    if (!base) throw new SessionCheckoutError('checkout_base_unknown', 'Select an explicit base for this legacy checkout.');
    const sha = (await gitOrNull(target.root, ['rev-parse', '--verify', '--end-of-options', `${base}^{commit}`]))?.trim();
    if (!sha) throw new SessionCheckoutError('checkout_base_invalid', 'The selected base does not resolve to a local commit. Fetch it explicitly first.');
    const before = (await git(target.root, ['rev-parse', 'HEAD'])).trim();
    state = this.save(id, state, { ...state, mergeBase: sha });
    await this.assertActor(id, actor);
    try { await git(target.root, ['merge', '--no-edit', sha]); }
    catch (error) {
      if (!mergeHead || !existsSync(mergeHead)) throw error;
      const conflicts = (await git(target.root, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean);
      state = this.save(id, state, { ...state, pending: null });
      return { state, outcome: 'conflicts', conflicts };
    }
    state = this.save(id, state, { cwd: state.cwd, checkout: state.checkout, pending: null });
    return { state, outcome: before === (await git(target.root, ['rev-parse', 'HEAD'])).trim() ? 'up_to_date' : 'merged' };
  }
}
