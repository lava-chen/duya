/**
 * packages/cli/src/commands/doctor-probe.ts
 *
 * The CLI's implementation of the shared doctor's Host seam.
 *
 * The shared layer owns the CHECKS; this file owns the TRANSPORT. The CLI
 * asks a Host that may be on another machine, over the Desktop's CLI API, and
 * that Host may simply not be running — which is why every answer here is
 * three-valued (`known` / `failed` / `unavailable`) and why "unreachable"
 * never becomes an error.
 *
 * ## Why the DESKTOP's CLI API and not the Host API
 *
 * The three facts the Host-dependent categories need are served by the
 * Desktop's CLI API:
 *
 *   GET /v1/status     → the Desktop's own status handler
 *   GET /v1/plugins    → the Desktop's plugin registry
 *   GET /v1/sessions   → the Desktop's session list
 *
 * Those routes live on the Desktop's CLI API server
 * (`apps/desktop/src/main/cli/cli-api-server.ts`), which publishes its
 * address in `runtime/cli-api.json` — exactly the file
 * `readCliApiRuntime()` reads. The Host API serves a different set
 * (`/healthz`, `/v1/sessions`, `/v1/local/...`) and has no `/v1/status` and no
 * `/v1/plugins` at all, so asking a plain `duya serve` Host for them would
 * report a healthy install as broken.
 *
 * ## Why the client is built from the runtime lookup
 *
 * `CliApiClient.get()` sends to `this.baseUrl + path`. A client constructed
 * with the default constructor has an EMPTY baseUrl, so `get('/v1/plugins')`
 * would try to fetch the relative URL `/v1/plugins` and throw — every plugin
 * count would come back as "could not determine". Building the client from
 * the runtime lookup gives it the real address and the bearer token.
 */

import { CliApiClient, type ProbeResult } from '../api/client.js';
import { isPidAlive, readCliApiRuntime } from '../api/runtime-config.js';
import type {
  DoctorFact,
  DoctorHostProbe,
  DoctorPluginValue,
  DoctorRuntimeFact,
  DoctorSessionValue,
  DoctorStatusValue,
} from '@duya/host/diagnostics';

const PLUGINS_ROUTE = '/v1/plugins';
const SESSIONS_ROUTE = '/v1/sessions?limit=1&offset=0';

/**
 * Build a client for the Desktop's CLI API, or `null` when no Desktop is
 * publishing one.
 *
 * Never throws: "no Desktop is running" is an ordinary state for the doctor
 * to report, not an exceptional one.
 */
async function connectCliApi(): Promise<CliApiClient | null> {
  const lookup = await readCliApiRuntime();
  if (lookup.kind !== 'ok') return null;
  return new CliApiClient(`http://127.0.0.1:${lookup.runtime.port}`, lookup.runtime.token);
}

/**
 * Read the local runtime file and say what it means.
 *
 * The PID liveness test happens HERE rather than in the shared layer: "is this
 * process still running" is a question about the local process table, and the
 * caller is the one that knows how to ask it on this platform.
 */
export async function resolveRuntimeFact(): Promise<DoctorRuntimeFact> {
  try {
    const lookup = await readCliApiRuntime();
    if (lookup.kind === 'not_running') {
      return { kind: 'absent', reason: lookup.reason };
    }
    if (lookup.kind === 'malformed') {
      return { kind: 'malformed', reason: lookup.reason };
    }
    return {
      kind: 'running',
      pid: lookup.runtime.pid,
      alive: isPidAlive(lookup.runtime.pid),
    };
  } catch (error) {
    return {
      kind: 'unreadable',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * Turn a probe into a status fact.
 *
 * An unreachable Host is `unavailable`, never `failed`: nothing was checked,
 * so nothing may be reported as broken.
 */
function statusFact(probe: ProbeResult): DoctorFact<DoctorStatusValue> {
  if (!probe.reachable) {
    return { kind: 'unavailable', reason: probe.message };
  }
  return {
    kind: 'known',
    value: {
      statusCode: probe.statusCode,
      authFailed: probe.error === 'auth_failed' || probe.statusCode === 401,
      serverError: probe.error === 'server_error' || probe.statusCode >= 500,
    },
  };
}

/** The CLI's {@link DoctorHostProbe}: the Desktop's CLI API over HTTP. */
export function createDesktopCliApiProbe(): DoctorHostProbe {
  return {
    async probeStatus(): Promise<DoctorFact<DoctorStatusValue>> {
      const client = await connectCliApi();
      if (client === null) {
        return {
          kind: 'unavailable',
          reason: 'No desktop app is publishing a CLI API address.',
        };
      }
      return statusFact(await client.probe('/v1/status'));
    },

    async listPlugins(): Promise<DoctorFact<DoctorPluginValue>> {
      const client = await connectCliApi();
      if (client === null) {
        return {
          kind: 'unavailable',
          reason: 'No desktop app is publishing a CLI API address.',
        };
      }
      const probe = await client.probe(PLUGINS_ROUTE);
      if (!probe.reachable) {
        return { kind: 'unavailable', reason: probe.message };
      }
      if (probe.statusCode >= 400) {
        return {
          kind: 'failed',
          reason: `Server returned HTTP ${probe.statusCode}`,
          measured: `HTTP ${probe.statusCode} from GET ${PLUGINS_ROUTE}`,
        };
      }
      try {
        const payload = await client.get<{ plugins?: unknown }>(PLUGINS_ROUTE);
        const count = Array.isArray(payload.plugins) ? payload.plugins.length : 0;
        return { kind: 'known', value: { count } };
      } catch (error) {
        return {
          kind: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },

    async querySessions(): Promise<DoctorFact<DoctorSessionValue>> {
      const client = await connectCliApi();
      if (client === null) {
        return {
          kind: 'unavailable',
          reason: 'No desktop app is publishing a CLI API address.',
        };
      }
      const probe = await client.probe(SESSIONS_ROUTE);
      if (!probe.reachable) {
        return { kind: 'unavailable', reason: probe.message };
      }
      if (probe.statusCode >= 400) {
        return {
          kind: 'failed',
          reason: `Server returned HTTP ${probe.statusCode}`,
          measured: `HTTP ${probe.statusCode} from GET ${SESSIONS_ROUTE}`,
        };
      }
      try {
        const payload = await client.get<{ sessions?: unknown }>(SESSIONS_ROUTE);
        return { kind: 'known', value: { hasSessions: Array.isArray(payload.sessions) } };
      } catch (error) {
        return {
          kind: 'failed',
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
