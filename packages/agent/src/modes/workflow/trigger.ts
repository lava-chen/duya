/**
 * trigger.ts — the unified trigger entry (plan 552 §7).
 *
 * Four channels converge on `launchFromTrigger`:
 *   manual  — `/workflow <name>` Slash Command + save-as (always allowed)
 *   cron    — 405/409 CronStore tick fires the scheduled channel
 *   bot     — 476 wake bus / 488 bot inbound messages
 *   http    — Agent Server `POST /workflow/<name>/trigger` (影刀 OpenAPI
 *             对标; auth rides the existing gateway grouping)
 *
 * Idempotency (at-least-once delivery must not double-execute):
 *   cron  → `cron:<workflow>:<fired minute, ISO normalized>`
 *   bot   → `bot:<inbound message id>`
 *   http  → `http:<workflow>:<idempotency key from header/body>`
 *   manual → none (a user re-invoking is a deliberate new run)
 *
 * A dedup hit returns the EXISTING run (`deduped`) without executing —
 * the manager/store's unique index is the second line of defense.
 * Channel gating: cron/bot/http launches of a definition that does not
 * declare the matching trigger are rejected (缺省 = 仅手动, §4.1).
 */

import type { WorkflowDef, WorkflowTrigger } from './schema.js';
import type { WorkflowManager, LaunchResult } from './manager.js';
import { CronTriggerSchema, BotTriggerSchema, HttpTriggerSchema } from './schema.js';

export type TriggerChannel = 'manual' | 'cron' | 'bot' | 'http';

export interface TriggerInput {
  channel: TriggerChannel;
  workflowName: string;
  /** Channel-specific idempotency / identity material. */
  cronFireAt?: Date | number;
  botMessageId?: string;
  httpIdempotencyKey?: string;
  params?: Record<string, unknown>;
  /** The def, resolved by the caller (registry load for non-manual). */
  def: WorkflowDef;
}

export type TriggerOutcome = LaunchResult & {
  /** Present when the launch was deduped: the earlier run's id. */
  dedupKey?: string;
};

/** Normalize a cron fire instant to minute precision (ISO, UTC — stable
 * across DST/locales so retries from the same tick collide). */
export function normalizeCronInstant(fireAt: Date | number): string {
  const d = typeof fireAt === 'number' ? new Date(fireAt) : fireAt;
  const floor = new Date(Math.floor(d.getTime() / 60_000) * 60_000);
  return floor.toISOString().slice(0, 16); // YYYY-MM-DDTHH:mm
}

export function buildDedupKey(input: Pick<TriggerInput, 'channel' | 'workflowName' | 'cronFireAt' | 'botMessageId' | 'httpIdempotencyKey'>): string | undefined {
  switch (input.channel) {
    case 'cron':
      if (input.cronFireAt === undefined) throw new Error('cron trigger requires cronFireAt');
      return `cron:${input.workflowName}:${normalizeCronInstant(input.cronFireAt)}`;
    case 'bot':
      if (!input.botMessageId) throw new Error('bot trigger requires botMessageId');
      return `bot:${input.botMessageId}`;
    case 'http':
      if (!input.httpIdempotencyKey) throw new Error('http trigger requires httpIdempotencyKey');
      return `http:${input.workflowName}:${input.httpIdempotencyKey}`;
    case 'manual':
    default:
      return undefined;
  }
}

/** Does the def declare a trigger for this channel? Manual is always on. */
export function channelAllowed(def: WorkflowDef, channel: TriggerChannel): boolean {
  if (channel === 'manual') return true;
  const triggers: WorkflowTrigger[] = def.triggers ?? [];
  if (channel === 'cron') return triggers.some((t) => CronTriggerSchema.safeParse(t).success);
  if (channel === 'bot') return triggers.some((t) => BotTriggerSchema.safeParse(t).success);
  return triggers.some((t) => HttpTriggerSchema.safeParse(t).success);
}

/**
 * Unified entry: gate the channel → build the dedup key → dedup check →
 * launch (through the manager's validation + high-risk path).
 */
export async function launchFromTrigger(
  manager: WorkflowManager,
  input: TriggerInput,
): Promise<TriggerOutcome> {
  if (!channelAllowed(input.def, input.channel)) {
    return {
      status: 'failed',
      runId: 'unstarted',
      errorClass: 'unknown',
      error: `workflow "${input.workflowName}" does not declare a ${input.channel} trigger (manual only)`,
    };
  }
  const dedupKey = buildDedupKey(input);
  const result = await manager.launch({
    def: input.def,
    params: input.params ?? {},
    triggerKind: input.channel,
    dedupKey,
  });
  if (result.status === 'deduped') return { ...result, dedupKey };
  return result;
}
