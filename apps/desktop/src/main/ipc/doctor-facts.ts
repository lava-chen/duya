/**
 * apps/desktop/src/main/ipc/doctor-facts.ts
 *
 * Where the Desktop's `/doctor` facts come from.
 *
 * Every fact is taken IN THIS PROCESS — there is no HTTP probe, because the
 * Desktop is the Host. The CLI has to reach for `http://127.0.0.1:<port>`
 * because it is a different process; here the plugin registry, the core
 * database and the status handler are one function call away.
 *
 * The heavy modules (the plugin manager, the desktop Host API client) are
 * imported lazily so that registering the diagnostics handler does not widen
 * the main process's boot graph for a command most sessions never run.
 */

import { app } from 'electron';

import { getCoreStoresOrNull } from '../db/core-connection';
import { getMainWindow } from '../core/window-manager';

import type { DesktopFactsApi } from './doctor-report';
import type { DoctorProfile } from '../../contracts/doctor';

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
 * Collect every fact the desktop checks need.
 *
 * A fact that could not be collected is reported as such — `readable: false`
 * with the reason — rather than as a count of zero, so the report can tell
 * "the registry is broken" from "there are no plugins".
 */
export async function collectDesktopFacts(): Promise<DesktopFactsApi> {
  return {
    status: await collectStatus(),
    window: collectWindow(),
    plugins: await collectPlugins(),
    sessions: collectSessions(),
    database: await collectDatabase(),
  };
}

/** The Desktop's own status: does the in-process health API answer? */
async function collectStatus(): Promise<DesktopFactsApi['status']> {
  try {
    const { getDesktopHostHealthApi } = await import('../cli/desktop-host-api');
    const health = await getDesktopHostHealthApi().getHealth();
    return {
      reachable: true,
      detail: `Host API v${health.apiVersion} · database ${health.databaseReady ? 'ready' : 'not ready'}`,
    };
  } catch (error) {
    return {
      reachable: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The main window. A detached or closed window is still a running app. */
function collectWindow(): DesktopFactsApi['window'] {
  const window = getMainWindow();
  if (!window) return { present: false, detail: 'no main window has been created yet' };
  if (window.isDestroyed()) return { present: false, detail: 'the main window has been destroyed' };
  return { present: true, detail: `window id ${window.id}` };
}

/**
 * The plugin registry — the same registry the CLI reads over
 * `GET /v1/plugins`, so both surfaces report the same count.
 */
async function collectPlugins(): Promise<DesktopFactsApi['plugins']> {
  try {
    const { getPluginManager } = await import('../plugins/PluginManager');
    const installed = getPluginManager().listInstalled();
    return { readable: true, count: installed.length };
  } catch (error) {
    return {
      readable: false,
      count: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/**
 * The session store.
 *
 * The count comes from the core database's session table, which is the same
 * table the CLI's `GET /v1/sessions` reads.
 */
function collectSessions(): DesktopFactsApi['sessions'] {
  const stores = getCoreStoresOrNull();
  if (!stores) {
    return {
      queryWorks: false,
      count: null,
      detail: 'the core database is not initialized',
    };
  }
  try {
    const sessions = stores.sessions.list();
    return { queryWorks: true, count: sessions.length };
  } catch (error) {
    return {
      queryWorks: false,
      count: null,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The core SQLite database. */
async function collectDatabase(): Promise<DesktopFactsApi['database']> {
  try {
    const { getDesktopHostHealthApi } = await import('../cli/desktop-host-api');
    const health = await getDesktopHostHealthApi().getHealth();
    return {
      ready: health.databaseReady,
      ...(health.databaseReady ? {} : { detail: 'the Host reports databaseReady = false' }),
    };
  } catch (error) {
    return {
      ready: false,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}
