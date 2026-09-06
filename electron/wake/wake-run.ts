/**
 * wake-run.ts — run a hidden wake turn against an existing session
 * (Plan 476 Phase 0-B helper).
 *
 * Mirrors the cron dispatch path (`runPromptInSession`) but for a session
 * the user already has open: we read the session's own row for its working
 * directory, then use the default provider/model (cron's resolution) for
 * the request — wake runs are short follow-ups; matching the session's
 * original model is a Phase 2 refinement when per-bot config lands in 485.
 *
 * Kept as a separate module so idle-dispatcher stays a thin orchestrator
 * and this file can grow provider/workspace resolution without churn.
 */

import { getCoreStores } from '../db/core-connection';
import { resolveCronProvider, resolveBotWakeProvider } from '../automation/provider';
import type { ResolvedCronProvider } from '../automation/provider';
import { buildCronProviderConfig } from '../automation/provider-config';
import { readConfigAgents } from '../../packages/agent/src/agent-profile/config-agents.js';
import type { CustomAgentConfig } from '../../packages/agent/src/agent-profile/config-agents.js';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { runPromptInSession } from '../automation/agent-run';
import { getLogger, LogComponent } from '../logging/logger';

/** Per-run options handed down by the wake dispatcher (477 P3.1). */
export interface WakeRunOptions {
  /** Bot profile id for persistent `bot:<agentId>` sessions. */
  agentProfileId?: string
  /** Lane of the wake item being dispatched — persisted as the run's lock
   *  origin so the scheduler can attribute the in-flight run (Plan 500 P1). */
  lane?: 'user' | 'agent' | 'background'
}

/** What the wake runner reports back to the dispatcher (477 P4.3). */
export interface WakeRunOutcome {
  /** Joined assistant text of the run ('' when the run failed/produced none). */
  output: string
  /** Raw SSE events observed during the run (for send_to_agent detection). */
  events: Array<{ type: string; data?: unknown }>
}

/**
 * POST a hidden wake prompt to an existing session. Best-effort: logs and
 * swallows failures so the caller (idle-dispatcher) never throws for a
 * notification that was already persisted durably.
 *
 * For bot persistent sessions (477 P3.1, id `bot:<agentId>`) the dispatcher
 * resolves the bot's agent id from the session id itself and passes it as
 * `opts.agentProfileId`, so the run builds the bot toolset (SendMessage /
 * SendToAgent / update_state) and the 474 prompt sections. Matching the
 * session's original model stays a 485 refinement.
 */
/** Extract a session's own working directory, defaulting to '' when the row
 *  is missing. Shared by the wake-run and user-turn run paths (plan 505). */
function resolveSessionWorkingDirectory(sessionId: string): string {
  try {
    return getCoreStores().sessions.get(sessionId)?.workingDirectory ?? '';
  } catch {
    return '';
  }
}

export async function runWakePromptInExistingSession(
  sessionId: string,
  prompt: string,
  opts?: WakeRunOptions,
): Promise<WakeRunOutcome> {
  const port = getAgentServerPort()
  if (!port) {
    getLogger().warn('Wake run skipped: agent server not running', { sessionId }, LogComponent.Automation)
    return { output: '', events: [] }
  }

  // A bot wake uses the bot's own provider/model (from config.toml) so a bot
  // with its own provider wakes even when there is no global default; a plain
  // session falls back to the default provider, exactly like cron.
  let resolved: ResolvedCronProvider
  try {
    const botAgentId = opts?.agentProfileId
    let botConfig: CustomAgentConfig | undefined
    if (botAgentId) {
      const agents = await readConfigAgents()
      botConfig = agents[botAgentId]
    }
    resolved = botConfig
      ? resolveBotWakeProvider(botConfig.provider, botConfig.model)
      : resolveCronProvider(undefined)
  } catch {
    getLogger().warn('Wake run skipped: no provider configured', { sessionId }, LogComponent.Automation)
    return { output: '', events: [] }
  }

  // Prefer the session's own working directory when it exists.
  const workingDirectory = resolveSessionWorkingDirectory(sessionId)

  getLogger().info('Idle wake run starting', {
    sessionId,
    model: resolved.model,
    reason: 'background_notification',
  }, LogComponent.Automation)

  return await runPromptInSession({
    sessionId,
    prompt,
    workingDirectory,
    providerConfig: buildCronProviderConfig(resolved),
    options: {
      agentProfileId: opts?.agentProfileId,
      effort: 'off',
      llmRequestTimeoutMs: 240_000,
      wakeRun: true,
      runOrigin: opts?.lane ?? 'background',
    },
  })
    .then((result) => ({ output: result.output, events: result.events }))
    .catch(() => ({ output: '', events: [] }))
}

/**
 * Run a queued USER turn as a hidden fallback (Plan 500 P2.2) — used when a
 * scheduled user-lane wake finds no renderer view to claim it (app window
 * closed / different surface). Unlike `runWakePromptInExistingSession` this
 * preserves user-turn semantics: no `effort: 'off'`, no `wakeRun` — the
 * server marks it `userTurn` (epoch advances, lock origin 'user') and the
 * session's own provider/model is used.
 */
export async function runUserTurnInSession(
  sessionId: string,
  prompt: string,
  opts?: WakeRunOptions,
): Promise<WakeRunOutcome> {
  const port = getAgentServerPort()
  if (!port) {
    getLogger().warn('User-turn fallback skipped: agent server not running', { sessionId }, LogComponent.Automation)
    return { output: '', events: [] }
  }

  // Prefer the session's own provider/model; fall back to the default.
  let sessionModel: string | undefined
  try {
    sessionModel = getCoreStores().sessions.get(sessionId)?.model ?? undefined
  } catch {
    // Session row may not exist yet — empty workspace falls back to default.
  }

  let resolved: ResolvedCronProvider
  try {
    resolved = resolveCronProvider(sessionModel)
  } catch {
    getLogger().warn('User-turn fallback skipped: no provider configured', { sessionId }, LogComponent.Automation)
    return { output: '', events: [] }
  }

  const workingDirectory = resolveSessionWorkingDirectory(sessionId)

  getLogger().info('Queued user-turn fallback run starting', {
    sessionId,
    model: resolved.model,
  }, LogComponent.Automation)

  return await runPromptInSession({
    sessionId,
    prompt,
    workingDirectory,
    providerConfig: buildCronProviderConfig(resolved),
    options: {
      agentProfileId: opts?.agentProfileId,
      llmRequestTimeoutMs: 240_000,
      runOrigin: 'user',
    },
  })
    .then((result) => ({ output: result.output, events: result.events }))
    .catch(() => ({ output: '', events: [] }))
}
