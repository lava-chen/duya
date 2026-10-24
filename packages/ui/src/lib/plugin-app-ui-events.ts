import {
  AnthropicToolNamePolicy,
  computeProviderName,
  scopedPluginServerName,
  toolInternalKey,
} from "@duya/plugin-core";
import type { ToolUseInfo } from "@/types/message";

export type PluginAppUiEventName = "select" | "highlight" | "refresh";

export interface PluginAppUiEvent {
  channel: "duya.plugin-app";
  type: "event";
  documentToken: string;
  surfaceId: string;
  eventName: PluginAppUiEventName;
  payload: Record<string, unknown>;
}

const ACTION_TOOL_NAMES: Readonly<Record<PluginAppUiEventName, string>> = {
  select: "duya_ui_select",
  highlight: "duya_ui_highlight",
  refresh: "duya_ui_refresh",
};

const MAX_EVENT_BYTES = 8 * 1024;

/** Model-visible identity for one exact tool from a plugin-owned MCP server. */
export function pluginUiEventToolName(pluginId: string, server: string, eventName: PluginAppUiEventName): string {
  const scopedServer = scopedPluginServerName(pluginId, server);
  return computeProviderName(
    toolInternalKey(scopedServer, ACTION_TOOL_NAMES[eventName]),
    new Set(),
    AnthropicToolNamePolicy,
  );
}

/** Translate one tool call into a bounded event for exactly one launched surface. */
export function pluginUiEventFromToolUse(
  toolUse: ToolUseInfo,
  target: { pluginId: string; server: string; surfaceId: string },
): Omit<PluginAppUiEvent, "channel" | "type" | "documentToken"> | null {
  const action = (Object.keys(ACTION_TOOL_NAMES) as PluginAppUiEventName[])
    .find((eventName) => toolUse.name === pluginUiEventToolName(target.pluginId, target.server, eventName));
  if (!action || typeof toolUse.input !== "object" || toolUse.input === null || Array.isArray(toolUse.input)) {
    return null;
  }

  const input = toolUse.input as Record<string, unknown>;
  if (input.surfaceId !== target.surfaceId) return null;
  const payload = action === "refresh" ? {} : cloneBoundedPayload(input.payload);
  if (!payload) return null;
  return { surfaceId: target.surfaceId, eventName: action, payload };
}

/** Narrow a guest readiness message to the current opaque-origin document. */
export function isPluginAppGuestReady(raw: unknown, expectedDocumentToken: string): boolean {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return false;
  const message = raw as Record<string, unknown>;
  return Object.keys(message).length === 3
    && message.channel === "duya.plugin-app"
    && message.method === "ready"
    && message.documentToken === expectedDocumentToken;
}

function cloneBoundedPayload(raw: unknown): Record<string, unknown> | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  try {
    const json = JSON.stringify(raw);
    if (new TextEncoder().encode(json).byteLength > MAX_EVENT_BYTES) return null;
    const clone: unknown = JSON.parse(json);
    return typeof clone === "object" && clone !== null && !Array.isArray(clone)
      ? clone as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
