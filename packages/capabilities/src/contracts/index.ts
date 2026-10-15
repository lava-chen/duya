/**
 * `@duya/capabilities/contracts` — the tool contract surface.
 *
 * `tool.ts` holds the pure tool-contract types (moved verbatim from
 * `packages/agent/src/tool/types.ts`); `dependencies.ts` holds the
 * dependency-declaration contract (moved verbatim from
 * `packages/agent/src/tool/dependencies.ts`). Type-only consumers in the
 * agent import these through the `packages/agent/src/tool/types.ts` /
 * `dependencies.ts` shims, so no agent-side import path changed.
 */

export * from './tool.js';
export * from './dependencies.js';
