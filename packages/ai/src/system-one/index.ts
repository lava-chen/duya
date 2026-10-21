/**
 * system-one — typed decision client surface (plan 551 Phase 1).
 *
 * Public exports for the System One (Jev) integration. Consumers program
 * against the `DecisionClient` interface; `SystemOneClient` is the first
 * backend. The LLM structured-output adapter (plan 551 Phase 2 fallback)
 * and local SemIf-style backends implement the same interface.
 */

export type {
  DecisionKind,
  DecisionRequest,
  DecisionResponse,
  DecisionAnswer,
  ChoiceQuestion,
  ChoiceAnswer,
  ScoreQuestion,
  ScoreAnswer,
  NoulQuestion,
  NoulAnswer,
  Question,
} from './types.js';
export {
  MAX_CARDINALITY,
  DecisionProtocolError,
  validateDecisionRequest,
} from './types.js';
export {
  SystemOneClient,
  parseDecisionResponse,
  type DecisionClient,
  type SystemOneClientOptions,
  DEFAULT_SYSTEM_ONE_BASE_URL,
  DEFAULT_SYSTEM_ONE_MODEL,
  DEFAULT_SYSTEM_ONE_TIMEOUT_MS,
} from './client.js';
export {
  DEFAULT_SYSTEM_ONE_CONFIG,
  resolveSystemOneConfig,
  type SystemOneConfig,
} from './config.js';
