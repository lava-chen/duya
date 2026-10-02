/**
 * listener-hub.ts — polling event-listener hub for bot routines (Plan 476
 * P2.3d; grok SandTriggerHub collect→match→fire shape, poll-driven).
 *
 * Every tick the hub collects enabled bot-bound routines that carry event
 * listeners, groups listeners by provider, polls the backing SaaS API with
 * the connection's OAuth token (App Connections), persists each listener's
 * cursor in cronjob.toml, and fires every routine whose listener matched a
 * new event. A fire enqueues an `automation.fire` wake (trigger 'event')
 * into the bot's resident session — the same path scheduled fires use, so
 * the model sees one uniform wake shape.
 *
 * Injection: pollers/fetch/token resolution are constructor deps, so the
 * hub is fully unit-testable and the network only ever runs inside ticks.
 * Poll failures keep the previous cursor (no event loss) and are logged —
 * the job's own schedule and state stay untouched.
 */

import { randomUUID } from 'node:crypto';
import { getLogger, LogComponent } from '../logging/logger.js';
import { getBotSessionId } from '../wake/bot-session-id.js';
import { enqueueAutomationWake } from '../wake/wake-dispatcher.js';
import type { CronFileStore } from './cron-file.js';
import type { AutomationCron, RoutineEvent, RoutineEventTrigger } from './types.js';
import {
  buildEventContextBlock,
  describeEvent,
  listenerMatchesEvent,
} from './trigger-match.js';
import {
  pollGithubListener,
  pollSlackListener,
} from './listener-polls.js';

export type ListenerProvider = 'github' | 'slack';

/** Per-tick poll budget: coalesce up to this many events into one fire. */
const MAX_EVENTS_PER_FIRE = 5;
/** Wake payload budget for the joined context blocks (dispatcher clamps too). */
const MAX_EVENT_CONTEXT_CHARS = 6000;
/** Fallback tick cadence; the AppConnection-backed APIs tolerate 60s polls. */
const DEFAULT_TICK_INTERVAL_MS = 60_000;

export interface RoutineListenerHubDeps {
  store: CronFileStore;
  /**
   * Resolve an access token for a provider from the user's App
   * Connections. Null = no connected connection; the provider's listeners
   * stay silent for this tick (the bot prompt + tool description teach the
   * model to tell the user to connect the platform).
   */
  resolveAccessToken(provider: ListenerProvider): Promise<string | null>;
  fetchImpl?: typeof fetch;
  intervalMs?: number;
  /** Test seam — poll directly instead of through the real pollers. */
  pollOverride?: (
    trigger: RoutineEventTrigger,
    args: { cursor: string | null; now: number; accessToken: string },
  ) => Promise<{ events: RoutineEvent[]; cursor: string | null }>;
}

export class RoutineListenerHub {
  private readonly store: RoutineListenerHubDeps['store'];
  private readonly resolveAccessToken: RoutineListenerHubDeps['resolveAccessToken'];
  private readonly fetchImpl: typeof fetch;
  private readonly intervalMs: number;
  private readonly pollOverride?: RoutineListenerHubDeps['pollOverride'];
  private timer: NodeJS.Timeout | null = null;
  private ticking = false;
  private slackChannelIds = new Map<string, string>();

  constructor(deps: RoutineListenerHubDeps) {
    this.store = deps.store;
    this.resolveAccessToken = deps.resolveAccessToken;
    this.fetchImpl = deps.fetchImpl ?? fetch;
    this.intervalMs = deps.intervalMs ?? DEFAULT_TICK_INTERVAL_MS;
    this.pollOverride = deps.pollOverride;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => {});
    }, this.intervalMs);
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** One poll pass over every listener of every enabled bot-bound routine. */
  async tick(now = Date.now()): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    const logger = getLogger();
    try {
      this.store.load(); // pick up external edits + keep cursors fresh
      const jobs = this.store
        .listCrons()
        .filter((job) => job.enabled && job.agent && (job.eventTriggers?.length ?? 0) > 0);

      const tokenCache = new Map<ListenerProvider, string | null>();
      const tokenFor = async (provider: ListenerProvider): Promise<string | null> => {
        if (!tokenCache.has(provider)) {
          tokenCache.set(provider, await this.resolveAccessTokenSafe(provider));
        }
        return tokenCache.get(provider) ?? null;
      };

      for (const job of jobs) {
        await this.pollJob(job, tokenFor, now, logger);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async resolveAccessTokenSafe(provider: ListenerProvider): Promise<string | null> {
    try {
      return await this.resolveAccessToken(provider);
    } catch {
      return null;
    }
  }

  private async pollJob(
    job: AutomationCron,
    tokenFor: (provider: ListenerProvider) => Promise<string | null>,
    now: number,
    logger: ReturnType<typeof getLogger>,
  ): Promise<void> {
    const triggers = job.eventTriggers ?? [];
    for (let index = 0; index < triggers.length; index += 1) {
      const trigger = triggers[index];
      if (!trigger) continue;
      try {
        const accessToken = await tokenFor(trigger.type);
        if (!accessToken) continue; // platform not connected — stay silent
        const cursor = this.store.getListenerCursor(job.id, index);
        const outcome = this.pollOverride
          ? await this.pollOverride(trigger, { cursor, now, accessToken })
          : await this.pollDispatch(trigger, { cursor, now, accessToken });
        this.store.setListenerCursor(job.id, index, outcome.cursor);
        const matching = outcome.events.filter((event) => listenerMatchesEvent(trigger, event));
        if (matching.length > 0) {
          this.fire(job, matching, logger);
        }
      } catch (error) {
        // Keep the previous cursor: a failed poll must not skip events.
        logger.warn('Routine listener poll failed', {
          cronId: job.id,
          provider: trigger.type,
          error: error instanceof Error ? error.message : String(error),
        }, LogComponent.Automation);
      }
    }
  }

  private async pollDispatch(
    trigger: RoutineEventTrigger,
    args: { cursor: string | null; now: number; accessToken: string },
  ): Promise<{ events: RoutineEvent[]; cursor: string | null }> {
    if (trigger.type === 'github') {
      return await pollGithubListener(trigger, { ...args, fetchImpl: this.fetchImpl });
    }
    return await pollSlackListener(trigger, {
      ...args,
      fetchImpl: this.fetchImpl,
      resolveChannelId: (channel) => this.resolveSlackChannelId(channel, args.accessToken),
    });
  }

  /**
   * Map a trigger channel (`C123…`, `#name`, `@user`) to a real channel id
   * via conversations.list; results are cached for the process lifetime
   * (channel ids are stable; the bot must be a member for resolution to
   * succeed — a failed resolution throws and keeps the listener silent).
   */
  private async resolveSlackChannelId(channel: string, accessToken: string): Promise<string | null> {
    if (/^C[A-Z0-9]+$/i.test(channel)) return channel;
    const key = channel.toLowerCase();
    const cached = this.slackChannelIds.get(key);
    if (cached) return cached;
    const response = await this.fetchImpl('https://slack.com/api/conversations.list?limit=200&types=public_channel,private_channel', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    const body = (await response.json().catch(() => null)) as { ok?: boolean; channels?: Array<{ id?: string; name?: string }> } | null;
    if (!body?.ok || !Array.isArray(body.channels)) return null;
    const bare = key.replace(/^[#@]/, '');
    for (const entry of body.channels) {
      if (entry.id && entry.name && entry.name.toLowerCase() === bare) {
        this.slackChannelIds.set(key, entry.id);
        return entry.id;
      }
    }
    return null;
  }

  /** Coalesce matched events into one fire and enqueue the wake. */
  private fire(job: AutomationCron, events: RoutineEvent[], logger: ReturnType<typeof getLogger>): void {
    const batch = events.slice(0, MAX_EVENTS_PER_FIRE);
    const summary = describeEvent(batch[batch.length - 1] as RoutineEvent);
    const blocks: string[] = [];
    let total = 0;
    for (const event of batch) {
      const block = buildEventContextBlock(event);
      total += block.length;
      if (total > MAX_EVENT_CONTEXT_CHARS) break;
      blocks.push(block);
    }
    const targetSessionId = getBotSessionId(job.agent as string);
    const outcome = enqueueAutomationWake({
      jobKey: job.id,
      fireKey: randomUUID(),
      name: job.name,
      targetSessionId,
      trigger: 'event',
      eventSummary: `${summary}${events.length > batch.length ? ` (+${events.length - batch.length} more)` : ''}`,
      eventContext: blocks.join('\n'),
    });
    logger.info('Routine event fire enqueued', {
      cronId: job.id,
      agent: job.agent,
      sessionId: targetSessionId,
      eventCount: batch.length,
      outcome,
    }, LogComponent.Automation);
  }
}

// ==================== bootstrap wiring ====================

let instance: RoutineListenerHub | null = null;

/**
 * Build the hub's real deps on top of the App Connections service and
 * start it. Called from main after the automation scheduler is up. Tests
 * construct RoutineListenerHub directly instead.
 */
export function initRoutineListenerHub(store: CronFileStore): RoutineListenerHub {
  if (instance) return instance;
  const hub = new RoutineListenerHub({
    store,
    resolveAccessToken: async (provider) => {
      const { getAppConnectionService } = await import('../services/app-connections/app-connection-service.js');
      const service = getAppConnectionService();
      const connected = service
        .list()
        .filter((c) => c.provider === provider && c.status === 'connected');
      for (const connection of connected) {
        const token = await service.getValidToken(connection.id);
        if (token.success && token.data?.accessToken) return token.data.accessToken;
      }
      return null;
    },
  });
  hub.start();
  instance = hub;
  return hub;
}

export function stopRoutineListenerHubForTests(): void {
  instance?.stop();
  instance = null;
}
