/**
 * src/components/settings/forms/hooks/useApiKeyState.ts
 *
 * L2 hook — concern: apiKey visibility + mask + user-intent state.
 *
 * Plan 209: refactored to a **3-state machine** to fix the
 * 2026-06 masked-key bug.
 *
 *   keyState === 'untouched'
 *     The user has not typed. The form is showing the server's mask
 *     (e.g. 'sk-a***cdef') as a hint. On save we MUST NOT pass the
 *     mask to the IPC layer — we pass `undefined` to mean "keep
 *     whatever is on disk".
 *
 *   keyState === 'replaced'
 *     The user typed a new value. `apiKey` holds the raw string. On
 *     save we pass `apiKey` verbatim.
 *
 *   keyState === 'cleared'
 *     The user explicitly cleared the field (e.g. via a "Remove" /
 *     "Clear" button). `apiKey` is `''` and `maskedApiKey` is also
 *     `''`. On save we pass `''` to mean "drop the credential
 *     entirely" (auth.type = 'none').
 *
 * Why the previous `hasUserApiKey: boolean` was wrong:
 * The `hasUserApiKey` flag was derived from `apiKey.length > 0`, so a
 * masked value (`'sk-a***cdef'`, length 11) was treated as "user input"
 * and persisted verbatim. The 3-state machine makes it impossible to
 * conflate "user typed" with "server has a key".
 */

import { useCallback, useState } from 'react';
import { isMaskedKey } from '@/lib/providers/secret';

export type ApiKeyStateValue = 'untouched' | 'replaced' | 'cleared';

export interface ApiKeyState {
  /** Raw user input. '' when untouched or cleared. */
  apiKey: string;
  /** Server-provided masked key. Preserved across edits so the UI can
   *  keep showing it as a hint. Cleared only when the user clears. */
  maskedApiKey: string;
  /** The current state. Drives the save contract. */
  keyState: ApiKeyStateValue;
  /** Reveal toggle. Affects the input's `type` attribute only. */
  revealApiKey: boolean;
  setApiKey: (next: string) => void;
  /** Mark the field as cleared. `apiKey` → '', `maskedApiKey` → '',
   *  `keyState` → 'cleared'. The save layer will then send ''. */
  clearApiKey: () => void;
  /** Replace the masked hint without touching the user-typed value.
   *  Use this when an async fetch returns a different masked
   *  representation. */
  setMasked: (masked: string) => void;
  toggleReveal: () => void;
}

export interface UseApiKeyStateInitial {
  /** Raw apiKey from the server (rarely used; usually masked). If this
   *  value is itself a mask, the hook will treat it as masked. */
  apiKey?: string;
  /** Explicit mask string (e.g. 'sk-a***cdef'). When provided, the
   *  hook starts in 'untouched' state. */
  masked?: string;
}

function deriveInitial(initial?: UseApiKeyStateInitial): {
  apiKey: string;
  maskedApiKey: string;
  keyState: ApiKeyStateValue;
} {
  const explicitMask = initial?.masked ?? '';
  if (explicitMask) {
    return { apiKey: '', maskedApiKey: explicitMask, keyState: 'untouched' };
  }
  const raw = initial?.apiKey ?? '';
  if (!raw) {
    return { apiKey: '', maskedApiKey: '', keyState: 'untouched' };
  }
  if (isMaskedKey(raw)) {
    return { apiKey: '', maskedApiKey: raw, keyState: 'untouched' };
  }
  return { apiKey: raw, maskedApiKey: '', keyState: 'replaced' };
}

export function useApiKeyState(initial?: UseApiKeyStateInitial): ApiKeyState {
  const seeded = deriveInitial(initial);

  const [apiKey, setApiKeyInternal] = useState<string>(seeded.apiKey);
  const [maskedApiKey, setMaskedApiKey] = useState<string>(seeded.maskedApiKey);
  const [keyState, setKeyState] = useState<ApiKeyStateValue>(seeded.keyState);
  const [revealApiKey, setRevealApiKey] = useState<boolean>(false);

  const setApiKey = useCallback((next: string) => {
    setApiKeyInternal(next);
    // Typing switches to 'replaced' regardless of whether the new value
    // happens to be a mask. The save contract deliberately does not
    // second-guess the user; the electron handler will reject the mask
    // and the user will see an error.
    setKeyState(next.length > 0 ? 'replaced' : 'untouched');
  }, []);

  const clearApiKey = useCallback(() => {
    setApiKeyInternal('');
    setMaskedApiKey('');
    setKeyState('cleared');
  }, []);

  const setMasked = useCallback((masked: string) => {
    setMaskedApiKey(masked);
  }, []);

  const toggleReveal = useCallback(() => {
    setRevealApiKey((v) => !v);
  }, []);

  return {
    apiKey,
    maskedApiKey,
    keyState,
    revealApiKey,
    setApiKey,
    clearApiKey,
    setMasked,
    toggleReveal,
  };
}
