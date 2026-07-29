/**
 * Google Workspace provider adapter — Plan 312 Phase 1.
 *
 * Responsible for fetching account identity from the userinfo endpoint
 * after the auth-code exchange. Endpoint differences live here so the
 * flow orchestrator stays provider-agnostic.
 */

import type { ProviderClientConfig } from './registry';
import { getProviderConfig } from './registry';

export interface GoogleAccountIdentity {
  sub: string;
  email: string;
  name?: string;
  picture?: string;
}

const config: ProviderClientConfig = getProviderConfig('google');

export async function fetchGoogleAccountIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; accountLabel: string }> {
  const resp = await fetchImpl(config.userinfoUrl!, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`google userinfo failed: ${resp.status}`);
  }
  const data = (await resp.json()) as GoogleAccountIdentity;
  return {
    accountId: data.sub,
    accountLabel: data.email ?? data.sub,
  };
}
