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

/**
 * Plan 450: extract provider ids @-mentioned in user content.
 *
 * The composer inserts `@<providerId> ` tokens when the user picks an app
 * connection from the @ popover (file-mention insertion path), e.g.
 * "@notion create a page about today's stand-up". This helper scans the
 * final message for those tokens, case-insensitive, word-boundary, and
 * returns the matching provider ids in first-seen order. Uniqueness is
 * preserved (one provider counted once even when mentioned repeatedly).
 *
 * Unknown `@<word>` tokens are silently ignored — only providers in
 * `availableProviders` (typically the connected set) are returned, matching
 * codex's `find_app_mentions` rule that a mention must resolve to an
 * accessible, enabled app.
 */
export function extractMentionedProviders(
  content: string,
  availableProviders: Array<{ id: string; label?: string }>,
): string[] {
  if (!content || !content.includes('@') || availableProviders.length === 0) return [];

  // Build a label -> id map for label-based mentions (display-friendly).
  const byIdOrLabel = new Map<string, string>();
  for (const p of availableProviders) {
    if (!p.id) continue;
    byIdOrLabel.set(p.id.toLowerCase(), p.id);
    if (p.label) byIdOrLabel.set(p.label.toLowerCase().trim(), p.id);
  }

  const seen = new Set<string>();
  const ordered: string[] = [];
  // Word-boundary scan: @<letters/digits/underscore/hyphen/dot>+ at a
  // boundary that is either start-of-string or a non-identifier
  // character (matches codex's plain-name mention extraction).
  const re = /(?:^|[^\p{L}\p{N}_])@([\p{L}\p{N}_.-]+)/gu;
  for (const match of content.matchAll(re)) {
    const raw = match[1].toLowerCase();
    const id = byIdOrLabel.get(raw);
    if (id && !seen.has(id)) {
      seen.add(id);
      ordered.push(id);
    }
  }
  return ordered;
}
