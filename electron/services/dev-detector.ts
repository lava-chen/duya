import * as path from 'path';
import * as fs from 'fs';
import * as http from 'http';
import { app } from 'electron';
import { initLogger, LogComponent } from '../logging/logger';

const logger = initLogger({ level: 'WARN' });
const isDev = !app.isPackaged;

export function getNodeExecutable(): string {
  const possiblePaths = [
    path.join(process.env.APPDATA || '', '..', 'Local', 'nvm', 'v22.17.1', 'node.exe'),
    path.join(process.env.APPDATA || '', 'nvm4w', 'v22.17.1', 'node.exe'),
    path.join('C:\\Program Files\\nodejs\\node.exe'),
    path.join('C:\\Program Files (x86)\\nodejs\\node.exe'),
  ];

  const pathEnv = process.env.PATH || '';
  const pathDirs = pathEnv.split(path.delimiter);
  for (const dir of pathDirs) {
    const nodePath = path.join(dir, 'node.exe');
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

  const checkPort = (port: number): Promise<boolean> => {
    return new Promise((resolve) => {
      const req = http.request({
        hostname: 'localhost',
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
    const isReady = await checkPort(port);
    if (isReady) {
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