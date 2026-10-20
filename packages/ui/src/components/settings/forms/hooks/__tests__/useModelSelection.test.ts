// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useModelSelection } from "../useModelSelection";

describe("useModelSelection", () => {
  it("initializes enabledModels from initialEnabled", () => {
    const { result } = renderHook(() =>
      useModelSelection({ initialEnabled: ["a", "b"] }),
    );
    expect(result.current.enabledModels.has("a")).toBe(true);
    expect(result.current.enabledModels.has("b")).toBe(true);
    expect(result.current.enabledModels.has("c")).toBe(false);
  });

  it("toggleModel adds then removes", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.toggleModel("x"));
    expect(result.current.isEnabled("x")).toBe(true);
    act(() => result.current.toggleModel("x"));
    expect(result.current.isEnabled("x")).toBe(false);
  });

  it("addCustomModel adds to enabled set + customModels list", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.addCustomModel("custom-1"));
    expect(result.current.isEnabled("custom-1")).toBe(true);
    expect(result.current.customModels).toContain("custom-1");
  });

  it("addCustomModel ignores empty / duplicate", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.addCustomModel("  "));
    expect(result.current.customModels).toEqual([]);
    act(() => result.current.addCustomModel("dup"));
    act(() => result.current.addCustomModel("dup"));
    expect(result.current.customModels.filter((m) => m === "dup")).toHaveLength(1);
  });

  it("removeCustomModel removes from both lists", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.addCustomModel("x"));
    act(() => result.current.removeCustomModel("x"));
    expect(result.current.isEnabled("x")).toBe(false);
    expect(result.current.customModels).not.toContain("x");
  });

  it("setContextWindow stores the override", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.setContextWindow("claude", 200_000));
    expect(result.current.modelCapabilities.get("claude")).toBe(200_000);
  });

  it("context window editor accepts 1M tokens", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.beginEditContext("big", undefined));
    act(() => result.current.setEditingCtxValue("1000000"));
    act(() => result.current.commitEditContext());
    expect(result.current.modelCapabilities.get("big")).toBe(1_000_000);
  });

  it("commitEditContext ignores non-positive integers", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.beginEditContext("x", 100));
    act(() => result.current.setEditingCtxValue("0"));
    act(() => result.current.commitEditContext());
    expect(result.current.modelCapabilities.get("x")).toBeUndefined();
    expect(result.current.editingCtxFor).toBeNull();
  });

  it("commitEditContext ignores NaN", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.beginEditContext("x", 100));
    act(() => result.current.setEditingCtxValue("abc"));
    act(() => result.current.commitEditContext());
    expect(result.current.modelCapabilities.get("x")).toBeUndefined();
  });

  it("cancelEditContext clears the edit state without writing", () => {
    const { result } = renderHook(() => useModelSelection());
    act(() => result.current.beginEditContext("x", 100));
    act(() => result.current.setEditingCtxValue("999"));
    act(() => result.current.cancelEditContext());
    expect(result.current.editingCtxFor).toBeNull();
    expect(result.current.editingCtxValue).toBe("");
    expect(result.current.modelCapabilities.get("x")).toBeUndefined();
  });

  it("setEnabledFromProp replaces the enabled set", () => {
    const { result } = renderHook(() =>
      useModelSelection({ initialEnabled: ["a"] }),
    );
    act(() => result.current.setEnabledFromProp(["b", "c"]));
    expect(result.current.isEnabled("a")).toBe(false);
    expect(result.current.isEnabled("b")).toBe(true);
    expect(result.current.isEnabled("c")).toBe(true);
  });
});
