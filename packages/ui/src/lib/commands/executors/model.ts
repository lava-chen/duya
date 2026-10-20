/**
 * Model/config executors: model / effort.
 *
 * `/model` mirrors the composer's own model picker (ModelProviderSelector):
 * no args opens the picker, an argument resolves against the same provider
 * catalog the picker renders and switches the session model directly.
 *
 * The catalog is rebuilt from `listProvidersIPC()` on every call — the same
 * layered fallback MessageInput.fetchModels uses (`options.enabled_models`
 * first, then `options.defaultModel`), because a slash command has no
 * access to the composer's React state and a stale cache would switch the
 * session to a model the user just removed.
 */

import type { CommandExecutorFn } from './registry';
import { listProvidersIPC } from '@/lib/ipc-client';
import { isKeylessLocalProvider } from '@/lib/providers';

interface CatalogEntry {
  /** Selector id the composer owns: `[Provider] model-id`. */
  prefixedId: string;
  /** `provider/model` form users may type instead of the bracketed prefix. */
  qualifiedId: string;
  providerId: string;
  providerName: string;
  modelId: string;
}

/** Layered per-provider model list — mirrors MessageInput.fetchModels. */
function enabledModelIds(optionsJson: string, defaultModel?: string): string[] {
  try {
    const opts = JSON.parse(optionsJson || '{}') as {
      enabled_models?: unknown;
      defaultModel?: unknown;
    };
    if (Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
      return opts.enabled_models.filter((m): m is string => typeof m === 'string');
    }
    if (typeof opts.defaultModel === 'string' && opts.defaultModel.length > 0) {
      return [opts.defaultModel];
    }
  } catch {
    // Malformed provider options — fall through to the typed defaultModel.
  }
  return typeof defaultModel === 'string' && defaultModel.length > 0 ? [defaultModel] : [];
}

async function loadModelCatalog(): Promise<CatalogEntry[]> {
  const providers = await listProvidersIPC();
  const entries: CatalogEntry[] = [];
  const seen = new Set<string>();
  for (const provider of providers ?? []) {
    // Skip providers without an API key, except keyless local runtimes
    // (Ollama / LM Studio) which the picker also surfaces.
    if (!provider.hasApiKey && !isKeylessLocalProvider(provider.providerType, provider.baseUrl)) {
      continue;
    }
    const providerName = provider.name || provider.providerType || provider.id;
    for (const raw of enabledModelIds(provider.options, provider.defaultModel)) {
      const modelId = raw.replace(/^"|"$/g, '');
      if (!modelId) continue;
      const prefixedId = `[${providerName}] ${modelId}`;
      if (seen.has(prefixedId)) continue;
      seen.add(prefixedId);
      entries.push({
        prefixedId,
        qualifiedId: `${providerName}/${modelId}`,
        providerId: provider.id,
        providerName,
        modelId,
      });
    }
  }
  return entries;
}

function norm(value: string): string {
  return value.trim().toLowerCase();
}

/** Keys a user may type for one entry, all compared case-insensitively. */
function keysOf(entry: CatalogEntry): string[] {
  return [entry.prefixedId, entry.qualifiedId, `${entry.providerId}/${entry.modelId}`, entry.modelId];
}

function scoreEntry(entry: CatalogEntry, query: string): number {
  const q = norm(query);
  if (!q) return 0;
  const model = norm(entry.modelId);
  const qualified = norm(entry.qualifiedId);
  const provider = norm(entry.providerName);
  if (model === q || qualified === q || model.startsWith(q)) return 5;
  if (model.includes(q) || qualified.includes(q)) return 3;
  if (provider.includes(q)) return 2;
  // Near-miss typo tolerance, scaled to the query length.
  const tolerance = Math.max(2, Math.floor(q.length / 3));
  if (levenshtein(model, q) <= tolerance) return 1;
  return 0;
}

function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length || !b.length) return a.length || b.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row[j] = Math.min(row[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    prev = row;
  }
  return prev[b.length];
}

/** Rank catalog entries by how close they look to `query`. */
function rankCandidates(entries: CatalogEntry[], query: string, limit = 6): CatalogEntry[] {
  return entries
    .map((entry) => ({ entry, score: scoreEntry(entry, query) }))
    .filter((c) => c.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((c) => c.entry);
}

function describeCandidates(candidates: CatalogEntry[]): string {
  return candidates.map((c) => `  ${c.prefixedId}`).join('\n');
}

/**
 * Resolve a `/model <arg>` query.
 *
 * Returns the single best hit, the set of equally-good hits (so the caller
 * can ask for `provider/model` instead of guessing), or null.
 */
function resolveModelQuery(
  query: string,
  entries: CatalogEntry[],
  currentModel?: string,
): { match?: CatalogEntry; ambiguous: CatalogEntry[] } {
  const q = norm(query);
  if (!q) return { ambiguous: [] };

  const direct = entries.filter((e) => keysOf(e).some((k) => norm(k) === q));
  if (direct.length === 1) return { match: direct[0], ambiguous: [] };
  if (direct.length > 1) {
    const match = preferCurrent(direct, currentModel);
    return match ? { match, ambiguous: [] } : { ambiguous: direct };
  }

  const scored = rankCandidates(entries, query, entries.length).filter(
    (e) => scoreEntry(e, query) >= 3,
  );
  if (scored.length === 1) return { match: scored[0], ambiguous: [] };
  if (scored.length > 1) {
    const match = preferCurrent(scored, currentModel);
    return match
      ? { match, ambiguous: [] }
      : { ambiguous: scored };
  }
  return { ambiguous: [] };
}

/** When several providers expose the same model id, keep the current one. */
function preferCurrent(
  candidates: CatalogEntry[],
  currentModel?: string,
): CatalogEntry | undefined {
  if (candidates.length <= 1) return candidates[0];
  if (currentModel) {
    const current = norm(currentModel);
    const hit = candidates.find(
      (e) => norm(e.prefixedId) === current || norm(e.modelId) === current,
    );
    if (hit) return hit;
  }
  return undefined;
}

export const MODEL_EXECUTORS: Record<string, CommandExecutorFn> = {
  /** `/model` → open the composer picker; `/model <name>` → switch directly. */
  model: async (ctx) => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/model: app bridge unavailable' };

    const query = ctx.args.join(' ').trim();
    if (!query) {
      app.openModelPicker();
      return { type: 'dismiss' };
    }

    let entries: CatalogEntry[];
    try {
      entries = await loadModelCatalog();
    } catch (error) {
      return {
        type: 'error',
        message: `/model: 读取服务商列表失败（${error instanceof Error ? error.message : String(error)}）`,
      };
    }

    if (entries.length === 0) {
      return {
        type: 'error',
        message: '/model: 没有可用模型。请先在 设置 → 服务商 中添加并启用模型。',
      };
    }

    const snapshot = app.getSessionSnapshot();
    const { match, ambiguous } = resolveModelQuery(query, entries, snapshot.model);

    if (match) {
      app.setSessionModel(match.prefixedId, match.providerId);
      return { type: 'text', content: `已切换模型：${match.prefixedId}` };
    }

    if (ambiguous.length > 1) {
      return {
        type: 'error',
        message: [
          `/model: "${query}" 在多个服务商下都存在，请用 provider/model 指定：`,
          describeCandidates(ambiguous),
        ].join('\n'),
      };
    }

    // No usable hit — surface near matches so the user can retry without
    // re-typing the whole provider/model pair.
    const similar = rankCandidates(entries, query);
    const lines = [`/model: 未找到匹配 "${query}" 的模型。`];
    lines.push(
      similar.length > 0
        ? '相近的候选：'
        : '可用模型（部分）：',
      describeCandidates(similar.length > 0 ? similar : entries.slice(0, 8)),
    );
    return { type: 'error', message: lines.join('\n') };
  },

  /**
   * NOT YET WIRED (out of scope for this pass): `/effort <level>` needs the
   * per-model `reasoningEffortOptions` list that only the composer's
   * capability lookup exposes, and the registry's level list
   * (none/minimal/low/medium/high) is not the same set for every model.
   * Until that list is reachable without the composer, `/effort` keeps
   * forwarding to the agent rather than silently switching to a level the
   * model may not support.
   */
  effort: (ctx) => ({ type: 'forward', prompt: ctx.raw }),
};
