/**
 * packages/ai/src/providers/wrappers/anthropic-family-cache-control.ts
 *
 * Plan 451 Phase 1 — anthropic-family cache-control decision.
 *
 * `applyCacheControl` operates on Anthropic's wire-format `MessageParam[]`
 * (post-conversion from duya's internal `Message[]`), which the
 * `ProviderStreams` interface does not surface. To run cache_control as
 * a true stream wrapper, the protocol layer needs an `onPayload` hook
 * (planned for a later phase once multiple wire-payload wrappers justify
 * the infrastructure).
 *
 * For Phase 1 this module exposes the cache-control *eligibility* decision
 * (`checkCacheEligibility`) — providers and tests can declare and verify
 * cache strategies per model without touching the wire-payload internals.
 *
 * The decision is independent of any stream event and safe to invoke at
 * provider construction time.
 */

export {
  checkCacheEligibility,
  applyCacheControl,
  applyCacheControlToSystem,
  stripCacheControl,
  hasCacheControl,
  type CacheControl,
  type CacheEligibility,
  type CacheRetention,
} from '../../utils/prompt-caching.js';