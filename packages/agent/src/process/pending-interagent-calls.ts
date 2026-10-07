/**
 * The pending inter-agent call registry.
 *
 * ## Why this file exists at all, and what it is NOT
 *
 * The registry is a two-producer module-level `Map`, and the two producers
 * were, until this extraction, on opposite sides of a module cycle:
 *
 * - `tool/MessageSessionTool/MessageSessionTool.ts` registers a call before it
 *   sends `interagent:invoke`, and unregisters it when the call settles.
 * - `process/agent-process-entry.ts` reads the entry back when the server
 *   forwards the target worker's `chat:*` events as `interagent:event`.
 *
 * So the tool reached into the 5000-line worker entry for two functions, and
 * the entry reached into the tool for nothing. `MessageSessionTool` is reachable
 * from `tool/builtin.ts`, and the entry is reachable from `modes/index.ts`, so
 * that one edge closed a loop through the whole entry/agent/tool/modes
 * component -- a cycle the architecture gate counts as one finding whose
 * identity is the component's size.
 *
 * ## What it is NOT
 *
 * This is not a shared-state service, a bus, or a relocation of the worker's
 * role in the inter-agent protocol. The lifecycle is unchanged: the caller still
 * buffers events by invoke id, and the entry still resolves the tool promise on
 * `chat:done` / `chat:error`. Only the OWNER of the `Map` moved, so both sides
 * can depend on a leaf module instead of on each other.
 *
 * A leaf, deliberately: this module imports nothing but the event type, so it
 * cannot become the next back-edge. Any future reader that reaches for the
 * entry to get at process-level state is re-creating the same cycle, and the
 * gate will say so.
 */

// Pending inter-agent call registry.
// Architecture: the caller worker sends `interagent:invoke` via process.send,
// the server routes it to a target worker, and forwards the target's chat:*
// events back to the caller as `interagent:event` commands. The caller
// buffers events here (keyed by invoke id) and resolves the tool promise
// on `chat:done` / `chat:error`.
import type { WorkerEvent } from './worker-protocol.js';

export interface PendingInteragentCall {
  events: WorkerEvent[];
  resolveDone: (event: WorkerEvent) => void;
  resolveError: (event: WorkerEvent) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingInteragentCalls = new Map<string, PendingInteragentCall>();

export function registerPendingInteragentCall(id: string, call: PendingInteragentCall): void {
  pendingInteragentCalls.set(id, call);
}

export function unregisterPendingInteragentCall(id: string): void {
  pendingInteragentCalls.delete(id);
}

export function getPendingInteragentCall(id: string): PendingInteragentCall | undefined {
  return pendingInteragentCalls.get(id);
}