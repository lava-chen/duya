/**
 * memory/index.ts (barrel) — re-exports for the memory module.
 *
 * The actual implementations live in ./index.ts and ./slice.ts. This
 * file re-exports both so consumers can `import { ... } from
 * '@duya/computer-use/som/memory'` (singular convention to avoid
 * collision with the implementation file).
 */

export {
  ComputerUseMemory,
  getDefaultMemory,
  parseMemory,
  serializeMemory,
  DEFAULT_PATH as MEMORY_DEFAULT_PATH,
  type ComputerUseMemoryOptions,
  type MemoryEntry,
} from './core.js';

export {
  sliceForApp,
  estimateTokens,
  DEFAULT_SLICE_TOKEN_BUDGET,
  CHARS_PER_TOKEN,
  type MemorySlice,
} from './slice.js';