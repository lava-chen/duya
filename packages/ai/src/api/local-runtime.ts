/**
 * packages/ai/src/api/local-runtime.ts
 *
 * Shared helpers for local-runtime (Ollama / LM Studio) compatibility
 * shims. Local OpenAI-compatible servers do not authenticate clients, but
 * the official OpenAI Node SDK (`openai` package) requires either an
 * `apiKey` constructor argument or the `OPENAI_API_KEY` env var at
 * construction time \u2014 otherwise it throws:
 *
 *   `Missing credentials. Please pass an 'apiKey', 'workloadIdentity',
 *    'adminAPIKey', or set the 'OPENAI_API_KEY' or 'OPENAI_ADMIN_KEY'
 *    environment variable.`
 *
 * For a local install the user has neither, so we synthesize a stable
 * placeholder here. The placeholder is NEVER sent to the server in any
 * meaningful way (LM Studio ignores the Bearer header, Ollama ignores
 * Authorization entirely) and is purely there to keep the SDK happy.
 *
 * Mirrors openclaw's `LMSTUDIO_LOCAL_API_KEY_PLACEHOLDER =
 * 'lmstudio-local'` convention from `extensions/lmstudio/src/api.ts`.
 * Duya's catalog also sets `envOverrides.OPENAI_API_KEY: 'lm-studio'`
 * on the LM Studio preset so SDK-proxy mode picks it up via the
 * normal env path; this helper covers the direct-SDK path.
 *
 * The constant is exported so callers can compare against it (e.g.
 * `if (apiKey === LM_STUDIO_PLACEHOLDER_KEY) skip validation`).
 */

export const LM_STUDIO_PLACEHOLDER_KEY = 'lmstudio-local';

/**
 * Returns `apiKey` if it's a non-empty string, otherwise the local-runtime
 * placeholder. Use at the boundary where the OpenAI SDK is constructed
 * \u2014 do NOT call this when forwarding the key to a remote provider
 * (the placeholder would leak into a real Authorization header).
 */
export function localRuntimeApiKeyOrPlaceholder(apiKey: string | undefined | null): string {
  if (typeof apiKey === 'string') {
    const trimmed = apiKey.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return LM_STUDIO_PLACEHOLDER_KEY;
}