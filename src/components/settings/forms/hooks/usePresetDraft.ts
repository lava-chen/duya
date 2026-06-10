/**
 * src/components/settings/forms/hooks/usePresetDraft.ts
 *
 * L2 hook — concern: preset selection → LlmProvider draft + validation.
 *
 * Plan 203 Phase 2.4: the single source of truth for translating a
 * user-selected `ProviderPreset` (or legacy `QuickPreset`) plus the
 * form values into a draft `LlmProvider` that the dialog can save.
 *
 * This is the ONLY hook in the form that knows how to construct an
 * `LlmProvider` from a preset + form values. It exposes:
 * - the selected preset
 * - the current draftLlmProvider (memoized; recomputed on any input change)
 * - setters for the four user-editable fields (preset, name, apiKey, baseUrl, options)
 * - `isValid` / `validation` from `validateProvider`
 *
 * Behavior:
 * - The first call to `selectPreset` initializes a draft from the
 *   preset's defaults.
 * - Each `setXxx` call updates the matching field on the draft.
 * - The draft is rebuilt every render; React renders are cheap.
 * - The hook does NOT perform the save itself; the dialog calls
 *   `draftLlmProvider` and passes it to the mutation hook.
 */

import { useCallback, useMemo, useState } from "react";
import {
  buildLlmProviderFromPreset,
  validateProvider,
  type LlmProvider,
  type ProviderPreset,
  type ValidationResult,
} from "@/lib/providers";
import type { QuickPreset } from "@/lib/provider-presets";
import { defaultApiKeyField } from "@/lib/providers/legacy";

/** User-facing form values that mutate the draft. */
export interface PresetDraftInput {
  name: string;
  apiKey?: string;
  baseUrl?: string;
  options?: Record<string, unknown>;
}

/** Returned hook surface. */
export interface PresetDraft {
  /** The currently selected preset, or null if none. */
  selectedPreset: ProviderPreset | QuickPreset | null;
  /** The current draft LlmProvider, derived from preset + user input. */
  draftLlmProvider: LlmProvider | null;
  /** Switch to a different preset; resets name/apiKey/baseUrl to preset defaults. */
  selectPreset: (preset: ProviderPreset | QuickPreset | null) => void;
  /** Set the provider id (assigned by parent when editing). */
  setProviderId: (id: string) => void;
  /** Update the user-editable name. */
  setName: (name: string) => void;
  /** Update the user-editable apiKey. */
  setApiKey: (apiKey: string) => void;
  /** Update the user-editable baseUrl. */
  setBaseUrl: (baseUrl: string) => void;
  /** Update the user-editable options. */
  setOptions: (options: Record<string, unknown>) => void;
  /** Apply multiple user input fields at once (used by the form's onChange handlers). */
  applyUserInput: (input: Partial<PresetDraftInput>) => void;
  /** Whether the current draft passes `validateProvider`. */
  isValid: boolean;
  /** The validation result. `ok: true` when isValid. */
  validation: ValidationResult;
}

const EMPTY_VALIDATION: ValidationResult = { ok: true };

/**
 * Build a draft LlmProvider from a legacy `QuickPreset` (the form's
 * current input shape) + user-edited values. This is a transitional
 * shim that lets the dialog drive the new domain shape without
 * rewriting the preset type.
 */
function buildDraftFromQuickPreset(
  preset: QuickPreset,
  providerId: string,
  input: PresetDraftInput,
  now: number,
): LlmProvider {
  // Map legacy protocol → ApiFormat, mirroring `inferApiFormatFromLegacyProviderType`.
  let apiFormat: LlmProvider["apiFormat"] = "openai-chat";
  switch (preset.protocol) {
    case "anthropic":
    case "bedrock":
    case "vertex":
      apiFormat = "anthropic";
      break;
    case "ollama":
      apiFormat = "ollama";
      break;
    case "gemini-image":
    case "openai-compatible":
    case "openrouter":
    case "google":
    default:
      apiFormat = "openai-chat";
      break;
  }

  // Map provider type to category (mirrors `inferCategoryFromLegacyProviderType`).
  let category: LlmProvider["category"] = "custom";
  if (preset.provider_type === "ollama") category = "local";
  else if (preset.provider_type === "openrouter") category = "aggregator";
  else if (
    preset.provider_type === "anthropic" ||
    preset.provider_type === "openai" ||
    preset.provider_type === "google" ||
    preset.provider_type === "bedrock" ||
    preset.provider_type === "vertex"
  ) {
    category = "official";
  }

  const baseUrl = (input.baseUrl ?? preset.baseUrl ?? "").trim();
  const isOllama = preset.provider_type === "ollama";

  return {
    id: providerId,
    name: input.name || preset.name,
    category,
    apiFormat,
    auth: isOllama
      ? { type: "none" }
      : {
          type: "api-key",
          apiKey: input.apiKey,
          apiKeyField: defaultApiKeyField(apiFormat),
        },
    endpoints: {
      baseUrl,
      isFullUrl: false,
    },
    ui: {},
    meta: {
      createdAt: now,
      updatedAt: now,
      sortIndex: 0,
    },
    options: input.options,
    extraEnv: preset.defaultEnvOverrides,
  };
}

export interface UsePresetDraftOptions {
  /** The initial preset (or null if not yet selected). */
  initialPreset?: ProviderPreset | QuickPreset | null;
  /** Initial provider id (used when editing an existing provider). */
  initialProviderId?: string;
  /** Optional seed for the user-editable name. */
  initialName?: string;
  /** Optional seed for the user-editable apiKey. */
  initialApiKey?: string;
  /** Optional seed for the user-editable baseUrl. */
  initialBaseUrl?: string;
  /** Optional seed for the user-editable options. */
  initialOptions?: Record<string, unknown>;
}

function isQuickPreset(
  p: ProviderPreset | QuickPreset,
): p is QuickPreset {
  // QuickPreset (legacy) exposes `provider_type`; ProviderPreset (new
  // domain) does not. The legacy `fields` array is also a tell.
  return "provider_type" in p && "fields" in p;
}

export function usePresetDraft(
  options: UsePresetDraftOptions = {},
): PresetDraft {
  const {
    initialPreset = null,
    initialProviderId = "",
    initialName = "",
    initialApiKey,
    initialBaseUrl,
    initialOptions,
  } = options;

  const [selectedPreset, setSelectedPreset] = useState<
    ProviderPreset | QuickPreset | null
  >(initialPreset);
  const [providerId, setProviderId] = useState<string>(initialProviderId);
  const [name, setName] = useState<string>(initialName);
  const [apiKey, setApiKey] = useState<string | undefined>(initialApiKey);
  const [baseUrl, setBaseUrl] = useState<string | undefined>(initialBaseUrl);
  const [options2, setOptions2] = useState<Record<string, unknown> | undefined>(
    initialOptions,
  );

  const selectPreset = useCallback(
    (preset: ProviderPreset | QuickPreset | null) => {
      setSelectedPreset(preset);
      if (preset) {
        setName(preset.name);
        setApiKey(undefined);
        setBaseUrl(isQuickPreset(preset) ? preset.baseUrl : preset.defaultEndpoint);
        setOptions2(undefined);
      } else {
        setName("");
        setApiKey(undefined);
        setBaseUrl(undefined);
        setOptions2(undefined);
      }
    },
    [],
  );

  const applyUserInput = useCallback((input: Partial<PresetDraftInput>) => {
    if (input.name !== undefined) setName(input.name);
    if (input.apiKey !== undefined) setApiKey(input.apiKey);
    if (input.baseUrl !== undefined) setBaseUrl(input.baseUrl);
    if (input.options !== undefined) setOptions2(input.options);
  }, []);

  const draftLlmProvider = useMemo<LlmProvider | null>(() => {
    if (!selectedPreset) return null;
    const now = Date.now();
    const input: PresetDraftInput = {
      name,
      apiKey,
      baseUrl,
      options: options2,
    };
    if (isQuickPreset(selectedPreset)) {
      return buildDraftFromQuickPreset(
        selectedPreset,
        providerId,
        input,
        now,
      );
    }
    return buildLlmProviderFromPreset(
      selectedPreset,
      {
        id: providerId,
        name: input.name,
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        options: input.options,
      },
      now,
    );
  }, [selectedPreset, providerId, name, apiKey, baseUrl, options2]);

  const validation = useMemo<ValidationResult>(() => {
    if (!draftLlmProvider) return EMPTY_VALIDATION;
    return validateProvider(draftLlmProvider);
  }, [draftLlmProvider]);

  return {
    selectedPreset,
    draftLlmProvider,
    selectPreset,
    setProviderId,
    setName,
    setApiKey,
    setBaseUrl,
    setOptions: setOptions2,
    applyUserInput,
    isValid: validation.ok,
    validation,
  };
}
