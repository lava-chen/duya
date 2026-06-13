/**
 * src/lib/providers/secret.ts
 *
 * Plan 209: shared secret-detection helpers used by both the renderer
 * (`useApiKeyState`, `useProviderEditSave`) and the electron main
 * (`provider-store`, `provider-ipc-handlers`).
 *
 * The single source of truth for "does this string look like a masked
 * placeholder (e.g. `sk-a***cdef`) or a real key?". Keeping it here
 * prevents drift between the two processes.
 *
 * Why this matters: in 2026-06 we shipped a bug where the renderer
 * displayed a masked value in the API key input, the user saved
 * without retyping, and the mask was persisted to `config/settings.json`
 * — destroying the real credential. This module is the foundation
 * for the fix.
 */

const MASK_PATTERN = /\*{3,}/;
const ALL_STARS_PATTERN = /^\*+$/;

export function isMaskedKey(value: string | undefined | null): boolean {
  if (!value) return false;
  if (ALL_STARS_PATTERN.test(value)) return true;
  return MASK_PATTERN.test(value);
}

/**
 * Best-effort "is this plausibly a real key?" heuristic. We keep it
 * conservative: anything containing mask characters is rejected, and
 * the value must reach a minimum length to count as a real secret.
 * The threshold (8) is a stand-in; we deliberately err on the side
 * of "treat short strings as suspicious" because the on-disk keys
 * duya manages are all 20+ chars in practice.
 */
export function isLikelyRealApiKey(value: string | undefined | null): boolean {
  if (!value) return false;
  if (isMaskedKey(value)) return false;
  return value.length >= 8;
}
