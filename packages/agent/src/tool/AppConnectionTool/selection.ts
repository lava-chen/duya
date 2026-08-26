/**
 * Connector selection — per-run @ mention state (Plan 450 Phase A).
 *
 * Codex parity: `core/src/state/session.rs` `active_connector_selection`.
 * The user can @-mention an app in the composer; mentioned providers are
 * merged into this set at chat:start and the set is cleared when the run
 * reaches a terminal state. Within the run:
 *
 *   - connector tools of selected providers skip tool_search discovery
 *     (exposure promotion in DuyaAgent._resolveTools);
 *   - a one-shot `<system-reminder>` tells the model the user explicitly
 *     named these apps (injected via the promptContexts rail).
 *
 * Scope: module-level state inside the agent worker process. Each duya
 * session runs its own worker, so process lifetime === session lifetime,
 * mirroring codex's per-session state container.
 */

const activeSelection = new Set<string>();

/** Merge provider ids into the active selection; returns a copy. */
export function mergeConnectorSelection(ids: Iterable<string>): Set<string> {
  for (const id of ids) {
    if (id) activeSelection.add(id);
  }
  return new Set(activeSelection);
}

/** Copy of the currently active selection. */
export function getConnectorSelection(): Set<string> {
  return new Set(activeSelection);
}

/** Whether a provider was @-mentioned in the current run. */
export function isProviderSelected(provider: string): boolean {
  return activeSelection.has(provider);
}

/** Clear the selection (run terminal state / new run without mentions). */
export function clearConnectorSelection(): void {
  activeSelection.clear();
}
