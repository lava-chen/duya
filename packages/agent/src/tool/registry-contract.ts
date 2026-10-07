/**
 * Plan 610 A5 — the pure tool-contract types, in one place.
 *
 * This module is a type-only re-export. It exists so the pure *shapes* have a
 * home that does not drag in the registry's runtime state, and it takes over
 * no behaviour: `ToolRegistry`, `catalogRevision`, and `replaceByOwner` all
 * stay in `./registry.js` exactly as they are.
 *
 * It is deliberately type-only, so it emits nothing at build time. Every
 * existing edge that imported these types as `import type` stays type-only,
 * including the `modes/` edges, and nothing in the emitted JS graph moves.
 *
 * `@duya/tooling` does not consume this module and this module does not
 * consume `@duya/tooling`. The tooling package is contract-first: the runtime
 * wiring that will consume the extension registry is a later slice.
 */

export type {
  ToolExecutor,
  ToolMetaInput,
  ToolMeta,
  ToolHintMeta,
  ToolOwner,
  ReplaceableOwner,
  ToolExposure,
} from './registry.js';
