/**
 * Microsoft 365 provider adapter — Plan 312 Phase 1.
 *
 * Calls the Microsoft Graph `/me` endpoint to resolve account identity
 * after the auth-code exchange. MS Graph returns an `id` (stable per
 * app) and a `userPrincipalName` (email-shaped, used as the label).
 */

import { getProviderConfig } from './registry';

interface MicrosoftMeResponse {
  id: string;
  userPrincipalName?: string;
  displayName?: string;
  mail?: string;
}

import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';

const config = getProviderConfig(asAppConnectorId('microsoft365'));
if (!config) {
  throw new Error('microsoft365 connector is not registered');
}
const userinfoUrl = config.userinfoUrl!;

export async function fetchMicrosoft365AccountIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; accountLabel: string }> {
  const resp = await fetchImpl(userinfoUrl!, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`microsoft graph /me failed: ${resp.status}`);
  }
  const data = (await resp.json()) as MicrosoftMeResponse;
  return {
    accountId: data.id,
    accountLabel: data.userPrincipalName ?? data.mail ?? data.displayName ?? data.id,
  };
}
