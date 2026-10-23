/**
 * desktop-host-workspace-lifecycle.test.ts — the Desktop's embedded Host
 * serves the checkout / integration namespaces (plan 621).
 *
 * ## What is pinned
 *
 * The Desktop's embedded Host is a SECOND Host for the same routes the
 * headless one serves. Before the namespaces were registered, those routes
 * answered a named 404 (`checkout_api_unavailable` and friends) — which says
 * "this Host cannot observe", a different fact from "this session has no
 * checkout" or "this session has no pull requests". The gap would only ever
 * have shown up on this surface.
 *
 * So this test boots the REAL embedded Host — the same `startDesktopHostApi`
 * the Electron main process calls, over real SQLite databases — and asks it
 * the three questions. The answers are the wiring: a route that is composed
 * but not registered answers the named 404, and only a registered one answers
 * the observation.
 *
 * ## Why the answers are read over HTTP
 *
 * The Desktop's main process reaches these namespaces through the Host's
 * authenticated HTTP client, so the test reaches them the same way: it reads
 * the runtime descriptor the embedded Host publishes (`runtime/host-api.json`)
 * — which is how the TUI attaches to a running Desktop — and calls the
 * routes with that bearer token. A test that called the namespaces directly
 * would pass even if the Desktop registered the wrong ones.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ userData: '' }));

/**
 * Electron's `app` and the handful of module-scope Electron imports the
 * Desktop's main-process graph evaluates while it boots. The embedded Host
 * itself is Electron-free; only the surrounding Desktop shell needs these.
 */
vi.mock('electron', () => {
  const app = {
    getPath: (name: string) =>
      name === 'userData' ? mocks.userData : path.join(mocks.userData, name),
    isPackaged: false,
    on: () => undefined,
    whenReady: async () => undefined,
  };
  return {
    app,
    BrowserWindow: class {},
    ipcMain: { handle: () => undefined, on: () => undefined, removeHandler: () => undefined },
    ipcRenderer: { invoke: async () => undefined, on: () => undefined },
    shell: { openPath: async () => '', openExternal: async () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    Menu: { buildFromTemplate: () => ({}), setApplicationMenu: () => undefined },
    Tray: class {},
    nativeImage: { createFromPath: () => ({}) },
    screen: { getPrimaryDisplay: () => ({ bounds: { x: 0, y: 0, width: 1, height: 1 } }) },
    clipboard: { writeText: () => undefined },
    desktopCapturer: { getSources: async () => [] },
    session: { defaultSession: { webRequest: {} } },
    webContents: { getAllWebContents: () => [] },
    safeStorage: { isEncryptionAvailable: () => false },
    protocol: { registerSchemesAsPrivileged: () => undefined, handle: () => undefined },
    Notification: class {},
    nativeTheme: { shouldUseDarkColors: false },
    globalShortcut: { register: () => false, unregisterAll: () => undefined },
    MessageChannelMain: class {},
    powerMonitor: { on: () => undefined },
    systemPreferences: { getMediaAccessStatus: () => 'granted' },
    net: { request: () => undefined },
    contextBridge: { exposeInMainWorld: () => undefined },
    webFrame: { setZoomFactor: () => undefined },
  };
});

/** The descriptor the embedded Host publishes for other clients to attach. */
interface HostApiRuntime {
  readonly host: string;
  readonly port: number;
  readonly token: string;
}

let dataRoot: string;
let host: HostApiRuntime;
let stopHost: (() => Promise<void>) | undefined;

beforeAll(async () => {
  dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-embedded-host-'));
  mocks.userData = dataRoot;
  // `process.resourcesPath` is an Electron global. The Desktop's DB loader
  // reads it while deciding where better-sqlite3 lives, so a run outside
  // Electron has to provide one or the path join throws before the boot.
  (process as { resourcesPath?: string }).resourcesPath = dataRoot;
  process.env.DUYA_DATA_ROOT = dataRoot;
  delete process.env.DUYA_TEST;
  delete process.env.DUYA_TEST_NAMESPACE;

  const { initDatabaseFromBoot, getSqliteCtor } = await import('../../db/connection');
  const boot = initDatabaseFromBoot();
  if (!boot.success) throw new Error(`legacy database did not open: ${boot.error}`);
  const sqlite = getSqliteCtor();
  if (!sqlite) throw new Error('better-sqlite3 was not loaded');
  const { initCoreDatabase } = await import('../../db/core-connection');
  initCoreDatabase(sqlite);

  const { startDesktopHostApi } = await import('../desktop-host-api');
  const handle = await startDesktopHostApi();
  stopHost = handle.stop;

  host = JSON.parse(
    fs.readFileSync(path.join(dataRoot, 'runtime', 'host-api.json'), 'utf8'),
  ) as HostApiRuntime;
}, 120_000);

afterAll(async () => {
  await stopHost?.();
  delete process.env.DUYA_DATA_ROOT;
});

function headers(): Record<string, string> {
  return { authorization: `Bearer ${host.token}`, 'content-type': 'application/json' };
}

function origin(): string {
  return `http://${host.host}:${host.port}`;
}

describe('the Desktop embedded Host answers the checkout routes', () => {
  it('answers "not in a checkout" for a session that has none', async () => {
    const response = await fetch(`${origin()}/v1/checkouts?sessionId=s-1`, { headers: headers() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      checkout: { sessionId: 's-1', checkout: null, isOwner: false },
    });
  });
});

describe('the Desktop embedded Host answers the integration routes', () => {
  it('answers an empty projection for a session with no pull requests', async () => {
    const response = await fetch(`${origin()}/v1/integrations?sessionId=s-1`, { headers: headers() });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ records: [] });
  });

  it('answers the refresh route instead of refusing it', async () => {
    const response = await fetch(`${origin()}/v1/integrations/sync`, {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify({ sessionId: 's-1' }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'no_checkpoints',
      written: [],
      failed: [],
    });
  });
});
