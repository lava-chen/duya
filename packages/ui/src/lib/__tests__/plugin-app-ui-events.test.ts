import { describe, expect, it } from "vitest";
import type { ToolUseInfo } from "@/types/message";
import {
  isPluginAppGuestReady,
  pluginUiEventFromToolUse,
  pluginUiEventToolName,
} from "../plugin-app-ui-events";

const target = { pluginId: "com.duya.viewer", server: "reports", surfaceId: "overview" };

function toolUse(name: string, input: unknown): ToolUseInfo {
  return { id: "tool-call-1", name, input };
}

describe("Plugin App UI event routing", () => {
  it("accepts only actions from the declared plugin server and current surface", () => {
    const selectName = pluginUiEventToolName(target.pluginId, target.server, "select");
    expect(pluginUiEventFromToolUse(toolUse(selectName, {
      surfaceId: "overview",
      payload: { recordId: "r-17" },
      ignored: "not forwarded",
    }), target)).toEqual({
      surfaceId: "overview",
      eventName: "select",
      payload: { recordId: "r-17" },
    });

    expect(pluginUiEventFromToolUse(toolUse(selectName, {
      surfaceId: "other-surface", payload: { recordId: "r-17" },
    }), target)).toBeNull();
    expect(pluginUiEventFromToolUse(toolUse(
      pluginUiEventToolName("com.duya.other", target.server, "select"),
      { surfaceId: "overview", payload: { recordId: "r-17" } },
    ), target)).toBeNull();
    expect(pluginUiEventFromToolUse(toolUse(
      pluginUiEventToolName(target.pluginId, "other-server", "select"),
      { surfaceId: "overview", payload: { recordId: "r-17" } },
    ), target)).toBeNull();
  });

  it("supports refresh without forwarding tool arguments", () => {
    expect(pluginUiEventFromToolUse(toolUse(
      pluginUiEventToolName(target.pluginId, target.server, "refresh"),
      { surfaceId: "overview", anything: "discarded" },
    ), target)).toEqual({ surfaceId: "overview", eventName: "refresh", payload: {} });
  });

  it("rejects missing, non-object, or oversized event payloads", () => {
    const highlightName = pluginUiEventToolName(target.pluginId, target.server, "highlight");
    expect(pluginUiEventFromToolUse(toolUse(highlightName, { surfaceId: "overview" }), target)).toBeNull();
    expect(pluginUiEventFromToolUse(toolUse(highlightName, {
      surfaceId: "overview", payload: "row-1",
    }), target)).toBeNull();
    expect(pluginUiEventFromToolUse(toolUse(highlightName, {
      surfaceId: "overview", payload: { text: "x".repeat(9 * 1024) },
    }), target)).toBeNull();
  });

  it("requires an exact ready message for the current document token", () => {
    const token = "A".repeat(43);
    expect(isPluginAppGuestReady({
      channel: "duya.plugin-app", method: "ready", documentToken: token,
    }, token)).toBe(true);
    expect(isPluginAppGuestReady({
      channel: "duya.plugin-app", method: "ready", documentToken: "B".repeat(43),
    }, token)).toBe(false);
    expect(isPluginAppGuestReady({
      channel: "duya.plugin-app", method: "ready", documentToken: token, surfaceId: "overview",
    }, token)).toBe(false);
  });
});
