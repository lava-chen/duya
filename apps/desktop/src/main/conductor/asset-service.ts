/**
 * asset-service.ts - Conductor asset storage service
 *
 * Stores uploaded media files (images, PDFs, documents) to the app's
 * userData directory under conductor-assets/{canvasId}/. Returns a
 * duya-file:// URL that the renderer can use to reference the file.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { randomUUID } from 'crypto';

export interface UploadedAsset {
  assetId: string;
  url: string;
  fileName: string;
  mimeType: string;
  size: number;
  kind: 'image' | 'file';
}

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.bmp']);

const EXT_MIME_MAP: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

function inferMimeType(fileName: string, fallback?: string): string {
  const ext = path.extname(fileName).toLowerCase();
  return EXT_MIME_MAP[ext] || fallback || 'application/octet-stream';
}

interface ElectronApp {
  getPath(name: 'userData'): string;
}

/**
 * Electron is OPTIONAL here: this module is inside the value-import closure of
 * the headless control plane's server entry
 * (`01-headless-control-plane.md` 搂2.1). A module-scope
 * `import { app } from 'electron'` is evaluated when the module is and throws
 * THERE, taking the whole graph with it, so `app` is resolved through a
 * guarded require and reported as absent instead.
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
 * Electron wins whenever it is present: this is the app's own directory and
 * must not move because the variable below happens to be exported in a dev
 * shell. `DUYA_CLI_USER_DATA_DIR` (`cli/handlers/plugins.ts`) is the existing
 * headless entry point and applies only when there is no desktop, where
 * `~/.duya` is the same root the rollout / attachment paths already use
 * (`config/boot-config.ts`), so an uploaded asset resolves to one location
 * whichever host stored it.
 */
function userDataDir(): string {
  const app = electronApp();
  if (app && typeof app.getPath === 'function') return app.getPath('userData');
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  return path.join(os.homedir(), '.duya');
}

function isImage(mimeType: string, fileName: string): boolean {
  if (mimeType.startsWith('image/')) return true;
  const ext = path.extname(fileName).toLowerCase();
  return IMAGE_EXTENSIONS.has(ext);
}

function buildAssetUrl(filePath: string): string {
  // Build a duya-file:// URL. The protocol handler in main.ts reads the
  // pathname as an absolute path. Forward-slash separators work on all
  // platforms; the handler converts them back to the OS separator.
  return `duya-file:///${filePath.replace(/\\/g, '/')}`;
}

function writeAssetFile(dir: string, assetId: string, fileName: string, buffer: Buffer | ArrayBuffer, mimeType?: string): UploadedAsset {
  fs.mkdirSync(dir, { recursive: true });
  const safeFileName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
  const filePath = path.join(dir, `${assetId}-${safeFileName}`);
  fs.writeFileSync(filePath, Buffer.from(buffer));

  const detectedMime = mimeType || inferMimeType(fileName);
  const size = buffer.byteLength;
  const kind: 'image' | 'file' = isImage(detectedMime, fileName) ? 'image' : 'file';

  return {
    assetId,
    url: buildAssetUrl(filePath),
    fileName,
    mimeType: detectedMime,
    size,
    kind,
  };
}

export function uploadAsset(
  canvasId: string,
  buffer: Buffer | ArrayBuffer,
  fileName: string,
  mimeType?: string,
): UploadedAsset {
  const assetId = randomUUID();
  const dir = path.join(userDataDir(), 'conductor-assets', canvasId);
  return writeAssetFile(dir, assetId, fileName, buffer, mimeType);
}

/**
 * Upload an asset to the project-local `.duya/assets/{canvasId}/` directory.
 * Falls back to the app userData directory when no project path is provided.
 */
export function uploadProjectAsset(
  canvasId: string,
  projectPath: string | null | undefined,
  buffer: Buffer | ArrayBuffer,
  fileName: string,
  mimeType?: string,
): UploadedAsset {
  const assetId = randomUUID();
  const dir = projectPath
    ? path.join(projectPath, '.duya', 'assets', canvasId)
    : path.join(userDataDir(), 'conductor-assets', canvasId);
  return writeAssetFile(dir, assetId, fileName, buffer, mimeType);
}
