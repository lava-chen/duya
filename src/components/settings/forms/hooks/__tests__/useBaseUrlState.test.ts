// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { useBaseUrlState } from "../useBaseUrlState";

describe("useBaseUrlState", () => {
  it("returns empty state when no initial / preset provided", () => {
    const { result } = renderHook(() => useBaseUrlState());
    expect(result.current.baseUrl).toBe("");
    expect(result.current.hasUserBaseUrl).toBe(false);
    expect(result.current.presetDefault).toBe("");
    expect(result.current.candidates).toEqual([]);
  });

  it("initial baseUrl marks hasUserBaseUrl = true", () => {
    const { result } = renderHook(() =>
      useBaseUrlState({ baseUrl: "https://api.example.com" }),
    );
    expect(result.current.baseUrl).toBe("https://api.example.com");
    expect(result.current.hasUserBaseUrl).toBe(true);
  });

  it("setBaseUrl flips hasUserBaseUrl based on non-empty input", () => {
    const { result } = renderHook(() =>
      useBaseUrlState({ baseUrl: "https://initial" }),
    );
    act(() => result.current.setBaseUrl("https://user-typed"));
    expect(result.current.baseUrl).toBe("https://user-typed");
    expect(result.current.hasUserBaseUrl).toBe(true);
    act(() => result.current.setBaseUrl(""));
    expect(result.current.hasUserBaseUrl).toBe(false);
  });

  it("resetToPresetDefault clears the user override", () => {
    const preset = { defaultBaseUrl: "https://preset-default" };
    const { result } = renderHook(() =>
      useBaseUrlState({ baseUrl: "https://user" }, preset),
    );
    expect(result.current.presetDefault).toBe("https://preset-default");
    act(() => result.current.resetToPresetDefault());
    expect(result.current.baseUrl).toBe("https://preset-default");
    expect(result.current.hasUserBaseUrl).toBe(false);
  });

  it("exposes endpointCandidates from preset", () => {
    const preset = {
      defaultBaseUrl: "https://default",
      endpointCandidates: ["https://a", "https://b"],
    };
    const { result } = renderHook(() => useBaseUrlState({}, preset));
    expect(result.current.candidates).toEqual(["https://a", "https://b"]);
  });
});
