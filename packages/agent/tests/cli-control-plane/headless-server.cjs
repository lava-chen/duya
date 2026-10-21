/**
 * packages/agent/tests/cli-control-plane/headless-server.cjs
 *
 * Headless Electron entry that boots ONLY the CLI API server with a
 * per-test temp userData. Used by the regression tests in this
 * directory so the test does not need to drive the full GUI app
 * (which has single-instance lock and a Vite renderer that
 * complicate integration testing).
 *
 * The bundled CLI server exports both startCliApiServer and
 * initDatabase (initDatabaseFromBoot). We call initDatabase first
 * to populate the connection module's singleton, then
 * startCliApiServer.
 *
 * NEVER run this against a real user-data directory.
 */

const { app } = require('electron');
const path = require('node:path');
const { writeFileSync, mkdirSync } = require('node:fs');

const userData = process.env.CLI_TEST_USER_DATA;
if (!userData) {
  process.stderr.write('CLI_TEST_USER_DATA required\n');
  process.exit(1);
}

app.setName('DUYA');
app.setPath('userData', userData);

const projectRoot = path.resolve(__dirname, '..', '..', '..', '..');

app.on('browser-window-created', (_e, win) => {
  try { win.destroy(); } catch { /* ignore */ }
});

app.disableHardwareAcceleration();
app.commandLine.appendSwitch('disable-gpu');

app.whenReady().then(async () => {
  try {
    const serverBundle = path.join(projectRoot, 'packages', 'agent', 'bundle', 'cli-api-server.cjs');
    const { startCliApiServer, initDatabase } = require(serverBundle);
    const dbInit = initDatabase();
    if (!dbInit || !dbInit.success) {
      throw new Error('initDatabase failed: ' + JSON.stringify(dbInit));
    }

    const handle = await startCliApiServer();
    const runtimeDir = path.join(userData, 'runtime');
    mkdirSync(runtimeDir, { recursive: true });
    writeFileSync(
      path.join(runtimeDir, 'cli-api.json'),
      JSON.stringify(
        {
          port: handle.port,
          token: handle.token,
          pid: process.pid,
          startedAt: handle.startedAt,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    process.stderr.write(`cli-api-server up: port=${handle.port} pid=${process.pid}\n`);
  } catch (err) {
    process.stderr.write('start failed: ' + (err instanceof Error ? err.stack : String(err)) + '\n');
    app.exit(1);
  }
});

app.on('window-all-closed', () => {
  // Don't quit; the server keeps the process up.
});
