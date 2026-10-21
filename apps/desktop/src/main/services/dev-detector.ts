import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { initLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });

interface ElectronApp {
  isPackaged: boolean;
}

/**
 * Electron is OPTIONAL here: this module is inside the value-import closure of
 * the headless control plane's server entry
 * (`01-headless-control-plane.md` §2.1). A module-scope
 * `import { app } from 'electron'` is evaluated when the module is and throws
 * THERE, taking the whole graph with it, so `app` is resolved through a
 * guarded require.
 */
function electronApp(): ElectronApp | undefined {
  try {
    const { app } = require('electron') as { app?: ElectronApp };
    return app;
  } catch {
    return undefined;
  }
}

/**
 * A headless control plane runs from a checkout or an install tree, never from
 * a packaged Electron app, so "not packaged" is the truthful answer and keeps
 * this detector on its dev branch. Read at module scope on purpose: it was
 * `!app.isPackaged` there before, and moving it would change when the value is
 * sampled.
 */
const isDev = !electronApp()?.isPackaged;

export function getNodeExecutable(): string {
  // Platform-specific candidate lists. On Windows we look for node.exe in
  // nvm-windows / Program Files; on macOS we look in Homebrew (Intel + ARM)
  // and nvm locations. The binary name also differs (node.exe vs node).
  const isMac = process.platform === 'darwin';
  const isWin = process.platform === 'win32';
  const exeName = isWin ? 'node.exe' : 'node';

  const possiblePaths: string[] = [];
  if (isWin) {
    possiblePaths.push(
      path.join(process.env.APPDATA || '', '..', 'Local', 'nvm', 'v22.17.1', 'node.exe'),
      path.join(process.env.APPDATA || '', 'nvm4w', 'v22.17.1', 'node.exe'),
      path.join('C:\\Program Files\\nodejs\\node.exe'),
      path.join('C:\\Program Files (x86)\\nodejs\\node.exe'),
    );
  } else if (isMac) {
    // Homebrew Apple Silicon, Homebrew Intel, then common nvm default.
    possiblePaths.push(
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      path.join(process.env.HOME || '', '.nvm', 'versions', 'node', 'v22.17.1', 'bin', 'node'),
    );
  }

  // Search PATH for the platform-appropriate binary name.
  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  for (const dir of pathDirs) {
    const nodePath = path.join(dir, exeName);
    if (fs.existsSync(nodePath)) {
      return nodePath;
    }
  }

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      return p;
    }
  }

  return 'node';
}

async function detectDevServerPort(): Promise<number | null> {
  const portsToCheck = [3000, 3001, 3002, 3003, 3004, 3005];

  // Vite on Windows often binds to ::1 only, while Node's http.request
  // defaults to getaddrinfo's first address (typically 127.0.0.1). Probe
  // both loopback families in parallel so a Vite bound to either stack is
  // discovered.
  const loopbackHosts = ['127.0.0.1', '::1'];

  const checkPort = (host: string, port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: host,
        port,
        path: '/',
        method: 'HEAD',
        timeout: 3000,
      }, (res) => {
        resolve(res.statusCode !== undefined);
      });

      req.on('error', () => resolve(false));
      req.on('timeout', () => {
        req.destroy();
        resolve(false);
      });

      req.end();
    });
  };

  for (const port of portsToCheck) {
    const results = await Promise.all(
      loopbackHosts.map((host) => checkPort(host, port)),
    );
    if (results.some(Boolean)) {
      logger.info(`Detected Vite dev server on port ${port}`, undefined, LogComponent.Main);
      return port;
    }
  }

  return null;
}

export async function getRendererUrl(): Promise<string> {
  if (isDev) {
    const detectedPort = await detectDevServerPort();
    if (detectedPort) {
      return `http://localhost:${detectedPort}`;
    }
    logger.warn('Could not detect Vite dev server port, falling back to 3000', undefined, LogComponent.Main);
    return 'http://localhost:3000';
  }

  const distPath = path.join(process.resourcesPath, 'app.asar', 'dist');
  const indexPath = path.join(distPath, 'index.html');
  return `file://${indexPath}`;
}

export { isDev };