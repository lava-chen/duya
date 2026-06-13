/**
 * src/lib/providers/canCheckQuota.ts
 *
 * Plan 204 Phase 4.1: shared predicate — "does this provider's vendor
 * expose a quota API the renderer can query today?"
 *
 * Single source of truth. Mirrors the heuristic in
 * `src/components/usage/ProviderQuotaView.tsx:21-33` and
 * `electron/services/network/provider-usage.ts#detectProvider`.
 * Update all three sites together when adding a new vendor.
 *
 * This is a **pure function** — no IPC, no React, no Electron.
 * It exists so that:
 *   - `ProviderActions` can render the per-card quota button as
 *     enabled / disabled without re-implementing the heuristic.
 *   - `ProviderQuotaView` (the actual quota UI) can filter to
 *     supported providers in one place.
 *   - Future plan (205+) can add a `canCheckQuota` field to a
 *     future `ProviderQuotabilityRegistry` and migrate all callers
 *     to read from it.
 */

/**
 * Returns true if the provider's vendor exposes a quota API the
 * renderer can query via `ProviderQuotaView` / electron's
 * `provider-usage` IPC.
 *
 * @param providerType The renderer DTO's `protocol` field (mirrors
 *   the legacy `providerType` enum: `minimax`, `minimax-cn`, `glm`,
 *   `glm-cn`, `openai`, `anthropic`, `ollama`, `openai-compatible`,
 *   `openrouter`, etc.).
 * @param baseUrl The renderer DTO's `baseUrl` field. Used as a
 *   fallback when `providerType` is missing or unrecognized.
 */
export function isQuotaSupported(
  providerType: string | undefined,
  baseUrl: string | undefined,
): boolean {
  const t = (providerType || '').toLowerCase();
  if (t === 'minimax' || t === 'minimax-cn') return true;
  if (t === 'glm' || t === 'glm-cn' || t === 'glm_cn') return true;

  const u = (baseUrl || '').toLowerCase();
  return (
    u.includes('minimax.io') ||
    u.includes('minimaxi.com') ||
    u.includes('bigmodel.cn') ||
    u.includes('z.ai')
  );
}
