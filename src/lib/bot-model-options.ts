/**
 * bot-model-options.ts — build provider-grouped model lists for the bot
 * create/edit dialogs.
 *
 * Extracts the provider → model grouping logic that BotComposer keeps inline
 * so both dialogs share one implementation (pure, node-testable). Only
 * providers with a usable key (or keyless local endpoints like Ollama) are
 * surfaced, mirroring the composer/MessageInput source of truth.
 */

import type { Provider } from '@/lib/ipc-client';
import { isKeylessLocalProvider } from '@/lib/providers';
import type { ProviderModelGroup, ModelOption } from '@/components/chat/ModelProviderSelector';

/** Strip a `[provider] ` prefix from a model id. */
export function prefixedToRaw(prefixedId: string): string {
  return prefixedId.replace(/^\[[^\]]+\]\s*/, '');
}

/** Find the group that exposes a raw model id (for edit-dialog prefill). */
export function findRawModelInGroups(
  rawModel: string,
  groups: ProviderModelGroup[],
): ProviderModelGroup | null {
  if (!rawModel) return null;
  return (
    groups.find((g) => g.models.some((m) => prefixedToRaw(m.id) === rawModel)) ??
    null
  );
}

/**
 * Derive the prefixed selector id for a configured raw model + provider id.
 * Prefers the configured provider; falls back to whichever group exposes the
 * raw model; when nothing matches (stale config) the raw id is returned so
 * the trigger still shows the configured name and saving without touching
 * the field preserves it.
 */
export function toSelectorModelId(
  rawModel: string,
  providerId: string | undefined,
  groups: ProviderModelGroup[],
): string {
  if (!rawModel) return '';
  const candidates = providerId
    ? [...groups.filter((g) => g.id === providerId), ...groups]
    : groups;
  for (const group of candidates) {
    const match = group.models.find((m) => prefixedToRaw(m.id) === rawModel);
    if (match) return match.id;
  }
  return rawModel;
}

/** Split a selector model id back into the raw model + provider id to persist. */
export function fromSelectorModelId(
  selectorModelId: string,
  groups: ProviderModelGroup[],
): { raw: string; providerId?: string } {
  if (!selectorModelId) return { raw: '' };
  const group = groups.find((g) => g.models.some((m) => m.id === selectorModelId));
  return { raw: prefixedToRaw(selectorModelId), providerId: group?.id };
}

/**
 * Group each provider's enabled models (from `options.enabled_models`, else
 * `options.defaultModel`) by provider. Providers without a usable key are
 * skipped. Model ids are prefixed `[${name}] ${id}` and deduplicated across
 * providers; `display_name` carries the bare model id.
 */
export function buildBotModelGroups(providers: Provider[]): ProviderModelGroup[] {
  const seen = new Set<string>();
  const groups: ProviderModelGroup[] = [];

  for (const provider of providers) {
    if (!provider.hasApiKey && !isKeylessLocalProvider(provider.providerType, provider.baseUrl)) {
      continue;
    }
    const name = provider.name || provider.providerType || provider.id;

    let enabledModels: string[] = [];
    try {
      const opts = JSON.parse(provider.options || '{}') as Record<string, unknown>;
      if (
        Array.isArray(opts.enabled_models) &&
        (opts.enabled_models as unknown[]).length > 0
      ) {
        enabledModels = opts.enabled_models as string[];
      } else if (
        typeof opts.defaultModel === 'string' &&
        opts.defaultModel.length > 0
      ) {
        enabledModels = [opts.defaultModel];
      }
    } catch {
      // Malformed options JSON — treat as having no enabled models.
    }

    const models: ModelOption[] = [];
    for (const id of enabledModels) {
      const cleanId =
        id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
      const prefixedId = `[${name}] ${cleanId}`;
      if (seen.has(prefixedId)) continue;
      seen.add(prefixedId);
      models.push({ id: prefixedId, display_name: cleanId });
    }
    if (models.length > 0) {
      groups.push({ id: provider.id, name, models });
    }
  }

  return groups;
}
