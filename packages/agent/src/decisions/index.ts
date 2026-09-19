/**
 * decisions — agent decision layer (plan 551 Phase 2).
 *
 * Public surface of the @duya/agent decision infrastructure:
 *
 *   - `DecisionService` — typed decisions over the degradation chain
 *     Jev → LLM structured-output → caller rules.
 *   - `createDecisionServiceFromConfig` — build (or skip) the service
 *     from `[system_one]` config.toml + TYPESAFE_API_KEY. With no key
 *     the service is `available === false` and every call site no-ops,
 *     which is the zero-behavior-change guarantee of plan 551.
 *   - `getDecisionService` — process-wide lazy singleton.
 */

import {
  SystemOneClient,
  type DecisionClient,
} from '@duya/ai';
import { DecisionService, createPermissionPrescreener } from './service.js';
import { readDecisionsConfig, type DecisionsConfig } from './config.js';

export { DecisionService, DecisionUnavailableError, createPermissionPrescreener } from './service.js';
export type {
  AskOptions,
  DecisionServiceOptions,
  PermissionPrescreenSuggestion,
  ResolvedNoul,
} from './service.js';
export type { PermissionPrescreener } from './service.js';
export { CalibrationLogger, DECISIONS_LOG_COMPONENT } from './calibration.js';
export type { CalibrationRecord, CalibrationSink } from './calibration.js';
export {
  DEFAULT_DECISION_POLICY,
  evaluateNoul,
  grayBand,
  resolveDecisionPolicy,
  topCandidates,
} from './policy.js';
export type { DecisionPolicy, NoulVerdict } from './policy.js';
export { LlmDecisionFallback, parseLlmDecision } from './fallback.js';
export type { LlmChatClient, LlmDecisionFallbackOptions } from './fallback.js';
export { readDecisionsConfig } from './config.js';
export type { DecisionsConfig, DecisionPrescreenConfig } from './config.js';

export interface CreateDecisionServiceOptions {
  /** Test seam: skip the config file and use these values. */
  config?: Partial<DecisionsConfig>;
  /** Test seam: overrides for config resolution (config root). */
  configRoot?: string;
}

/**
 * Build a DecisionService from configuration. Returns a service with
 * `available === false` when System One is not enabled/keyed — callers
 * just check `available` and otherwise behave exactly as before.
 *
 * The degradation chain is Jev → LLM structured-output → caller rules.
 * The LLM link is optional and attached by callers who hold a chat
 * client (`new DecisionService({ client, fallback: new LlmDecisionFallback({ llm }) })`);
 * without it a Jev failure surfaces as `DecisionUnavailableError` and
 * the caller's rule path takes over.
 */
export function createDecisionServiceFromConfig(
  options?: CreateDecisionServiceOptions,
): DecisionService {
  const fileConfig = readDecisionsConfig(options?.configRoot);
  const merged: DecisionsConfig = {
    systemOne: { ...fileConfig.systemOne, ...options?.config?.systemOne },
    policy: { ...fileConfig.policy, ...options?.config?.policy },
    prescreen: { ...fileConfig.prescreen, ...options?.config?.prescreen },
  };

  let primary: DecisionClient | undefined;
  if (merged.systemOne.enabled && merged.systemOne.apiKey) {
    primary = new SystemOneClient({
      apiKey: merged.systemOne.apiKey,
      model: merged.systemOne.model,
      baseUrl: merged.systemOne.baseUrl,
      timeoutMs: merged.systemOne.timeoutMs,
    });
  }
  return new DecisionService({ client: primary, policy: merged.policy });
}

let singleton: DecisionService | null = null;

/**
 * Process-wide lazy DecisionService. Resolved once from config; with no
 * `[system_one]` section / env key this is a disabled service and all
 * consumers take their existing paths.
 */
export function getDecisionService(): DecisionService {
  if (!singleton) {
    singleton = createDecisionServiceFromConfig();
  }
  return singleton;
}

/** Test seam — reset the singleton. */
export function resetDecisionService(): void {
  singleton = null;
}

let prescreener: ReturnType<typeof createPermissionPrescreener> | null | undefined;

/**
 * Lazily-resolved 419 pre-screen channel (plan 551 Phase 2, default off).
 * Returns null unless `[system_one] prescreen.permissions = true` AND a
 * decision backend is configured — callers treat null as "channel off"
 * and proceed exactly as before. Memoized after the first call.
 */
export function getPermissionPrescreener(): ReturnType<typeof createPermissionPrescreener> | null {
  if (prescreener === undefined) {
    const service = getDecisionService();
    const enabled = service.available && readDecisionsConfig().prescreen.permissions;
    prescreener = enabled
      ? createPermissionPrescreener(service, true)
      : null;
  }
  return prescreener;
}
