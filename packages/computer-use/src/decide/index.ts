/**
 * decide — computer-use perception-decision channel (plan 551 Phase 3).
 *
 * "LLM plans, Jev decides": the planner states an outcome, this channel
 * runs the settle → describe → ask → act inner loop with typed
 * decisions, and returns an honest status contract. When no decision
 * backend is configured the channel is simply not exposed (zero
 * behavior change — plan 551 Non-Goals).
 */

export {
  MAX_DESCRIBED_ELEMENTS,
  describePage,
  pageStateToDecisionState,
} from './describe.js';
export type {
  DescribedElement,
  PageChange,
  PageMetrics,
  PageState,
} from './describe.js';
export { ROUND_QUESTION_IDS, buildRoundQuestions, buildStrictConfirmationQuestion, elementOption } from './questions.js';
export type { RoundQuestionId, RoundQuestionInput } from './questions.js';
export {
  DEFAULT_DECIDE_LOOP_POLICY,
  DEFAULT_MAX_ACTIONS,
  actionForTarget,
  parseElementIndex,
  runDecideLoop,
} from './controller.js';
export type {
  DecideAction,
  DecideActResult,
  DecideLoopOptions,
  DecideLoopPolicy,
  DecideLoopPorts,
  DecideLoopResult,
  DecideRoundTrace,
  DecideStatus,
} from './controller.js';
export { createBridgeConfirmGate, createExecutorConfirmGate } from './confirm-gate.js';
export type { DecideConfirmGate } from './confirm-gate.js';
export { DEFAULT_VERDICT_BRIDGE_THRESHOLDS, assessVerdict } from './verdict-bridge.js';
export type { VerdictAssessment, VerdictBridgeThresholds } from './verdict-bridge.js';
