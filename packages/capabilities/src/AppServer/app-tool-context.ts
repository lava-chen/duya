/**
 * The context pipeline for the in-process app server (plan 616 T610b).
 *
 * ## Why this exists
 *
 * MCP `tools/call` carries only `name` + `arguments`. The product
 * capabilities that live in `duya_app` need the LIVE host context:
 * `ipcRequest` (a function that reaches the main process),
 * `options.sessionId`, per-turn app state, and the turn's
 * `abortController`. None of that survives a JSON boundary, and none of
 * it belongs in the tool's arguments — it is host state, not a
 * model-supplied value.
 *
 * ## The mechanism
 *
 * AsyncLocalStorage. The caller wraps the call in
 * `withAppToolContext(context, …)`; the server side reads
 * `currentAppToolContext()`. ALS propagates across `await` and keeps
 * concurrent calls isolated — each call's own context, with no
 * cross-talk. That isolation is what makes the alternative (a mutable
 * "current context" field on a shared object) unusable here: several
 * tool calls can be in flight at once.
 *
 * The alternative — smuggling a live object through `params._meta` —
 * also works, but `_meta` is a PUBLIC protocol field: every MCP server
 * would see a host-private object. ALS keeps the context entirely
 * in-process.
 *
 * ## Scope
 *
 * ALS only propagates within one process. That is precisely why
 * `duya_app` is an in-process server: if it were ever moved to a
 * subprocess, this pipeline would stop working and the tool would have
 * to receive its context explicitly (serialized) instead.
 */

import { AsyncLocalStorage } from 'node:async_hooks';

import type { ToolUseContext } from '../contracts/tool.js';

/**
 * The host context an app-server tool may read.
 *
 * Deliberately the capability-level structural type, not the host's
 * wide one: capabilities must not know who calls them, and the host's
 * `ToolUseContext` is structurally assignable to this one. Tools that need more context narrow it themselves.
 */
export type AppToolContext = ToolUseContext;

/**
 * The ambient store.
 *
 * Typed as `unknown` rather than `AppToolContext` on purpose: the
 * context that flows through here is the HOST's wide `ToolUseContext`
 * (which carries additional host fields the capability-level type does not
 * declare). Narrowing happens at the
 * READ site, where the tool knows what it needs — the same discipline
 * the capability contracts already follow.
 */
const context = new AsyncLocalStorage<unknown>();

/**
 * Run `action` with `value` as the ambient app-tool context.
 *
 * The value is stored by reference, and isolation between concurrent calls
 * comes from AsyncLocalStorage itself — each `run()` gets its own
 * store — not from copying the value.
 */
export function withAppToolContext<T>(
  value: unknown,
  action: () => T,
): T {
  return context.run(value, action);
}

/**
 * The ambient app-tool context, or `undefined` when the caller did not
 * establish one (e.g. a tool invoked outside a turn).
 */
export function currentAppToolContext<T = AppToolContext>(): T | undefined {
  return context.getStore() as T | undefined;
}
