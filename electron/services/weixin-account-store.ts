/**
 * weixin-account-store.ts — weixin account CRUD backed by ConfigStore
 * `channels.adapters.weixin.accounts` (token split to secrets.json).
 */
import { getConfigStore } from '../config/store-instance';

export interface WeixinAccountRow {
  account_id: string;
  user_id: string;
  name: string;
  base_url: string;
  cdn_base_url: string;
  token: string;
  enabled: boolean;
}

function readAccounts(): WeixinAccountRow[] {
  const adapter = getConfigStore().getByPath('channels.adapters.weixin') as
    | { accounts?: Array<Record<string, unknown>> }
    | undefined;
  return (adapter?.accounts ?? []).map((a) => ({
    account_id: String(a.account_id ?? ''),
    user_id: String(a.user_id ?? ''),
    name: String(a.name ?? ''),
    base_url: String(a.base_url ?? ''),
    cdn_base_url: String(a.cdn_base_url ?? ''),
    token:
      String(a.token ?? '') ||
      (getConfigStore().getByPath(`channels.adapters.weixin.credentials.${String(a.account_id)}.token`) as string) ||
      '',
    enabled: Boolean(a.enabled),
  }));
}

function writeAccounts(accounts: WeixinAccountRow[]): void {
  const store = getConfigStore();
  const publicAccounts = accounts.map(({ token: _token, ...rest }) => rest);
  store.set('channels.adapters.weixin.accounts', publicAccounts);
  for (const a of accounts) {
    if (a.token) store.set(`channels.adapters.weixin.credentials.${a.account_id}.token`, a.token);
  }
}

export function getWeixinAccounts(): WeixinAccountRow[] {
  return readAccounts();
}

export function upsertWeixinAccount(input: {
  accountId: string;
  userId?: string;
  name?: string;
  baseUrl?: string;
  cdnBaseUrl?: string;
  token: string;
  enabled?: boolean;
}): WeixinAccountRow {
  const accounts = readAccounts();
  const existing = accounts.find((a) => a.account_id === input.accountId);
  const next: WeixinAccountRow = {
    account_id: input.accountId,
    user_id: input.userId ?? existing?.user_id ?? '',
    name: input.name ?? existing?.name ?? input.accountId,
    base_url: input.baseUrl ?? existing?.base_url ?? '',
    cdn_base_url: input.cdnBaseUrl ?? existing?.cdn_base_url ?? '',
    token: input.token,
    enabled: input.enabled ?? existing?.enabled ?? true,
  };
  writeAccounts([...accounts.filter((a) => a.account_id !== input.accountId), next]);
  return next;
}

export function updateWeixinAccount(accountId: string, patch: { enabled?: boolean; name?: string }): WeixinAccountRow | null {
  const accounts = readAccounts();
  const idx = accounts.findIndex((a) => a.account_id === accountId);
  if (idx === -1) return null;
  accounts[idx] = {
    ...accounts[idx],
    enabled: patch.enabled ?? accounts[idx].enabled,
    name: patch.name ?? accounts[idx].name,
  };
  writeAccounts(accounts);
  return accounts[idx];
}

export function deleteWeixinAccount(accountId: string): boolean {
  const accounts = readAccounts();
  const next = accounts.filter((a) => a.account_id !== accountId);
  if (next.length === accounts.length) return false;
  writeAccounts(next);
  return true;
}