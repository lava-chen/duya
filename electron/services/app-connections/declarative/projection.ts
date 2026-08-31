/**
 * Declaration → provider-config projection — Plan 460.
 *
 * A plugin `.app.json` entry (`AppDeclaration`) declares optional OAuth
 * client endpoints (`oauth` block) plus tool REST templates (`tools`).
 * This module projects the `oauth` block into a {@link ProviderClientConfig}
 * so the existing OAuth flow (`oauth/flow.ts`), token refresh
 * (`token-service.ts`), remote-MCP authorization (`remote-mcp-flow.ts`),
 * and readiness checks all treat plugin-declared connectors exactly like
 * first-party builtins — no per-provider code in the duya core.
 *
 * Projection rules:
 *   - `oauth.remoteMcpUrl`  → remote-MCP provider (RFC 9728 discovery).
 *   - otherwise             → OAuth authorization-code provider; requires
 *                             `authUrl` + `tokenUrl` and a `clientId`
 *                             (public client, PKCE). A missing clientId
 *                             yields an unconfigured provider (readiness
 *                             fails closed until a client is supplied).
 *   - plugins may never declare a client secret (schema has no secret
 *     field); `requiresClientSecret` defaults to `false`.
 */

import type { AppDeclaration } from '@duya/plugin-core/src/connectors/app-schema.js';
import { asAppConnectorId, type AppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';
import type { ProviderClientConfig } from '../providers/registry.js';

/** Build a builtin-shaped provider config from a plugin `.app.json` entry. */
export function declarationToProviderConfig(
  declaration: AppDeclaration,
): ProviderClientConfig | undefined {
  const oauth = declaration.oauth;
  if (!oauth) return undefined;

  const id = asAppConnectorId(declaration.id);
  const label = declaration.interface?.label ?? declaration.name ?? declaration.id;

  if (oauth.remoteMcpUrl) {
    return {
      id,
      label,
      authUrl: '',
      tokenUrl: '',
      redirectPath: `/callback/mcp/${id}`,
      defaultScopes: [],
      requiresClientSecret: false,
      supportsManualConfiguration: false,
      clientId: '',
      remoteMcpUrl: oauth.remoteMcpUrl,
      monogram: declaration.interface?.monogram ?? monogramOf(id),
      description: declaration.interface?.description ?? '',
    };
  }

  if (!oauth.authUrl || !oauth.tokenUrl) {
    // Not a usable OAuth provider without both endpoints.
    return undefined;
  }

  return {
    id,
    label,
    authUrl: oauth.authUrl,
    tokenUrl: oauth.tokenUrl,
    revokeUrl: oauth.revokeUrl,
    redirectPath: oauth.redirectPath ?? `/callback/${id}`,
    defaultScopes: oauth.defaultScopes,
    userinfoUrl: oauth.userinfoUrl,
    requiresOAuthClient: oauth.requiresOAuthClient ?? true,
    requiresClientSecret: oauth.requiresClientSecret ?? false,
    supportsManualConfiguration: oauth.supportsManualConfiguration ?? false,
    clientId: oauth.clientId ?? '',
    monogram: declaration.interface?.monogram ?? monogramOf(id),
    description: declaration.interface?.description ?? '',
  };
}

function monogramOf(id: AppConnectorId): string {
  const first = id[0]?.toUpperCase();
  return first && /[A-Z0-9]/.test(first) ? first : 'A';
}
