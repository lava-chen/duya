import { readFile } from 'node:fs/promises';
import type { FileAttachment, MessageContent } from '../types.js';
import { needsResizing, resizeImageBuffer, TARGET_IMAGE_SIZE_BYTES } from './imageResizer.js';

export interface AttachmentImage {
  base64: string;
  mediaType: string;
}

export function isImageAttachment(file: FileAttachment): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('img/');
}

/** Keys are attachment objects: names and even legacy IDs need not be unique. */
export async function loadAttachmentImages(
  files: readonly FileAttachment[],
): Promise<Map<FileAttachment, AttachmentImage>> {
  const images = new Map<FileAttachment, AttachmentImage>();
  for (const file of files) {
    if (!isImageAttachment(file)) continue;
    try {
      let mediaType = file.type;
      let buffer: Buffer;
      if (file.url.startsWith('data:')) {
        const match = /^data:([^;,]+);base64,(.+)$/s.exec(file.url);
        if (!match) continue;
        mediaType = match[1];
        buffer = Buffer.from(match[2], 'base64');
      } else if ('base64' in file && typeof file.base64 === 'string') {
        buffer = Buffer.from(file.base64, 'base64');
      } else {
        const location = file.path || file.url;
        // Remote image loading is handled by the existing vision tool.
        if (!location || /^(https?:|blob:)/i.test(location)) continue;
        buffer = await readFile(location);
      }
      if (!buffer.length) continue;
      if (needsResizing(buffer)) {
        try {
          const resized = await resizeImageBuffer(buffer, TARGET_IMAGE_SIZE_BYTES);
          buffer = resized.buffer;
          mediaType = resized.mediaType;
        } catch {
          // Retain the readable original if resizing is unavailable.
        }
      }
      images.set(file, { base64: buffer.toString('base64'), mediaType });
    } catch {
      // Callers explain individual unavailable images in their attachment context.
    }
  }
  return images;
}

export function imageContentBlock(image: AttachmentImage): MessageContent {
  return { type: 'image', source: { type: 'base64', media_type: image.mediaType, data: image.base64 } };
}

/** Decode persisted attachments without allowing malformed entries to break a run. */
export function parseMailboxAttachments(json: string | null): FileAttachment[] {
  if (!json) return [];
  try {
    const value: unknown = JSON.parse(json);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is FileAttachment =>
      !!item && typeof item === 'object'
      && typeof item.id === 'string' && typeof item.name === 'string'
      && typeof item.type === 'string' && typeof item.url === 'string'
      && typeof item.size === 'number');
  } catch {
    return [];
  }
}
