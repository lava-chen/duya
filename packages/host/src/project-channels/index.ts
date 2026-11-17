/**
 * The Host Project channel domain (plan C). Assembly-ready: the composition
 * root injects the stores, the neutral transport, the secret port, the
 * Coordinator ensure and the Run admission port. No HTTP, no CLI, no Gateway.
 */

export {
  createProjectChannelHostService,
  type ProjectChannelHostService,
  type ProjectChannelHostServiceOptions,
  type ProjectChannelRecoveryReport,
} from './service.js';
export {
  createProjectChannelSecretStore,
  createInMemoryProjectChannelSecrets,
  ProjectChannelSecretError,
  type ProjectChannelSecretErrorCode,
  type ProjectChannelSecretPort,
  type ProjectChannelSecretStoreOptions,
} from './secrets.js';
export {
  createProjectChannelPendingIndex,
  type ProjectChannelPendingIndex,
  type ProjectChannelQueryDatabase,
  type ProjectChannelQueuedInput,
} from './pending.js';
export {
  createProjectChannelInbound,
  frameInboundPrompt,
  type ProjectChannelInbound,
} from './inbound.js';
export {
  createProjectChannelOutbound,
  type ProjectChannelCaller,
  type ProjectChannelOutbound,
} from './outbound.js';
export {
  DEFAULT_CLOCK,
  ProjectChannelServiceError,
  errorCodeOf,
  projectChannelServiceError,
  type ProjectChannelClock,
  type ProjectChannelContext,
  type ProjectChannelExecutionPort,
  type ProjectChannelHostStores,
  type ProjectChannelLogger,
} from './types.js';
