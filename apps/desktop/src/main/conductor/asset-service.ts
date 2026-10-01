/**
 * asset-service.ts - Conductor asset storage service
 *
 * Stores uploaded media files (images, PDFs, documents) to the app's
 * userData directory under conductor-assets/{canvasId}/. Returns a
 * duya-file:// URL that the renderer can use to reference the file.
 */

import { app } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
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
  const dir = path.join(app.getPath('userData'), 'conductor-assets', canvasId);
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
    : path.join(app.getPath('userData'), 'conductor-assets', canvasId);
  return writeAssetFile(dir, assetId, fileName, buffer, mimeType);
}
