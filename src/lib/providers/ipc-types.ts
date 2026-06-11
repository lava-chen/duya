/**
 * src/lib/providers/ipc-types.ts
 *
 * Canonical IPC DTO for the LLM provider architecture (renderer-side).
 *
 * Design contract:
 * - `RendererLlmProviderDTO` is the ONLY shape the renderer component tree
 *   consumes. It is a stable projection of the new `LlmProvider` domain
 *   entity (`src/lib/providers/types.ts`).
 * - The renderer MUST NOT import the legacy `MaskedApiProvider` or the
 *   `BackendProvider` (`src/lib/ipc-client.ts`) shapes directly. All
 *   projection goes through `toRendererLlmProviderDTO()`.
 * - Secrets are NEVER included in the DTO. `apiKey` is masked (e.g.
 *   `sk-a***cdef`); `accessToken` is stripped entirely.
 * - The `legacy` block captures the legacy `providerType` string used by
 *   the IPC layer so consumers (e.g. `ProviderList`, `ProviderCard`)
 *   can stay on the new shape while the IPC layer still speaks the
 *   legacy enum.
 *
 * Migration plan: this DTO is the foundation for Plan 203 (Provider UI
 * Interaction Architecture). It is the bridge between the LlmProvider
 * domain refactor (Phase 1+2+3, already on master) and the renderer-side
 * React Query hooks introduced in Plan 203 Phase 1+.
 */

import type {
  ApiProvider,
  LlmProvider,
  MaskedApiProvider,
  ProviderCategory,
} from './types';
import {
  inferApiFormatFromLegacyProviderType,
  inferCategoryFromLegacyProviderType,
  defaultApiKeyField,
} from './legacy';

/**
 * The legacy IPC DTO shape emitted by
 * `electron/agents/agent-communicator.ts:maskProvider`. We mirror
 * it here so `toRendererLlmProviderDTO` can detect the legacy shape
 * via `'apiFormat' in input` and project it on the fly.
 *
 * This is the SAME shape `src/lib/ipc-client.ts:BackendProvider`
 * declares. It is duplicated here on purpose: the renderer
 * component tree must not depend on the IPC client just to know the
 * shape. Plan 205 will collapse this duplication when the IPC
 * layer emits the canonical `LlmProvider` shape.
 */
export interface BackendProvider {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  isActive: boolean;
  hasApiKey: boolean;
  sortOrder: number;
  extraEnv: string;
  protocol: string;
  headers: string;
  options: string;
  notes: string;
  createdAt: number;
  updatedAt: number;
}

/** Best-effort projection from the legacy IPC DTO back to an
 *  `LlmProvider`. Used only as a fallback inside
 *  `toRendererLlmProviderDTO` when the IPC layer still emits the
 *  legacy shape. The result is intentionally a "best guess" — when
 *  the IPC layer migrates to emit a real `LlmProvider`, this
 *  fallback is no longer exercised. */
function legacyBackendToLlm(b: BackendProvider): LlmProvider {
  // Parse the JSON-encoded fields. If they fail to parse, treat as empty.
  const parse = (s: string): Record<string, unknown> => {
    try {
      const v = JSON.parse(s);
      return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };

  // Map the legacy providerType back to the modern apiFormat/category.
  const legacyType = b.providerType as ApiProvider['providerType'];
  const apiFormat = inferApiFormatFromLegacyProviderType(legacyType);
  const category = inferCategoryFromLegacyProviderType(legacyType, b.baseUrl);

  // Reconstruct a sensible auth. Legacy only carried apiKey; we
  // back-derive the auth type. The masked key on the wire is fine
  // to keep here — we re-mask on the way out.
  const authType: LlmProvider['auth']['type'] = apiFormat === 'ollama' ? 'none' : 'api-key';

  const tags: string[] = [];
  if (b.isActive) tags.push('active');

  return {
    id: b.id,
    name: b.name,
    category,
    apiFormat,
    auth: {
      type: authType,
      apiKeyField: defaultApiKeyField(apiFormat),
      // The wire already masks the key; `maskApiKeyForRenderer` is
      // idempotent on an already-masked key (the first 4 + *** +
      // last 4 are stable through the round-trip), so re-masking
      // here is a no-op.
      apiKey: b.apiKey,
    },
    endpoints: { baseUrl: b.baseUrl, isFullUrl: false },
    ui: {},
    meta: {
      createdAt: b.createdAt,
      updatedAt: b.updatedAt,
      sortIndex: b.sortOrder,
      notes: b.notes,
      tags: tags.length > 0 ? tags : undefined,
    },
    headers: parse(b.headers) as Record<string, string>,
    options: parse(b.options),
    extraEnv: parse(b.extraEnv) as Record<string, string>,
  };
}

/**
 * The canonical, renderer-safe projection of an `LlmProvider`.
 *
 * Differs from `LlmProvider` in three ways:
 * 1. `auth` is flattened to a single masked `apiKey` string + `hasApiKey` boolean.
 * 2. `endpoints` is flattened to a single `baseUrl` string.
 * 3. `meta` is flattened into top-level `sortOrder`, `isDefault`,
 *    `createdAt`, `updatedAt`, `notes` scalars.
 * 4. `extraEnv` / `headers` / `options` (Record) are JSON-stringified so
 *    they survive the IPC bridge without losing object identity.
 */
export interface RendererLlmProviderDTO {
  // Identity (from LlmProvider)
  id: string;
  name: string;
  category: ProviderCategory;
  apiFormat: LlmProvider['apiFormat'];

  // Flattened auth
  apiKey: string;          // masked, e.g. "sk-a***cdef" or "" when no key
  hasApiKey: boolean;

  // Flattened endpoints
  baseUrl: string;

  // Flattened meta
  sortOrder: number;
  /** True when this provider is the user's soft default (implicit
   *  fallback for chat/vision/etc). Multiple providers can coexist;
   *  this only flags the implicit default. */
  isDefault: boolean;
  /** @deprecated Use isDefault. The single-active concept is gone;
   *  retained as a backward-compat alias for one release. */
  isActive?: boolean;
  notes: string;
  createdAt: number;
  updatedAt: number;

  // JSON-encoded structured fields (preserved for round-trip)
  extraEnv: string;
  headers: string;
  options: string;

  // Display / protocol hint
  protocol: string;        // legacy providerType (see `legacy` block)

  // Legacy IPC compatibility block — captures the providerType enum
  // that the legacy IPC layer still speaks. Components that need to
  // dispatch on protocol should branch on this enum, not on
  // `apiFormat` + `category` directly.
  legacy: {
    providerType: ApiProvider['providerType'];
    providerTypeMapping: 'direct' | 'fallback';
  };
}

/** Stable mask used for the renderer DTO. Mirrors `legacy.ts:maskApiProvider`
 *  and `electron/agents/agent-communicator.ts:maskProvider` so the three
 *  stay in sync. */
export function maskApiKeyForRenderer(raw: string | undefined | null): string {
  if (!raw) return '';
  if (raw.length <= 8) return '***';
  return raw.slice(0, 4) + '***' + raw.slice(-4);
}

/** JSON-encode a record for IPC transport. Tolerates undefined / null. */
export function jsonEncode(value: Record<string, unknown> | undefined | null): string {
  if (!value) return '{}';
  try {
    return JSON.stringify(value);
  } catch {
    return '{}';
  }
}

/** Inverse: decode a JSON-encoded DTO field back to a record. Tolerant of
 *  parse failures (returns `{}`). */
export function jsonDecode(value: string | undefined | null): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* fall through */
  }
  return {};
}

/**
 * Derive the legacy `providerType` from the new `apiFormat` + `category` + `baseUrl`.
 *
 * This is the SAME derivation `legacy.ts:providerToLegacyProtocol()` uses, but
 * inlined here so `toRendererLlmProviderDTO` has zero cross-module deps on
 * private helpers. The mapping is intentionally kept in lockstep with
 * `legacy.ts`.
 */
export function deriveLegacyProviderType(
  apiFormat: LlmProvider['apiFormat'],
  category: ProviderCategory,
  baseUrl: string,
): ApiProvider['providerType'] {
  switch (apiFormat) {
    case 'anthropic':
      return 'anthropic';
    case 'ollama':
      return 'ollama';
    case 'openai-chat':
    case 'openai-responses': {
      if (category === 'aggregator') return 'openrouter';
      if (category === 'official') {
        const url = baseUrl.toLowerCase();
        if (url.includes('api.openai.com')) return 'openai';
        if (url.includes('googleapis') || url.includes('google')) return 'google';
        return 'openai';
      }
      return 'openai-compatible';
    }
    case 'gemini':
      return 'google';
    case 'bedrock':
      return 'bedrock';
    case 'vertex':
      return 'vertex';
    default:
      return 'openai-compatible';
  }
}

/**
 * Project an `LlmProvider` to the renderer DTO.
 *
 * Deterministic: the same input always yields the same output. The
 * `now` parameter is only used for the `createdAt` / `updatedAt` fields
 * when the source `LlmProvider.meta` is missing timestamps.
 *
 * **Backward compatibility**: this function also accepts the legacy
 * `BackendProvider` shape (the IPC DTO emitted by
 * `electron/agents/agent-communicator.ts:maskProvider`) as a
 * defensive fallback. When passed a `BackendProvider`, the function
 * infers the equivalent `LlmProvider` projection and produces a
 * renderer DTO. This keeps Phase 1+ consumers working even when the
 * IPC layer still emits the legacy shape. When the IPC layer
 * migrates to emit a real `LlmProvider`, the legacy branch becomes
 * a no-op.
 */
export function toRendererLlmProviderDTO(
  input: LlmProvider | BackendProvider,
  opts: { defaultProviderId?: string | null; now?: number } = {},
): RendererLlmProviderDTO {
  const { defaultProviderId = null, now = Date.now() } = opts;
  const llm: LlmProvider =
    'apiFormat' in input
      ? input
      : legacyBackendToLlm(input as BackendProvider);
  const apiKey = maskApiKeyForRenderer(llm.auth.apiKey);
  const hasApiKey = !!llm.auth.apiKey && llm.auth.apiKey.length > 0;
  const baseUrl = llm.endpoints?.baseUrl ?? '';
  const providerType = deriveLegacyProviderType(
    llm.apiFormat,
    llm.category,
    baseUrl,
  );
  const createdAt = llm.meta?.createdAt ?? now;
  const updatedAt = llm.meta?.updatedAt ?? now;
  // `isDefault` is derived from the explicit `defaultProviderId` argument.
  // We also fall back to the legacy `'active'` tag so DTO consumers keep
  // working during the migration window (the main-side store writes the
  // tag in sync with `defaultId`).
  const isDefault =
    (defaultProviderId != null && llm.id === defaultProviderId) ||
    llm.meta?.tags?.includes('active') === true;

  return {
    id: llm.id,
    name: llm.name,
    category: llm.category,
    apiFormat: llm.apiFormat,
    apiKey,
    hasApiKey,
    baseUrl,
    sortOrder: llm.meta?.sortIndex ?? 0,
    isDefault,
    // Backward-compat: emit `isActive` as an alias for `isDefault`.
    isActive: isDefault,
    notes: llm.meta?.notes ?? '',
    createdAt,
    updatedAt,
    extraEnv: jsonEncode(llm.extraEnv),
    headers: jsonEncode(llm.headers),
    options: jsonEncode(llm.options),
    protocol: providerType,
    legacy: {
      providerType,
      // `direct` when the mapping was a clean protocol → apiFormat
      // conversion; `fallback` when the mapping went through the
      // `openai-compatible` default. Currently we only emit `direct`,
      // but the field is kept to mirror `inferApiFormatFromLegacyProviderType`.
      providerTypeMapping: 'direct',
    },
  };
}

/**
 * Re-export the legacy migration helpers so consumers of `ipc-types.ts`
 * can derive `apiFormat` / `category` from a legacy `providerType` enum
 * without reaching into `legacy.ts` directly.
 */
export {
  inferApiFormatFromLegacyProviderType,
  inferCategoryFromLegacyProviderType,
};

/**
 * Structural check that a `MaskedApiProvider` is compatible with a
 * `RendererLlmProviderDTO`. Used by the renderer-dto wire smoke test
 * (Plan 203 Phase 0.2) to catch drift between the legacy IPC mask
 * (`electron/agents/agent-communicator.ts:maskProvider`) and the new
 * canonical projection.
 *
 * The two shapes are NOT identical — the DTO adds `category`,
 * `apiFormat`, and `legacy`. But the legacy fields (`providerType`,
 * `baseUrl`, `apiKey`, `isActive`, `hasApiKey`, `sortOrder`,
 * `extraEnv`, `headers`, `options`, `notes`, `createdAt`, `updatedAt`,
 * `protocol`) must match.
 */
export function assertMaskedApiProviderCompatible(
  dto: RendererLlmProviderDTO,
  masked: MaskedApiProvider,
): void {
  // The DTO carries the legacy providerType under `legacy.providerType`
  // and `protocol` (the latter is the same string for renderer
  // consumers). The MaskedApiProvider carries it as a top-level
  // `providerType` field. Map accordingly.
  const dtoProviderType = dto.legacy.providerType;
  const expectedPairs: Array<[keyof MaskedApiProvider, unknown, unknown]> = [
    ['id', dto.id, masked.id],
    ['name', dto.name, masked.name],
    ['providerType', dtoProviderType, masked.providerType],
    ['baseUrl', dto.baseUrl, masked.baseUrl],
    ['apiKey', dto.apiKey, masked.apiKey],
    ['isActive', dto.isActive, masked.isActive],
    ['hasApiKey', dto.hasApiKey, masked.hasApiKey],
    ['sortOrder', dto.sortOrder, masked.sortOrder],
    ['extraEnv', dto.extraEnv, masked.extraEnv],
    ['protocol', dto.protocol, masked.protocol],
    ['headers', dto.headers, masked.headers],
    ['options', dto.options, masked.options],
    ['notes', dto.notes, masked.notes],
    ['createdAt', dto.createdAt, masked.createdAt],
    ['updatedAt', dto.updatedAt, masked.updatedAt],
  ];
  for (const [key, dtoValue, maskedValue] of expectedPairs) {
    if (dtoValue !== maskedValue) {
      throw new Error(
        `RendererLlmProviderDTO / MaskedApiProvider drift on field "${String(key)}": ` +
          `dto=${String(dtoValue)} ` +
          `masked=${String(maskedValue)}`,
      );
    }
  }
}
