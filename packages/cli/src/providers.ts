/**
 * Authenticated access to the Desktop-managed LLM provider store.
 *
 * The Desktop process owns provider persistence and audit records; callers in
 * the chat CLI use this adapter instead of writing provider config files.
 */

import { CliApiClient } from './api/client.js';

export interface ManagedProvider {
  id: string;
  name: string;
  providerType: string;
  baseUrl?: string;
  isActive: boolean;
  isDefault?: boolean;
  hasKey: boolean;
  model?: string;
}

export interface AddManagedProviderInput {
  id: string;
  name: string;
  providerType: string;
  baseUrl: string;
  apiKey: string;
  model?: string;
  models?: string[];
  extraEnv?: Record<string, string>;
}

export interface ProviderManagementApi {
  list(): Promise<ManagedProvider[]>;
  add(input: AddManagedProviderInput): Promise<ManagedProvider>;
  setDefault(id: string): Promise<void>;
  remove(id: string): Promise<void>;
}

/** Connect once so a multi-step TUI flow shares the same authenticated client. */
export async function connectProviderManagementApi(): Promise<ProviderManagementApi> {
  const client = await CliApiClient.connect();
  return {
    async list() {
      const body = await client.get<{ providers: ManagedProvider[] }>('/v1/config/providers');
      return body.providers;
    },
    async add(input) {
      const body = await client.post<{ provider: ManagedProvider }>('/v1/config/providers', input);
      return body.provider;
    },
    async setDefault(id) {
      await client.put(`/v1/config/providers/${encodeURIComponent(id)}/default`, {});
    },
    async remove(id) {
      await client.delete(`/v1/config/providers/${encodeURIComponent(id)}`);
    },
  };
}
