/**
 * rules.ts — the pure Bot identity rules (framework plan S2).
 *
 * Everything here is pure so every writer agrees on one answer: how an agent
 * id is derived from a name, which ids are taken, which fields an upsert
 * preserves, how an identity patch applies, and how the canonical client view
 * merges the runtime profile over the config entry. The storage backend
 * differs — the Desktop writes through its in-memory config store, the Host
 * writes the TOML file directly — but the rules must not.
 *
 * The one deliberate change against the S1 Host code: `allocateBotId` takes
 * its collision suffix as an injected `randomSuffix` function instead of
 * calling `node:crypto` directly, so this package performs zero IO. The Host
 * adapter passes the crypto implementation; the application service threads
 * the choice through its ports.
 */

import type { BotRecord } from '@duya/agent-protocol/bot-api';
import { isSafeBotId } from './bot-id.js';
import type { AgentUpsertInput, BotIdentityEntry, BotUpdatePatch } from './identity.js';

/**
 * True iff `cfg` is in the soft-deleted state. The field is nullable because
 * a JSON round-trip restores `undefined` to `undefined` and `null` to `null`;
 * both mean "live".
 */
export function isSoftDeletedConfigAgent(cfg: BotIdentityEntry | undefined): boolean {
  return !!(cfg && typeof cfg.deleted_at === 'number' && cfg.deleted_at > 0);
}

/**
 * Derive a bot id candidate from a display name. The caller only supplies a
 * name, no id. Slug rules: lowercase, non-alphanumerics collapse to dashes,
 * and non-ASCII names (e.g. Chinese) fall back to the generic `bot` base.
 * Uniqueness itself is `allocateBotId`'s job.
 */
export function slugifyBotIdFromName(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  const base = slug.length >= 2 ? slug : 'bot';
  return /^[a-z0-9][a-z0-9-]*$/.test(base) ? base : 'bot';
}

/**
 * Merge an upsert input over the stored entry.
 *
 * The merge rules are the contract:
 *   - `name` / `description` / `model` / `workspace` / `agents_md` are replaced
 *     by the input (absent → cleared).
 *   - `provider` and `reasoning` only change when the caller carries them:
 *     a caller patching the name must not drop the provider binding.
 *   - `tools` / `plugins` only survive when the input carries a non-empty set.
 *   - `prompt` is hand-edited TOML config — the upsert input has no prompt
 *     surface, so the existing table is preserved.
 *   - the soft-delete fields are never carried over: an upsert is a live
 *     agent by definition.
 */
export function buildUpsertedAgent(
  existing: BotIdentityEntry | undefined,
  input: AgentUpsertInput,
): BotIdentityEntry {
  if (!input.name || !input.name.trim()) {
    throw new Error('agent name is required');
  }
  return {
    name: input.name.trim(),
    description: input.description?.trim() || undefined,
    model: input.model?.trim() || undefined,
    provider:
      input.provider !== undefined ? input.provider.trim() || undefined : existing?.provider,
    reasoning:
      input.reasoning !== undefined ? input.reasoning : existing?.reasoning,
    workspace: input.workspace?.trim() || undefined,
    agents_md: input.agents_md?.trim() || undefined,
    tools: input.tools && Object.keys(input.tools).length ? input.tools : undefined,
    plugins: input.plugins && input.plugins.length ? input.plugins : undefined,
    prompt: existing?.prompt,
  };
}

/**
 * Allocate a unique bot id. `desiredId` wins when free; otherwise
 * `<desiredId>-<suffix>` is retried until unique. The base is truncated to
 * 48 chars so the worst case (48 + dash + 6) stays inside the 63-char bot-id
 * limit.
 *
 * `randomSuffix` produces one collision suffix per attempt (6 lowercase hex
 * chars in the Host's crypto adapter — always inside the bot-id charset).
 * Injection keeps this module free of `node:crypto`.
 */
export function allocateBotId(
  desiredId: string,
  taken: ReadonlySet<string>,
  randomSuffix: () => string,
): string {
  if (!isSafeBotId(desiredId)) {
    throw new Error(
      `Invalid bot id '${desiredId}': must match /^[a-z0-9][a-z0-9-]{0,62}$/ (kebab-case, starts with a lowercase letter or digit, max 63 chars)`,
    );
  }
  if (!taken.has(desiredId)) return desiredId;
  const base = desiredId.slice(0, 48);
  for (let attempt = 0; attempt < 100; attempt++) {
    const candidate = `${base}-${randomSuffix()}`;
    if (!taken.has(candidate)) return candidate;
  }
  throw new Error(`could not allocate a unique bot id from '${desiredId}'`);
}

/**
 * Apply an identity patch with the legacy field semantics: a field changes
 * only when the patch carries a non-empty value for it, everything else
 * (`buildUpsertedAgent`'s preserve rules) rides unchanged, and the revision
 * is the facade's — the only revision authority.
 */
export function applyIdentityPatch(
  existing: BotIdentityEntry,
  patch: BotUpdatePatch,
  nextRevision: number,
): BotIdentityEntry {
  const next = buildUpsertedAgent(existing, {
    name: patch.name !== undefined && patch.name.trim() ? patch.name.trim() : existing.name ?? '',
    description:
      patch.description !== undefined && patch.description.trim()
        ? patch.description.trim()
        : existing.description,
    model: existing.model,
    workspace: existing.workspace,
    agents_md: existing.agents_md,
    tools: existing.tools,
    plugins: existing.plugins,
  });
  return { ...next, revision: nextRevision };
}

/**
 * The canonical view: profile.json first, config entry as fallback, id last.
 * Soft-deleted entries are invisible.
 */
export function canonicalBotRecord(
  id: string,
  entry: BotIdentityEntry | undefined,
  profile: { name: string; title: string; description: string } | null,
): BotRecord | null {
  if (entry === undefined || isSoftDeletedConfigAgent(entry)) return null;
  return {
    id,
    name: profile?.name || entry.name || id,
    title: profile?.title ?? '',
    description: profile?.description || entry.description || '',
    revision: entry.revision ?? 0,
  };
}
