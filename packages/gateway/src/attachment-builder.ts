/**
 * Attachment builder for converting image/file/voice/video buffers and paths
 * to gateway file format (base64 data URLs).
 *
 * Image MIME detection uses magic bytes first, falling back to extension lookup.
 * Non-image attachments rely on extension-based MIME detection.
 */

import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';

const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOC_BYTES = 20 * 1024 * 1024;
const MAX_AUDIO_VIDEO_BYTES = 25 * 1024 * 1024;

const IMAGE_MAGIC_BYTES: Record<string, number[]> = {
  'image/png': [0x89, 0x50, 0x4e, 0x47],
  'image/jpeg': [0xff, 0xd8, 0xff],
  'image/gif': [0x47, 0x49, 0x46, 0x38],
  'image/webp': [0x52, 0x49, 0x46, 0x46],
  'image/bmp': [0x42, 0x4d],
};

// Expanded MIME map by file extension
const EXT_MIME_MAP: Record<string, string> = {
  // images
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  // documents
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.md': 'text/markdown',
  // audio
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.m4a': 'audio/mp4',
  // video
  '.mp4': 'video/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  // archives
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

// Reverse lookup from MIME type to preferred extension.
const MIME_EXT_MAP: Record<string, string> = Object.fromEntries(
  Object.entries(EXT_MIME_MAP).map(([ext, mime]) => [mime, ext])
);

export interface GatewayFileAttachment {
  id?: string;
  name: string;
  type: string;
  url: string;
  size: number;
}

export interface BuildAttachmentsInput {
  images?: Buffer[];
  imagePaths?: string[];
  files?: Array<{ name: string; buffer: Buffer }>;
  filePaths?: Array<{ name: string; path: string }>;
  voicePaths?: string[];
  videoPaths?: string[];
}

function getMimeByExtension(filePath?: string): string | null {
  if (!filePath) return null;
  const ext = extname(filePath).toLowerCase();
  return EXT_MIME_MAP[ext] || null;
}

function detectMimeType(buffer: Buffer, filePath?: string): string | null {
  // Magic-byte detection only applies to images.
  for (const [mime, magic] of Object.entries(IMAGE_MAGIC_BYTES)) {
    const matches = magic.every((byte, i) => buffer[i] === byte);
    if (matches) return mime;
  }
  return getMimeByExtension(filePath);
}

function ensureExtension(name: string, mimeType: string): string {
  const existingExt = extname(name).toLowerCase();
  if (existingExt) return name;
  const ext = MIME_EXT_MAP[mimeType];
  return ext ? `${name}${ext}` : name;
}

function bufferToAttachment(
  buffer: Buffer,
  name: string,
  filePath?: string,
): GatewayFileAttachment {
  const mimeType = detectMimeType(buffer, filePath) || 'application/octet-stream';
  const base64 = buffer.toString('base64');
  return {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
    name: ensureExtension(name, mimeType),
    type: mimeType,
    url: `data:${mimeType};base64,${base64}`,
    size: buffer.length,
  };
}

async function readFileToAttachment(
  filePath: string,
  name?: string,
  maxSize: number = MAX_DOC_BYTES,
): Promise<GatewayFileAttachment | null> {
  try {
    const buffer = await readFile(filePath);
    if (buffer.length > maxSize) {
      console.warn(
        `[GatewayManager] Skipping large file: ${filePath} ` +
          `(${(buffer.length / (1024 * 1024)).toFixed(1)} MB > ${(maxSize / (1024 * 1024)).toFixed(1)} MB)`,
      );
      return null;
    }
    const fileName = name || filePath.split(/[/\\]/).pop() || 'file';
    return bufferToAttachment(buffer, fileName, filePath);
  } catch (err) {
    console.warn(`[GatewayManager] Failed to read file: ${filePath}`, err);
    return null;
  }
}

/**
 * Build attachments from all NormalizedMessage attachment fields
 * (images, imagePaths, files, filePaths, voicePaths, videoPaths).
 *
 * Each field is subject to its own size limit; oversized entries are
 * skipped with a warning rather than aborting the whole batch.
 */
export async function buildAttachments(
  input: BuildAttachmentsInput,
): Promise<GatewayFileAttachment[]> {
  const attachments: GatewayFileAttachment[] = [];

  // 1. images (Buffer[]) — in-memory image buffers
  if (input.images && input.images.length > 0) {
    for (let i = 0; i < input.images.length; i++) {
      const buffer = input.images[i];
      if (buffer.length > MAX_IMAGE_BYTES) {
        console.warn(
          `[GatewayManager] Skipping large image buffer #${i + 1} ` +
            `(${(buffer.length / (1024 * 1024)).toFixed(1)} MB > ${(MAX_IMAGE_BYTES / (1024 * 1024)).toFixed(1)} MB)`,
        );
        continue;
      }
      attachments.push(bufferToAttachment(buffer, `image_${i + 1}`));
    }
  }

  // 2. imagePaths (string[]) — image files on disk
  if (input.imagePaths && input.imagePaths.length > 0) {
    for (const imagePath of input.imagePaths) {
      const attachment = await readFileToAttachment(imagePath, undefined, MAX_IMAGE_BYTES);
      if (attachment) attachments.push(attachment);
    }
  }

  // 3. files ({name, buffer}[]) — in-memory document/file buffers
  if (input.files && input.files.length > 0) {
    for (const file of input.files) {
      if (file.buffer.length > MAX_DOC_BYTES) {
        console.warn(
          `[GatewayManager] Skipping large file buffer: ${file.name} ` +
            `(${(file.buffer.length / (1024 * 1024)).toFixed(1)} MB > ${(MAX_DOC_BYTES / (1024 * 1024)).toFixed(1)} MB)`,
        );
        continue;
      }
      attachments.push(bufferToAttachment(file.buffer, file.name));
    }
  }

  // 4. filePaths ({name, path}[]) — document/file paths on disk
  if (input.filePaths && input.filePaths.length > 0) {
    for (const fileEntry of input.filePaths) {
      const attachment = await readFileToAttachment(fileEntry.path, fileEntry.name, MAX_DOC_BYTES);
      if (attachment) attachments.push(attachment);
    }
  }

  // 5. voicePaths (string[]) — audio file paths
  if (input.voicePaths && input.voicePaths.length > 0) {
    for (const voicePath of input.voicePaths) {
      const attachment = await readFileToAttachment(voicePath, undefined, MAX_AUDIO_VIDEO_BYTES);
      if (attachment) attachments.push(attachment);
    }
  }

  // 6. videoPaths (string[]) — video file paths
  if (input.videoPaths && input.videoPaths.length > 0) {
    for (const videoPath of input.videoPaths) {
      const attachment = await readFileToAttachment(videoPath, undefined, MAX_AUDIO_VIDEO_BYTES);
      if (attachment) attachments.push(attachment);
    }
  }

  return attachments;
}

/**
 * @deprecated Use {@link buildAttachments} instead. Kept for backward
 *   compatibility with callers that only need image attachments.
 */
export async function buildImageAttachments(
  images?: Buffer[],
  imagePaths?: string[],
): Promise<GatewayFileAttachment[]> {
  return buildAttachments({ images, imagePaths });
}
