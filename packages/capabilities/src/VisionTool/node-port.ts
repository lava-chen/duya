import { readFile, stat } from 'node:fs/promises';
import { expandPath } from '../utils/path.js';
import type {
  ResolvedVisionImageSource,
  VisionAnalysisPort,
  VisionImageSourceRequest,
} from './ports.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MAGIC_BYTES: Record<string, Buffer> = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/gif': Buffer.from([0x47, 0x49, 0x46, 0x38]),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  'image/bmp': Buffer.from([0x42, 0x4d]),
};

function detectMimeType(header: Buffer, extension: string): string | null {
  if (header.subarray(0, 8).equals(MAGIC_BYTES['image/png'])) return 'image/png';
  if (header.subarray(0, 3).equals(MAGIC_BYTES['image/jpeg'])) return 'image/jpeg';
  if (header.subarray(0, 4).equals(MAGIC_BYTES['image/gif'])) return 'image/gif';
  if (header.subarray(0, 4).equals(MAGIC_BYTES['image/webp'])) return 'image/webp';
  if (header.subarray(0, 2).equals(MAGIC_BYTES['image/bmp'])) return 'image/bmp';
  if (['.jpg', '.jpeg'].includes(extension)) return 'image/jpeg';
  if (extension === '.png') return 'image/png';
  if (extension === '.gif') return 'image/gif';
  if (extension === '.webp') return 'image/webp';
  if (extension === '.bmp') return 'image/bmp';
  return null;
}

function parseDataUrl(input: string): { mimeType: string; base64Data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(input);
  if (!match) return null;
  const [, mimeType, base64Data] = match;
  if (!mimeType || !base64Data) return null;
  return { mimeType, base64Data };
}

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

/** Node-backed image loading; the capability tool depends on this port only. */
export class NodeVisionAnalysisPort implements VisionAnalysisPort {
  async loadImageSource(request: VisionImageSourceRequest): Promise<ResolvedVisionImageSource> {
    const { source, label, hintedMimeType, workingDirectory } = request;
    const parsedDataUrl = parseDataUrl(source);
    if (parsedDataUrl) {
      const fileSizeBytes = Buffer.from(parsedDataUrl.base64Data, 'base64').length;
      return {
        label,
        resolvedPath: null,
        base64Data: parsedDataUrl.base64Data,
        mimeType: parsedDataUrl.mimeType || hintedMimeType,
        fileSizeBytes,
      };
    }

    if (isHttpUrl(source)) {
      const response = await fetch(source);
      if (!response.ok) {
        throw new Error(`Failed to fetch image URL: ${response.status} ${response.statusText}`);
      }

      const fileBuffer = Buffer.from(await response.arrayBuffer());
      const fileSizeBytes = fileBuffer.length;
      if (fileSizeBytes === 0) throw new Error(`Fetched image is empty: ${source}`);
      if (fileSizeBytes > MAX_IMAGE_BYTES) {
        throw new Error(`Image too large (${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). Please compress and try again.`);
      }

      const pathname = (() => {
        try {
          return new URL(source).pathname.toLowerCase();
        } catch {
          return '';
        }
      })();
      const extension = pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : '';
      const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || null;
      const mimeType = detectMimeType(fileBuffer.subarray(0, 32), extension) || contentType || hintedMimeType;

      return {
        label,
        resolvedPath: source,
        base64Data: fileBuffer.toString('base64'),
        mimeType,
        fileSizeBytes,
      };
    }

    const resolvedPath = expandPath(source, workingDirectory);
    const fileStats = await stat(resolvedPath);
    if (fileStats.isDirectory()) throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
    if (fileStats.size === 0) throw new Error(`File is empty: ${resolvedPath}`);
    if (fileStats.size > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${(fileStats.size / (1024 * 1024)).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). Please compress and try again.`);
    }

    const fileBuffer = await readFile(resolvedPath);
    const extension = resolvedPath.includes('.')
      ? resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase()
      : '';
    const mimeType = detectMimeType(fileBuffer.subarray(0, 32), extension) || hintedMimeType;
    return {
      label,
      resolvedPath,
      base64Data: fileBuffer.toString('base64'),
      mimeType,
      fileSizeBytes: fileStats.size,
    };
  }
}
