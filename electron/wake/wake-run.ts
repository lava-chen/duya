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
import { resolveCronProvider } from '../automation/provider';
import { getAgentServerPort } from '../agents/agent-server-lifecycle';
import { runPromptInSession } from '../automation/agent-run';
import { toLLMProvider } from '../config/provider-types';
import { getLogger, LogComponent } from '../logging/logger';

/** Per-run options handed down by the wake dispatcher (477 P3.1). */
export interface WakeRunOptions {
  /** Bot profile id for persistent `bot:<agentId>` sessions. */
  agentProfileId?: string
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
export async function runWakePromptInExistingSession(
  sessionId: string,
  prompt: string,
  opts?: WakeRunOptions,
): Promise<void> {
  const port = getAgentServerPort()
  if (!port) {
    getLogger().warn('Wake run skipped: agent server not running', { sessionId }, LogComponent.Automation)
    return
  }

  // Resolve provider/model the same way cron does (default LLM provider).
  let resolved: { provider: import('../../src/lib/providers/types').ApiProvider; model: string }
  try {
    resolved = resolveCronProvider(undefined)
  } catch {
    getLogger().warn('Wake run skipped: no provider configured', { sessionId }, LogComponent.Automation)
    return
  }

  // Prefer the session's own working directory when it exists.
  let workingDirectory = ''
  try {
    const session = getCoreStores().sessions.get(sessionId)
    workingDirectory = session?.workingDirectory ?? ''
  } catch {
    // Session row may not exist yet — empty workspace falls back to default.
  }

  getLogger().info('Idle wake run starting', {
    sessionId,
    model: resolved.model,
    reason: 'background_notification',
  }, LogComponent.Automation)

  await runPromptInSession({
    sessionId,
    prompt,
    workingDirectory,
    providerConfig: {
      apiKey: resolved.provider.apiKey,
      baseURL: resolved.provider.baseUrl,
      model: resolved.model,
      provider: toLLMProvider(resolved.provider.providerType),
      authStyle: 'api_key',
    },
    options: {
      agentProfileId: opts?.agentProfileId,
      effort: 'off',
      llmRequestTimeoutMs: 240_000,
      wakeRun: true,
    },
  })
}
