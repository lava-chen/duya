/**
 * Provider configuration belongs to the local Host. The Host is the only
 * writer of config.toml and secrets.json; CLI and Desktop both use this API.
 */

import { readLocalHostRuntime, startLocalHost, type LocalHostHandle } from '@duya/host/local-host';
import type {
  HostProviderDetail,
  HostProviderList,
  HostProviderWriteInput,
} from '@duya/agent-protocol/provider-catalog';
import { resolveHostWorkerPath } from './worker-path.js';

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
  apiKey?: string;
  model?: string;
  models?: string[];
  extraEnv?: Record<string, string>;
}

export interface ProviderManagementApi {
  list(): Promise<ManagedProvider[]>;
  add(input: AddManagedProviderInput): Promise<ManagedProvider>;
  setDefault(id: string | null): Promise<void>;
  remove(id: string): Promise<void>;
  close(): Promise<void>;
}

interface HostConnection {
  readonly origin: string;
  readonly token: string;
  readonly close: () => Promise<void>;
}

/** A bounded, secret-safe error returned by the local Host. */
export class ProviderManagementError extends Error {
  constructor(readonly status: number, readonly code: string) {
    super(`Provider configuration failed (${code}, HTTP ${status}).`);
    this.name = 'ProviderManagementError';
  }
}

async function connectHost(): Promise<HostConnection> {
  let runtime = await readRuntimeOrNull();
  if (runtime !== null) {
    return {
      origin: `http://${runtime.host}:${runtime.port}`,
      token: runtime.token,
      close: async () => {},
    };
  }

  let owned: LocalHostHandle | null = null;
  try {
    // Starting the Host here makes first-use setup possible without Desktop.
    // It publishes the normal descriptor so the next `duya tui` attaches to
    // the same owner instead of opening a second database.
    owned = await startLocalHost({ workerPath: resolveHostWorkerPath() });
    return {
      origin: owned.origin,
      token: owned.token ?? '',
      close: () => owned!.close(),
    };
  } catch (startError) {
    // Another CLI may have won the Host startup race. Reuse it only after its
    // authenticated descriptor is visible.
    runtime = await readRuntimeOrNull();
    if (runtime === null) throw startError;
    return {
      origin: `http://${runtime.host}:${runtime.port}`,
      token: runtime.token,
      close: async () => {},
    };
  }
}

async function readRuntimeOrNull() {
  try {
    return await readLocalHostRuntime();
  } catch {
    // A malformed or half-written descriptor is not a usable Host. The
    // startup lock remains the final authority if a live Host owns the data.
    return null;
  }
}

function projectProvider(row: HostProviderDetail): ManagedProvider {
  return {
    id: row.providerId,
    name: row.name,
    providerType: row.providerType,
    ...(row.baseUrl === '' ? {} : { baseUrl: row.baseUrl }),
    isActive: row.isDefault,
    isDefault: row.isDefault,
    hasKey: row.hasApiKey,
    ...(row.defaultModel === undefined ? {} : { model: row.defaultModel }),
  };
}

/** Connect once so a multi-step TUI flow shares one Host client and lifetime. */
export async function connectProviderManagementApi(): Promise<ProviderManagementApi> {
  const host = await connectHost();
  let closed = false;

  async function request<T>(route: string, method = 'GET', body?: unknown): Promise<T> {
    const response = await fetch(`${host.origin}${route}`, {
      method,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${host.token}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const payload: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const code = typeof payload === 'object' && payload !== null
        && 'error' in payload && typeof payload.error === 'object' && payload.error !== null
        && 'code' in payload.error && typeof payload.error.code === 'string'
        ? payload.error.code
        : 'host_request_failed';
      throw new ProviderManagementError(response.status, code);
    }
    return payload as T;
  }

  async function snapshot(): Promise<HostProviderList> {
    return request<HostProviderList>('/v1/local/providers');
  }

  return {
    async list() {
      const current = await snapshot();
      return current.providers.map(projectProvider);
    },
    async add(input) {
      const current = await snapshot();
      const write: HostProviderWriteInput = {
        providerId: input.id,
        name: input.name,
        providerType: input.providerType,
        baseUrl: input.baseUrl,
        ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
        ...(input.model === undefined ? {} : { defaultModel: input.model }),
        ...(input.models === undefined ? {} : { models: input.models }),
        ...(input.extraEnv === undefined ? {} : { extraEnv: input.extraEnv }),
        expectedRevision: current.revision,
      };
      const result = await request<{ provider: HostProviderDetail }>('/v1/local/providers/upsert', 'POST', write);
      return projectProvider(result.provider);
    },
    async setDefault(id) {
      const current = await snapshot();
      await request('/v1/local/providers/set-default', 'POST', {
        providerId: id,
        expectedRevision: current.revision,
      });
    },
    async remove(id) {
      const current = await snapshot();
      await request('/v1/local/providers/delete', 'POST', {
        providerId: id,
        expectedRevision: current.revision,
      });
    },
    async close() {
      if (closed) return;
      closed = true;
      await host.close();
    },
  };
}
