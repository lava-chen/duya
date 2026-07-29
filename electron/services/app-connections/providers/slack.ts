/**
 * Slack provider adapter — Plan 312 Phase 1.
 *
 * Slack's `oauth.v2.access` returns a `bot_user_id` / `authed_user.id`
 * rather than an OIDC userinfo shape. We call `auth.test` for the
 * canonical account identity.
 */

import { getProviderConfig } from './registry';

interface SlackAuthTestResponse {
  ok: boolean;
  url?: string;
  user?: string;
  user_id?: string;
  team?: string;
  team_id?: string;
  error?: string;
}

const config = getProviderConfig('slack');

export async function fetchSlackAccountIdentity(
  accessToken: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ accountId: string; accountLabel: string }> {
  const resp = await fetchImpl(config.userinfoUrl!, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!resp.ok) {
    throw new Error(`slack auth.test failed: ${resp.status}`);
  }
  const data = (await resp.json()) as SlackAuthTestResponse;
  if (!data.ok) {
    throw new Error(`slack auth.test error: ${data.error ?? 'unknown'}`);
  }
  return {
    accountId: data.user_id ?? data.user ?? 'unknown',
    accountLabel: data.user ? `${data.user}@${data.team ?? 'slack'}` : 'slack-user',
  };
}
