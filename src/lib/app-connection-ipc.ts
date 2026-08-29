/**
 * App Connection IPC client — Renderer-side wrapper.
 *
 * Plan 312 Phase 2. Mirrors the shape of `src/lib/plugin-ipc.ts`:
 *   - thin wrapper over `window.electronAPI.appConnection`
 *   - returns the same DTO envelope the IPC handlers return
 *   - never touches token fields (they don't exist on the DTO)
 *
 * The `AppConnectionStatusDTO` is re-exported so renderer components
 * can stay type-safe without importing from `electron/services`.
 */

import type {
  AppConnectionProviderDTO,
  AppConnectionStatusDTO,
  ProviderId,
} from '../../electron/services/app-connections/types';

export type { AppConnectionStatusDTO } from '../../electron/services/app-connections/types';
export type { AppConnectionProviderDTO } from '../../electron/services/app-connections/types';

export type { ProviderId, AppConnectionStatus } from '../../electron/services/app-connections/types';

export interface AppConnectionListResponse {
  success: boolean;
  data?: AppConnectionStatusDTO[];
  error?: string;
}

export interface AppConnectionSingleResponse {
  success: boolean;
  data?: AppConnectionStatusDTO;
  error?: string;
  errorCode?: string;
}

export interface AppConnectionProviderListResponse {
  success: boolean;
  data?: AppConnectionProviderDTO[];
  error?: string;
}

export interface AppConnectionProviderResponse {
  success: boolean;
  data?: AppConnectionProviderDTO;
  error?: string;
  errorCode?: string;
}

export interface AppConnectionDisconnectResponse {
  success: boolean;
  data?: { disconnected: boolean };
  error?: string;
}

export function getAppConnectionAPI() {
  const api = window.electronAPI;
  if (!api) {
    return null;
  }
  return {
    list: async (): Promise<AppConnectionListResponse> => {
      return api.appConnection.list() as Promise<AppConnectionListResponse>;
    },
    providers: async (): Promise<AppConnectionProviderListResponse> => {
      return api.appConnection.providers() as Promise<AppConnectionProviderListResponse>;
    },
    status: async (connectionId: string): Promise<AppConnectionSingleResponse> => {
      return api.appConnection.status(connectionId) as Promise<AppConnectionSingleResponse>;
    },
    connect: async (payload: {
      provider: ProviderId;
      scopes?: string[];
    }): Promise<AppConnectionSingleResponse> => {
      return api.appConnection.connect(payload) as Promise<AppConnectionSingleResponse>;
    },
    configureProvider: async (payload: {
      provider: ProviderId;
      clientId: string;
      clientSecret?: string;
    }): Promise<AppConnectionProviderResponse> => {
      return api.appConnection.configureProvider(payload) as Promise<AppConnectionProviderResponse>;
    },
    disconnect: async (connectionId: string): Promise<AppConnectionDisconnectResponse> => {
      return api.appConnection.disconnect(connectionId) as Promise<AppConnectionDisconnectResponse>;
    },
    approveTool: async (provider: string, toolAlias: string): Promise<{ success: boolean; error?: string }> => {
      return api.appConnection.approveTool(provider, toolAlias);
    },
    revokeToolApproval: async (provider: string, toolAlias: string): Promise<{ success: boolean; error?: string }> => {
      return api.appConnection.revokeToolApproval(provider, toolAlias);
    },
    listToolApprovals: async (): Promise<{ success: boolean; data?: string[]; error?: string }> => {
      return api.appConnection.listToolApprovals();
    },
  };
}

/** Result of {@link rewriteAppMentionTokens}. */
export interface AppMentionRewrite {
  /** Content with bare `@id`/`@label` tokens replaced by `[@label](app://id)` links. */
  content: string;
  /** Provider ids mentioned (already-linked or rewritten), first-seen order. */
  mentionedProviders: string[];
}

/**
 * Plan 450 Phase G: rewrite bare `@<provider>` composer tokens into codex-style
 * structured links before the message reaches the model — `@notion` becomes
 * `[@Notion](app://notion)`.
 *
 * Codex parity (`core/src/plugins/mentions.rs` + `tui/src/mention_codec.rs`):
 * the model sees a resolvable `app://` reference instead of a bare word that
 * could collide with prose, and history replay can recover the binding from
 * the link alone. The renderer keeps showing the original text via
 * `displayContent`, so the composer UX is unchanged.
 *
 * Idempotent: existing `[@label](app://id)` links are recognized, validated
 * against `availableProviders`, and never rewritten twice. Only providers in
 * `availableProviders` are rewritten or counted — unknown `@word` tokens pass
 * through untouched (fail-open for prose like "email me @home").
 */
export function rewriteAppMentionTokens(
  content: string,
  availableProviders: Array<{ id: string; label?: string }>,
): AppMentionRewrite {
  if (!content || !content.includes('@') || availableProviders.length === 0) {
    return { content, mentionedProviders: [] };
  }

  const byIdOrLabel = new Map<string, { id: string; label: string }>();
  for (const p of availableProviders) {
    if (!p.id) continue;
    const label = p.label?.trim() || p.id;
    byIdOrLabel.set(p.id.toLowerCase(), { id: p.id, label });
    if (p.label) byIdOrLabel.set(p.label.toLowerCase().trim(), { id: p.id, label });
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  const record = (id: string) => {
    if (!seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  };

  // One pass with two alternatives: an already-encoded link (kept as-is, only
  // counted) or a bare word-boundary token (rewritten). The boundary char is
  // consumed by the bare-token alternative and re-emitted verbatim. The name
  // charset is deliberately ASCII-only (codex parity, `is_mention_name_char`):
  // CJK characters act as boundaries, so `看看我的@notion` rewrites even with
  // no space before the `@`. Dots are allowed *inside* the token
  // (`@sample.com`) but never trailing, so a sentence-final `@notion.`
  // rewrites cleanly.
  const re = /\[@([^\]]+)\]\((app:\/\/[^)\s]+)\)|(?:^|[^A-Za-z0-9_-])@([A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)*)/gu;
  let out = '';
  let lastIndex = 0;
  for (const match of content.matchAll(re)) {
    const index = match.index ?? 0;
    out += content.slice(lastIndex, index);

    if (match[1] !== undefined && match[2] !== undefined) {
      // Already-linked form: `[@label](app://id)`.
      const linkedId = match[2].slice('app://'.length).toLowerCase();
      const resolved = byIdOrLabel.get(linkedId);
      if (resolved) {
        record(resolved.id);
      }
      // Preserve the link exactly as written — never double-encode.
      out += match[0];
    } else if (match[3] !== undefined) {
      // Bare token: boundary char (group excludes it from the token itself)
      // + `@name`. The boundary char is `match[0][0]` when not at string start.
      const boundary = match[0].startsWith('@') ? '' : match[0][0];
      const resolved = byIdOrLabel.get(match[3].toLowerCase());
      if (resolved) {
        record(resolved.id);
        out += `${boundary}[@${resolved.label}](app://${resolved.id})`;
      } else {
        out += match[0];
      }
    }
    lastIndex = index + match[0].length;
  }
  out += content.slice(lastIndex);

  return { content: out, mentionedProviders: ordered };
}
