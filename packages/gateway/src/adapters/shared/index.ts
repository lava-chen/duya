/**
 * Shared adapter toolkit barrel.
 *
 * Anything that two or more channel adapters need belongs here rather than in
 * an adapter directory, so a new channel is assembled from contracts instead of
 * copy-pasted behaviour.
 */

export { BoundedIdSet, type BoundedIdSetOptions } from './dedup.js';
export {
  hmacSha256,
  timingSafeEqualStr,
  verifyHubSignature,
  verifyStandardWebhooks,
  verifyTimestampedSignature,
  verifySharedToken,
  verifyMetaChallenge,
  type StandardWebhooksHeaders,
} from './signature.js';
export {
  parseGatingOptions,
  evaluateGating,
  stripMentionTokens,
  escapeRegExp,
  type AccessPolicy,
  type GatingOptions,
  type GatingInput,
  type GatingVerdict,
} from './gating.js';
export {
  WebhookServer,
  headerValue,
  type WebhookRequest,
  type WebhookResponse,
  type WebhookServerOptions,
} from './webhook-server.js';
export {
  platformCacheDir,
  categorizeMedia,
  extensionForMime,
  cacheMediaBytes,
  fetchMediaToCache,
  readMediaSource,
  type MediaCategory,
  type CachedMedia,
} from './media-cache.js';
