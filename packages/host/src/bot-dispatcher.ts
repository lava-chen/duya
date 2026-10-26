import { randomUUID } from 'node:crypto';
import type { AcceptInputCommand, AcceptReceipt } from '@duya/agent-protocol/bot-inbox-api';
import type { StartAgentRunInput, StartAgentRunResult } from '@duya/agent-protocol';
import type { BotDispatchStore, BotInboxClaimGrant, BotInboxEntry, BotSchedulerStore } from '@duya/data';
import type { RunRepository } from './repository-port.js';
import type { RunDispatchAdmission } from './run-orchestrator.js';

export interface BotDispatcherOptions {
  readonly ownerId: string;
  readonly store: BotDispatchStore;
  readonly scheduler?: BotSchedulerStore;
  readonly runs: Pick<RunRepository, 'getRun'>;
  readonly execution: {
    startBotRun(input: StartAgentRunInput, admission: RunDispatchAdmission): Promise<StartAgentRunResult>;
    isRunLive(runId: string): boolean | Promise<boolean>;
    isSessionBusy(sessionId: string): boolean | Promise<boolean>;
    cancelBotRun?(runId: string): Promise<boolean>;
  };
  readonly resolveInput: (entry: BotInboxEntry) => Promise<StartAgentRunInput>;
  readonly validateBot: (botId: string) => Promise<void>;
  readonly pollIntervalMs?: number;
  readonly leaseMs?: number;
  readonly logger: { error(message: string, error?: Error): void };
}

/** S3b is opt-in: only this inbox is consumed; legacy wakes are untouched. */
export class BotDispatcher {
  readonly #leaseOwner = randomUUID();
  #timer: ReturnType<typeof setInterval> | undefined;
  #ticking: Promise<void> | undefined;
  #closed = false;
  #accepting = 0;

  constructor(readonly options: BotDispatcherOptions) {
    if (!options.ownerId.trim()) throw new Error('Bot dispatcher requires an owner id');
    for (const value of [options.pollIntervalMs ?? 250, options.leaseMs ?? 30_000]) {
      if (!Number.isFinite(value) || value <= 0) throw new Error('Bot dispatcher intervals must be positive');
    }
  }

  /** Caller supplies already-verified source/binding identity; no public route yet. */
  async accept(command: AcceptInputCommand): Promise<AcceptReceipt> {
    if (this.#closed) throw new Error('Bot dispatcher is closed');
    this.#accepting += 1;
    try {
      if (command.ownerId !== this.options.ownerId) throw new Error('Bot input owner mismatch');
      for (const part of [command.ownerId, command.botId, command.source, command.sourceEventId, command.bindingId ?? '']) {
        if (part.includes('\0')) throw new Error('Bot input identity may not contain NUL');
      }
      if (!command.source.trim() || !command.sourceEventId.trim()) throw new Error('Bot input source identity is required');
      readBotPrompt(command.payloadJson ?? null);
      await this.options.validateBot(command.botId);
      if (this.#closed) throw new Error('Bot dispatcher is closed');
      const scheduler = this.options.scheduler;
      if (!scheduler) return this.options.store.inbox.accept(command);
      const owner = scheduler.get(command.botId, command.ownerId);
      if (owner.mode !== 'host') throw new Error('bot_scheduler_fenced');
      return scheduler.withEpoch(owner, () => this.options.store.inbox.accept(command));
    } finally { this.#accepting -= 1; }
  }

  get(inboxId: string): BotInboxEntry | null {
    const entry = this.options.store.inbox.getById(inboxId);
    return entry?.ownerId === this.options.ownerId ? entry : null;
  }

  hasWork(): boolean {
    return this.#accepting > 0 || this.#ticking !== undefined || this.options.store.hasOutstanding(this.options.ownerId);
  }

  start(): void {
    if (this.#closed || this.#timer) return;
    const poll = (): void => { void this.tick().catch((error: unknown) => {
      this.options.logger.error('Bot inbox reconciliation failed', error instanceof Error ? error : new Error(String(error)));
    }); };
    this.#timer = setInterval(poll, this.options.pollIntervalMs ?? 250);
    this.#timer.unref();
    poll();
  }

  tick(): Promise<void> {
    if (this.#closed) return Promise.resolve();
    if (this.#ticking) return this.#ticking;
    this.#ticking = this.#drain().finally(() => { this.#ticking = undefined; });
    return this.#ticking;
  }

  async close(): Promise<void> {
    this.#closed = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    await this.#ticking;
  }

  async #drain(): Promise<void> {
    const { store, ownerId, execution } = this.options;
    await this.#reconcilePreemptions();
    // Expiry changes queue state only. Dispatch decisions below always consult receipts.
    store.requeueExpired(ownerId, Date.now());
    const outstanding = store.outstanding(ownerId);
    for (const entry of outstanding) {
      if (entry.status !== 'dispatched') continue;
      const receipt = entry.dispatchKey && store.inbox.lookupReceipt(entry.dispatchKey);
      const run = receipt && this.options.runs.getRun(receipt.runId);
      if (run && run.terminal !== null) store.inbox.settle(entry.id);
      else if (!run || !await execution.isRunLive(run.id)) {
        store.inbox.deadLetter(entry.id, `recovery_required: dispatched run ${receipt ? receipt.runId : 'missing'} has no live executor`);
      }
    }
    const botIds = new Set(store.outstanding(ownerId).map((entry) => entry.botId));
    for (const botId of botIds) {
      if (this.#closed) break;
      if (this.options.scheduler && this.options.scheduler.get(botId, ownerId).mode !== 'host') continue;
      const sessionId = `bot:${botId}`;
      // One turn per Bot. Lane priority is applied by the claim transaction.
      if (await execution.isSessionBusy(sessionId)) continue;
      const grant = store.claim(ownerId, botId, this.#leaseOwner, Date.now() + (this.options.leaseMs ?? 30_000));
      if (grant) await this.#dispatch(grant);
    }
  }

  async #reconcilePreemptions(): Promise<void> {
    const { scheduler, store, runs, execution, ownerId } = this.options;
    if (!scheduler) return;
    for (const intent of scheduler.pendingPreemptions(ownerId)) {
      const run = runs.getRun(intent.sourceRunId);
      const source = store.inbox.getById(intent.sourceInboxId);
      if (!run || !source) {
        scheduler.updatePreemption(intent.id, 'recovery_required');
        continue;
      }
      if (run.terminal !== null) {
        if (run.terminal !== 'cancelled') {
          scheduler.updatePreemption(intent.id, 'superseded');
          continue;
        }
        if (intent.redriveCount >= 3) {
          scheduler.updatePreemption(intent.id, 'recovery_required');
          continue;
        }
        const count = intent.redriveCount + 1;
        let payloadJson = source.payloadJson;
        try {
          const payload: unknown = payloadJson === null ? null : JSON.parse(payloadJson);
          if (payload && typeof payload === 'object' && !Array.isArray(payload) && 'wakeItem' in payload) {
            const wakeItem = payload.wakeItem;
            if (wakeItem && typeof wakeItem === 'object' && !Array.isArray(wakeItem)) {
              payloadJson = JSON.stringify({ ...payload, wakeItem: {
                ...wakeItem,
                id: `${source.sourceEventId}:redrive:${count}`,
                isRedriven: true,
                redriveCount: count,
              } });
            }
          }
        } catch {
          store.inbox.deadLetter(source.id, 'recovery_required: preempted input payload is unreadable');
          scheduler.updatePreemption(intent.id, 'recovery_required');
          continue;
        }
        const accepted = store.inbox.accept({
          ownerId: source.ownerId,
          botId: source.botId,
          source: source.source,
          sourceEventId: `${source.sourceEventId}:redrive:${count}`,
          ...(source.bindingId === null ? {} : { bindingId: source.bindingId }),
          lane: source.lane,
          payloadJson,
          ...(source.title === null ? {} : { title: source.title }),
        });
        if (count >= 3) store.inbox.deadLetter(accepted.entry.id, 'recovery_required: redrive limit reached');
        scheduler.updatePreemption(intent.id, 'redriven', accepted.entry.id);
        continue;
      }
      if (!await execution.isRunLive(run.id) || !execution.cancelBotRun) {
        scheduler.updatePreemption(intent.id, 'recovery_required');
        continue;
      }
      const applied = await execution.cancelBotRun(run.id);
      if (applied) scheduler.updatePreemption(intent.id, 'cancel_requested');
    }
  }

  async #dispatch(grant: BotInboxClaimGrant): Promise<void> {
    const { store, execution } = this.options;
    const key = `bot-inbox:${grant.entry.id}`;
    const scheduler = this.options.scheduler;
    const owner = scheduler?.get(grant.entry.botId, grant.entry.ownerId);
    const reconcile = async (): Promise<boolean> => {
      const receipt = store.inbox.lookupReceipt(key);
      if (!receipt) return false;
      const run = this.options.runs.getRun(receipt.runId);
      if (run && (run.terminal !== null || await execution.isRunLive(run.id))) {
        if (store.record(grant, key, run.id) && run.terminal !== null) store.inbox.settle(grant.entry.id);
      } else {
        store.deadLetter(grant, `recovery_required: reserved run ${receipt.runId} cannot be safely restarted`);
      }
      return true;
    };
    if (await reconcile()) return;
    try {
      await this.options.validateBot(grant.entry.botId);
      const input = await this.options.resolveInput(grant.entry);
      if (this.#closed || !store.isCurrent(grant)) return;
      const acceptance = await execution.startBotRun(input, {
        ...(owner ? { scheduler: owner, ticket: { inboxId: grant.entry.id, leaseOwner: grant.leaseOwner, leaseEpoch: grant.leaseEpoch, scheduler: owner } } : {}),
        lookup: () => store.inbox.lookupReceipt(key),
        reserve: (candidate) => scheduler && owner
          ? scheduler.withEpoch(owner, () => store.reserve(grant, key, candidate)) : store.reserve(grant, key, candidate),
        isCurrent: () => !this.#closed && store.isCurrent(grant) && (!scheduler || !owner || scheduler.current(owner)),
      });
      // Read durable facts even when the start reply was refused or lost.
      if (!await reconcile()) {
        if (await execution.isSessionBusy(input.sessionId)
            || (!acceptance.accepted && acceptance.stage === 'refused_dispatch_failed')) {
          store.release(grant, key);
        } else if (!acceptance.accepted) {
          store.deadLetter(grant, `start_refused: ${acceptance.stage}`);
        } else {
          store.deadLetter(grant, 'recovery_required: accepted Run has no dispatch reservation');
        }
      }
    } catch (error) {
      if (!await reconcile()) {
        store.deadLetter(grant, 'invalid_input_or_start_failed: input could not be dispatched');
      }
      this.options.logger.error('Bot input dispatch failed', error instanceof Error ? error : new Error(String(error)));
    }
  }
}

/** The initial Host payload is explicit and reconstructable; labels are not prompts. */
export function readBotPrompt(payloadJson: string | null): string {
  const payload: unknown = payloadJson === null ? null : JSON.parse(payloadJson);
  if (payload === null || typeof payload !== 'object' || Array.isArray(payload)
      || !('prompt' in payload) || typeof payload.prompt !== 'string' || !payload.prompt.trim()) {
    throw new Error('Bot input requires a JSON payload with a non-empty prompt');
  }
  return payload.prompt;
}
