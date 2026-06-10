/**
 * src/components/settings/forms/hooks/useBaseUrlState.ts
 *
 * L2 hook — concern: baseURL + endpoint candidates.
 *
 * Plan 203 Phase 2.2: a single source of truth for the
 * { userTyped, presetDefault, candidates, reset } triple that
 * the dialog uses to render the baseURL input + the "endpoint
 * candidates" chip list.
 *
 * Behavior:
 * - On first render, if `initial` is provided, it is treated as the
 *   user's value. If `preset` is provided, its `defaultBaseUrl` is
 *   the preset's default; the user can override it.
 * - `setBaseUrl` flips `hasUserBaseUrl` to true (the user has
 *   explicitly typed something) and stores the value.
 * - `resetToPresetDefault` clears the user's value and falls back
 *   to the preset's default.
 * - `candidates` is a passthrough from the preset's
 *   `endpointCandidates` (read-only).
 */

import { useCallback, useState } from 'react';

export interface BaseUrlPreset {
  defaultBaseUrl?: string;
  endpointCandidates?: string[];
}

export interface BaseUrlState {
  /** The currently displayed baseUrl. */
  baseUrl: string;
  /** True if the user explicitly typed a value. */
  hasUserBaseUrl: boolean;
  /** The preset's default baseUrl (read-only, may be empty). */
  presetDefault: string;
  /** The endpoint candidate list from the preset (read-only). */
  candidates: string[];
  setBaseUrl: (next: string) => void;
  resetToPresetDefault: () => void;
}

export function useBaseUrlState(
  initial?: { baseUrl?: string },
  preset?: BaseUrlPreset,
): BaseUrlState {
  const initialBaseUrl = initial?.baseUrl ?? '';
  const hasUserInitial = initialBaseUrl.length > 0;
  const presetDefault = preset?.defaultBaseUrl ?? '';

  const [baseUrl, setBaseUrlInternal] = useState<string>(initialBaseUrl);
  const [hasUserBaseUrl, setHasUserBaseUrl] = useState<boolean>(hasUserInitial);

  const setBaseUrl = useCallback(
    (next: string) => {
      setBaseUrlInternal(next);
      setHasUserBaseUrl(next.length > 0);
    },
    [],
  );

  const resetToPresetDefault = useCallback(() => {
    setBaseUrlInternal(presetDefault);
    setHasUserBaseUrl(false);
  }, [presetDefault]);

  return {
    baseUrl,
    hasUserBaseUrl,
    presetDefault,
    candidates: preset?.endpointCandidates ?? [],
    setBaseUrl,
    resetToPresetDefault,
  };
}
