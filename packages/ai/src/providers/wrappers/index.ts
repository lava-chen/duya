/**
 * packages/ai/src/providers/wrappers/index.ts
 *
 * Barrel for the family-wrapper layer (Plan 451 Phase 0+).
 *
 * Phase 0: composition primitive only.
 * Phase 1+: per-family wrappers (`anthropic-family-*`, `openai-family-*`)
 *   are re-exported here as they land.
 */

export { pipe, type Wrapper } from './compose.js';