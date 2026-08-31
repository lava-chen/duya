// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { usePresetDraft } from "../usePresetDraft";
import type { QuickPreset } from "@/lib/provider-presets";

const anthropicPreset: QuickPreset = {
  key: "anthropic-official",
  name: "Anthropic",
  description: "Anthropic's official Claude API",
  descriptionZh: "Anthropic 官方 Claude API",
  protocol: "anthropic",
  provider_type: "anthropic",
  authStyle: "api_key",
  baseUrl: "https://api.anthropic.com",
  defaultEnvOverrides: {},
  defaultModels: [
    { modelId: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
  ],
  fields: ["api_key"],
  iconKey: "anthropic",
};

const ollamaPreset: QuickPreset = {
  key: "ollama",
  name: "Ollama",
  description: "Run models locally",
  descriptionZh: "本地运行模型",
  protocol: "ollama",
  provider_type: "ollama",
  authStyle: "env_only",
  baseUrl: "http://localhost:11434",
  defaultEnvOverrides: {},
  defaultModels: [{ modelId: "llama3.2", displayName: "Llama 3.2" }],
  fields: ["base_url"],
  iconKey: "ollama",
};

describe("usePresetDraft", () => {
  it("returns null draftLlmProvider when no preset is selected", () => {
    const { result } = renderHook(() => usePresetDraft());
    expect(result.current.selectedPreset).toBeNull();
    expect(result.current.draftLlmProvider).toBeNull();
    expect(result.current.isValid).toBe(true);
  });

  it("initializes a draft with preset defaults on selectPreset", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("my-anthropic"));
    act(() => result.current.selectPreset(anthropicPreset));
    expect(result.current.selectedPreset).toBe(anthropicPreset);
    expect(result.current.draftLlmProvider).not.toBeNull();
    expect(result.current.draftLlmProvider?.name).toBe("Anthropic");
    expect(result.current.draftLlmProvider?.apiFormat).toBe("anthropic");
    expect(result.current.draftLlmProvider?.category).toBe("official");
    expect(result.current.draftLlmProvider?.endpoints.baseUrl).toBe(
      "https://api.anthropic.com",
    );
  });

  it("uses api-key auth for anthropic, none for ollama", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("a"));
    act(() => result.current.selectPreset(anthropicPreset));
    expect(result.current.draftLlmProvider?.auth.type).toBe("api-key");

    act(() => result.current.selectPreset(ollamaPreset));
    expect(result.current.draftLlmProvider?.auth.type).toBe("none");
  });

  it("setName / setApiKey / setBaseUrl mutate the draft", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("a"));
    act(() => result.current.selectPreset(anthropicPreset));
    act(() => result.current.setName("Custom Anthropic"));
    act(() => result.current.setApiKey("sk-test-1234"));
    act(() => result.current.setBaseUrl("https://proxy.example.com"));
    expect(result.current.draftLlmProvider?.name).toBe("Custom Anthropic");
    expect(result.current.draftLlmProvider?.auth.apiKey).toBe("sk-test-1234");
    expect(result.current.draftLlmProvider?.endpoints.baseUrl).toBe(
      "https://proxy.example.com",
    );
  });

  it("validation marks draft invalid when apiKey is required but missing", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("a"));
    act(() => result.current.selectPreset(anthropicPreset));
    // Empty apiKey + api-key auth → invalid
    expect(result.current.draftLlmProvider?.auth.apiKey).toBeUndefined();
    expect(result.current.isValid).toBe(false);
    expect(result.current.validation.code).toBe("auth.missingApiKey");
  });

  it("validation marks draft valid when apiKey is set", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("a"));
    act(() => result.current.selectPreset(anthropicPreset));
    act(() => result.current.setApiKey("sk-test-1234"));
    expect(result.current.isValid).toBe(true);
  });

  it("ollama (auth: none) is valid without apiKey", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("o"));
    act(() => result.current.selectPreset(ollamaPreset));
    expect(result.current.isValid).toBe(true);
  });

  it("validation rejects invalid baseUrl", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("a"));
    act(() => result.current.selectPreset(anthropicPreset));
    act(() => result.current.setApiKey("sk-test-1234"));
    act(() => result.current.setBaseUrl("not-a-url"));
    expect(result.current.isValid).toBe(false);
    expect(result.current.validation.code).toBe("endpoint.invalidUrl");
  });

  it("applyUserInput sets multiple fields at once", () => {
    const { result } = renderHook(() => usePresetDraft());
    act(() => result.current.setProviderId("a"));
    act(() => result.current.selectPreset(anthropicPreset));
    act(() =>
      result.current.applyUserInput({
        name: "Bulk",
        apiKey: "sk-bulk",
        baseUrl: "https://api.bulk.example.com",
      }),
    );
    expect(result.current.draftLlmProvider?.name).toBe("Bulk");
    expect(result.current.draftLlmProvider?.auth.apiKey).toBe("sk-bulk");
    expect(result.current.draftLlmProvider?.endpoints.baseUrl).toBe(
      "https://api.bulk.example.com",
    );
  });
});
