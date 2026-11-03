import { readLocalHostRuntimeFrom } from '@duya/host/host-runtime';
import { resolveDataRoot } from '@duya/data/data-paths';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { startBackgroundHost } from '../tui/background-host.js';
import { holdClientLease } from '../tui/client-lease-holder.js';
import { CliApiError } from './errors.js';

/** One command request against the Host that owns the shared data directory. */
export class PluginApiClient {
  private constructor(private readonly origin: string, private readonly token: string,
    private readonly release: () => void) { }

  static async connect(): Promise<PluginApiClient> {
    try {
      const runtime = await readLocalHostRuntimeFrom(resolveDataRoot());
      const host = runtime === null ? await startBackgroundHost() : {
        origin: `http://${runtime.host}:${runtime.port}`, token: runtime.token,
      };
      const lease = holdClientLease(new HostSessionHttpClient(host.origin, host.token ?? ''));
      return new PluginApiClient(host.origin, host.token ?? '', () => lease.close());
    } catch (error) {
      const message = `Could not connect to or start Duya Host: ${error instanceof Error ? error.message : String(error)}`;
      throw new CliApiError('connection_refused', message, message);
    }
  }

  get<T>(path: string): Promise<T> { return this.request<T>('GET', path); }
  post<T>(path: string, body: unknown, options: { correlationId?: string } = {}): Promise<T> {
    return this.request<T>('POST', path, body, options.correlationId);
  }

  private async request<T>(method: string, path: string, body?: unknown, correlationId?: string): Promise<T> {
    try {
      const response = await fetch(this.origin + path, {
        method, signal: AbortSignal.timeout(method === 'GET' ? 15_000 : 300_000),
        headers: {
          Authorization: `Bearer ${this.token}`, 'Content-Type': 'application/json',
          ...(correlationId === undefined ? {} : { 'X-Correlation-Id': correlationId })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result: unknown = await response.json();
      if (!response.ok) {
        const detail = result && typeof result === 'object' && 'error' in result ? result.error : undefined;
        const message = detail && typeof detail === 'object' && 'message' in detail && typeof detail.message === 'string'
          ? detail.message : `Duya Host returned HTTP ${response.status}`;
        throw new CliApiError(response.status === 404 ? 'not_found' : 'server_error', message, message, response.status);
      }
      return result as T;
    } finally { this.release(); }
  }
}
