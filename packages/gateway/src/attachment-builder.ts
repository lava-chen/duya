/**
 * Attachment builder for converting image buffers/paths to gateway file format
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const IMAGE_MAGIC_BYTES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'image/bmp': [0x42, 0x4d],
};

const EXT_MIME_MAP: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

export interface GatewayFileAttachment {
  name: string;
  type: string;
  url: string;
  size: number;
}

function detectMimeType(buffer: Buffer, filePath?: string): string | null {
  for (const [mime, magic] of Object.entries(IMAGE_MAGIC_BYTES)) {
    const matches = magic.every((byte, i) => buffer[i] === byte);
    if (matches) return mime;
  }
  if (filePath) {
    const ext = extname(filePath).toLowerCase();
    return EXT_MIME_MAP[ext] || null;
  }
  return null;
}

export async function buildImageAttachments(
  images?: Buffer[],
  imagePaths?: string[],
): Promise<GatewayFileAttachment[]> {
  const attachments: GatewayFileAttachment[] = [];

  if (images && images.length > 0) {
    for (let i = 0; i < images.length; i++) {
      const buffer = images[i];
      const mimeType = detectMimeType(buffer) || 'image/png';
      const base64 = buffer.toString('base64');
      attachments.push({
        name: `image_${i + 1}`,
        type: mimeType,
        url: `data:${mimeType};base64,${base64}`,
        size: buffer.length,
      });
    }
  }

  if (imagePaths && imagePaths.length > 0) {
    for (const imagePath of imagePaths) {
      try {
        const buffer = await readFile(imagePath);
        if (buffer.length > MAX_IMAGE_BYTES) {
          console.warn(`[GatewayManager] Skipping large image: ${imagePath} (${(buffer.length / (1024 * 1024)).toFixed(1)} MB)`);
          continue;
        }
        const mimeType = detectMimeType(buffer, imagePath) || 'image/png';
        const base64 = buffer.toString('base64');
        attachments.push({
          name: imagePath.split(/[/\\]/).pop() || 'image',
          type: mimeType,
          url: `data:${mimeType};base64,${base64}`,
          size: buffer.length,
        });
      } catch (err) {
        console.warn(`[GatewayManager] Failed to read image file: ${imagePath}`, err);
      }
    }
  }

  return attachments;
}