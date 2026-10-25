/**
 * apps/desktop/src/main/ipc/doctor-facts.ts
 *
 * Where the Desktop's `/doctor` facts come from.
 *
 * Every fact is taken IN THIS PROCESS — there is no HTTP probe, because the
 * Desktop IS the Host. The CLI has to reach for `http://127.0.0.1:<port>`
 * because it is a different process; here the plugin registry, the core
 * database and the status handler are one function call away.
 *
 * The heavy modules (the plugin manager, the desktop Host API client) are
 * imported lazily so that registering the diagnostics handler does not widen
 * the main process's boot graph for a command most sessions never run.
 *
 * ## The three-valued answer
 *
 * The shared layer asks for `known` / `failed` / `unavailable`, and the
 * difference matters: `unavailable` means "the Host could not be asked", and
 * it becomes a `skipped` check. The Desktop is never unavailable — it is
 * running, and it is this code — so a failure here is always `failed`: the
 * answer came back wrong, which is a fact about the install.
 */

import { app } from 'electron';

import type {
  DoctorFact,
  DoctorHostProbe,
  DoctorPluginValue,
  DoctorProfile,
  DoctorSessionValue,
  DoctorStatusValue,
} from '@duya/host/diagnostics';

import { getCoreStoresOrNull } from '../db/core-connection';

/**
 * Which kind of installation this is.
 *
 * `production` for a packaged app, `development` for a source run. The value
 * is a fact about the build, not a guess: `app.isPackaged` is the same switch
 * Electron uses to decide whether it is running from a bundle.
 */
export function desktopProfile(): DoctorProfile {
  try {
    return app.isPackaged ? 'production' : 'development';
  } catch {
    return 'unknown';
  }
}

/**
 * The Desktop's own status: does the in-process health API answer?
 *
 * A status code of 200 with no auth failure is what the shared layer reads
 * as "the desktop app reports healthy status", and it is the same fact the
 * CLI's HTTP probe reports when `/v1/status` answers.
 */
async function probeStatus(): Promise<DoctorFact<DoctorStatusValue>> {
  try {
    const { getDesktopHostHealthApi } = await import('../cli/desktop-host-api');
    await getDesktopHostHealthApi().getHealth();
    return { kind: 'known', value: { statusCode: 200, authFailed: false, serverError: false } };
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The plugin registry — the same registry the CLI reads over
 * `GET /v1/plugins`, so both surfaces report the same count.
 */
async function listPlugins(): Promise<DoctorFact<DoctorPluginValue>> {
  try {
    const { getPluginManager } = await import('../plugins/PluginManager');
    const installed = getPluginManager().listInstalled();
    return { kind: 'known', value: { count: installed.length } };
  } catch (error) {
    return {
      kind: 'failed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The session store.
 *
 * The count comes from the core database's session table, which is the same
 * table the CLI's `GET /v1/sessions` reads.
 */
function querySessions(): Promise<DoctorFact<DoctorSessionValue>> {
  const stores = getCoreStoresOrNull();
  if (!stores) {
    return Promise.resolve({
      kind: 'failed' as const,
      reason: 'the core database is not initialized',
    });
  }
  try {
    const sessions = stores.sessions.list();
    return Promise.resolve({ kind: 'known' as const, value: { hasSessions: sessions.length > 0 } });
  } catch (error) {
    return Promise.resolve({
      kind: 'failed' as const,
      reason: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The Desktop's {@link DoctorHostProbe}: the install, read in place. */
export function createDesktopDoctorProbe(): DoctorHostProbe {
  return { probeStatus, listPlugins, querySessions };
}
