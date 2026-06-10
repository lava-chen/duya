/**
 * src/components/settings/forms/hooks/useApiKeyState.ts
 *
 * L2 hook — concern: apiKey visibility + mask.
 *
 * Plan 203 Phase 2.1: a single source of truth for the
 * { rawInput, masked-from-server, reveal toggle } triple that
 * `ProviderConnectDialog` and `SimpleProviderDialog` both manage
 * with ad-hoc `useState` clusters. Splitting this out lets the
 * dialog component focus on layout; the form hook owns the
 * "user typed something vs. server masked it" state machine.
 *
 * Behavior:
 * - On first render, if `initial.apiKey` is provided, it is treated
 *   as the user's raw input. If `initial.masked` is provided, it is
 *   the value the server sent down (e.g. "sk-a***cdef") and is
 *   preserved verbatim until the user types.
 * - The first `setApiKey` call clears `maskedApiKey` because the
 *   user is now editing the value.
 * - `toggleReveal` flips the reveal toggle. The actual rendering
 *   decides whether to display `apiKey` or `maskedApiKey` based
 *   on this flag.
 */

import { useCallback, useState } from 'react';

export interface ApiKeyState {
  /** Raw user input. Empty string when the user has not typed. */
  apiKey: string;
  /** True if the user typed something (vs. only the server's mask is shown). */
  hasUserApiKey: boolean;
  /** The server-provided masked key, preserved until the user types. */
  maskedApiKey: string;
  /** Reveal toggle. When true, render `apiKey` if user typed, else `maskedApiKey`. */
  revealApiKey: boolean;
  setApiKey: (next: string) => void;
  toggleReveal: () => void;
}

export interface UseApiKeyStateInitial {
  /** Raw apiKey from the server (rarely used; usually masked). */
  apiKey?: string;
  /** Masked apiKey from the server (e.g. "sk-a***cdef"). */
  masked?: string;
}

export function useApiKeyState(
  initial?: UseApiKeyStateInitial,
): ApiKeyState {
  const initialApiKey = initial?.apiKey ?? '';
  const initialMasked = initial?.masked ?? '';

  const [apiKey, setApiKeyInternal] = useState<string>(initialApiKey);
  const [maskedApiKey, setMaskedApiKey] = useState<string>(initialMasked);
  const [revealApiKey, setRevealApiKey] = useState<boolean>(false);

  const setApiKey = useCallback((next: string) => {
    // The first user edit clears the server-provided mask; we are
    // now storing the user's raw input verbatim.
    setMaskedApiKey('');
    setApiKeyInternal(next);
  }, []);

  const toggleReveal = useCallback(() => {
    setRevealApiKey((v) => !v);
  }, []);

  return {
    apiKey,
    hasUserApiKey: apiKey.length > 0,
    maskedApiKey,
    revealApiKey,
    setApiKey,
    toggleReveal,
  };
}
