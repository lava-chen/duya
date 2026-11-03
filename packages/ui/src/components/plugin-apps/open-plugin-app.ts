// Opening a Mini App: one place that decides what the App is bound to.
//
// The chat session an App acts in has to be CAPTURED when the user opens it,
// not derived from whatever session happens to be selected later. Before this
// module, the panel page read the global `activeThreadId` directly, which made
// the binding follow the selection: switching chats while the App was detached
// and then returning re-bound a running App to a different session — and its
// tool grants with it.
//
// Every entry point (chat launcher, Apps page, panel menu, placements) goes
// through `openPluginApp` so a new entry point cannot quietly reintroduce the
// derivation.

import type { PanelContextValue } from "@/hooks/usePanel";

/**
 * The context an App instance is opened against.
 *
 * `sessionId` is the chat session at open time. It is stored in the tab params
 * and therefore travels with the tab: a detached panel window snapshots the
 * params, and a restored tab restores the binding.
 */
export interface PluginAppBinding {
  sessionId: string;
}

/** Capture the binding from the context that exists right now. */
export function capturePluginAppBinding(
  activeThreadId: string | null | undefined,
): PluginAppBinding | null {
  return typeof activeThreadId === "string" && activeThreadId.length > 0
    ? { sessionId: activeThreadId }
    : null;
}

/**
 * Read a binding out of persisted tab params.
 *
 * Anything malformed is treated as absent rather than repaired: a tab written
 * by an older build has no binding at all, and must keep working.
 */
export function readPluginAppBinding(
  params: Record<string, unknown> | undefined,
): PluginAppBinding | null {
  const raw = params?.binding;
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const sessionId = (raw as Record<string, unknown>).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? { sessionId } : null;
}

export interface OpenPluginAppInput {
  pluginId: string;
  appId: string;
  /** Surface Apps name the resource they read; entry Apps omit both. */
  surfaceId?: string;
  server?: string;
  title?: string;
  icon?: string;
  availability?: "always" | "session";
  binding: PluginAppBinding | null;
}

/**
 * Open (or focus) the panel tab for one App.
 *
 * Returns the tab id, or undefined outside a panel host.
 */
export function openPluginApp(
  panel: PanelContextValue | null,
  input: OpenPluginAppInput,
): string | undefined {
  if (!panel) return undefined;
  return panel.openOrActivatePage("plugin-app", {
    pluginId: input.pluginId,
    appId: input.appId,
    ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
    ...(input.server ? { server: input.server } : {}),
    ...(input.title ? { title: input.title } : {}),
    ...(input.icon ? { icon: input.icon } : {}),
    availability: input.availability ?? "session",
    ...(input.binding ? { binding: input.binding } : {}),
  });
}
