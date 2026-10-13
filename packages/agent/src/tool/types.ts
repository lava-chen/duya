/**
 * Plan 610 A8 shim — the pure tool-contract types moved to
 * `@duya/capabilities/contracts`. This module is a type-only pass-through so
 * every existing `./types.js` import inside the agent keeps resolving.
 *
 * `ToolUseContext` is now the narrow structural type defined in the
 * capability contract; the wide agent-side `ToolUseContext` in
 * `../types.js` remains assignable to it, which every typechecked
 * registration and executor call site proves on every build.
 */

export * from '@duya/capabilities/contracts';

/** @deprecated pass-through kept for compatibility — see module doc. */
export type { ToolUse } from '../types.js';
