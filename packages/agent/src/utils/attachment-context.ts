import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import type { FileAttachment } from '../types.js';

/**
 * Pasted text longer than this is not inlined into the prompt. Instead it is
 * persisted to `~/.duya/attachments/` and the prompt carries a file pointer so
 * the model can read the full content on demand — mirroring the Codex
 * attachments convention and preventing a single paste from blowing the
 * model's input window.
 */
export const MAX_INLINE_PASTE_LENGTH = 8000;

/**
 * Root directory for persisted pasted-text attachments. Mirrors the
 * `~/.duya/` convention used by skills, memory, and cache, and is already in
 * the agent's allowed-dirs set for `~/.duya`.
 */
export function getAttachmentsRootDir(): string {
  return path.join(os.homedir(), '.duya', 'attachments');
}

/**
 * Persist pasted-text attachments that exceed {@link MAX_INLINE_PASTE_LENGTH}
 * to disk under `rootDir` and return a rewrite of the attachments array where
 * each such attachment carries a `path` (and no inline `text`). Attachments
 * under the limit (and every non-pasted kind) are returned unchanged.
 *
 * On a write failure the attachment is returned untouched so the caller falls
 * back to the existing inline-truncation behavior instead of losing content.
 */
export async function persistLargePastedAttachments(
  attachments: readonly FileAttachment[],
  rootDir: string = getAttachmentsRootDir(),
): Promise<FileAttachment[]> {
  const prepared: FileAttachment[] = [];
  for (const att of attachments) {
    const text = typeof att.text === 'string' ? att.text : undefined;
    const isLargePasted =
      att.kind === 'pasted-text' && text !== undefined && text.length > MAX_INLINE_PASTE_LENGTH;
    if (!isLargePasted) {
      prepared.push(att);
      continue;
    }
    try {
      await fs.mkdir(rootDir, { recursive: true });
      const filePath = path.join(rootDir, `pasted-${att.id}.txt`);
      await fs.writeFile(filePath, text as string, 'utf8');
      prepared.push({ ...att, text: undefined, path: filePath, size: (text as string).length });
    } catch {
      // Fall back to inline (truncated) content when the write fails.
      prepared.push(att);
    }
  }
  return prepared;
}

/**
 * Return a human-readable location for an attachment without leaking
 * inline base64 data URLs into the prompt text. Base64 URLs are huge
 * and render as garbage in the chat UI, so we prefer the local file
 * path, a non-data URL, or the attachment name.
 */
function attachmentLocation(doc: FileAttachment): string {
  if (doc.path) return doc.path;
  if (doc.url && !doc.url.startsWith('data:')) return doc.url;
  return doc.name || '(unknown)';
}

/**
 * Build a text context string from file attachments for the LLM.
 * Assembled on-the-fly from the attachments field. Never persisted to DB.
 */
export function buildAttachmentContext(attachments: FileAttachment[]): string | null {
  const contextFiles = attachments.filter((f) => {
    const isImage = f.type.startsWith('image/');
    return isImage || !!f.path || !!f.text;
  });
  if (contextFiles.length === 0) return null;

  const sections: string[] = [];
  for (const doc of contextFiles) {
    const hasText = !!(doc.text);
    const hasImageChunks = !!(doc.imageChunks && doc.imageChunks.length > 0);
    const isImage = doc.type.startsWith('image/');

    // A pasted-text attachment that was persisted to disk (handled by
    // `persistLargePastedAttachments`) carries a path but no inline text.
    // Surface the file pointer instead of the full body so the model can read
    // it on demand.
    if (doc.kind === 'pasted-text' && !hasText && !!doc.path) {
      const lines: string[] = [];
      lines.push('[System Attached File - Pasted Text]');
      lines.push('The pasted text is too large to inline and was saved to a file on disk.');
      lines.push(`Path: ${doc.path}`);
      lines.push('Read the file when you need the full content. Do not ask the user to resend it.');
      sections.push(lines.join('\n'));
      continue;
    }

    if (!hasText && !isImage) {
      const lines: string[] = [];
      lines.push('[System Attached File - Not Parsed]');
      lines.push(`Type: ${doc.type}`);
      lines.push(`Path: ${attachmentLocation(doc)}`);
      lines.push('Warning: This file was attached but has not been processed yet. Ask the user to wait for parsing to complete or to resend the file.');
      sections.push(lines.join('\n'));
      continue;
    }

    const lines: string[] = [];
    lines.push('[System Parsed File]');
    lines.push(`Type: ${doc.type}`);
    lines.push(`Path: ${attachmentLocation(doc)}`);

    if (isImage && !hasText) {
      lines.push('Note: This image file is attached in this message.');
      if (hasImageChunks) {
        lines.push(`Image screenshots: ${doc.imageChunks!.length} extracted image chunk(s) are attached in this message.`);
      }
    } else {
      const methodLabel = doc.extractMethod === 'vision' ? 'vision (OCR)' :
        doc.extractMethod === 'hybrid' ? 'hybrid' :
        doc.extractMethod === 'text' ? 'text' : 'auto';
      lines.push(`Extraction: system-parsed (${methodLabel})`);

      if (hasImageChunks) {
        lines.push(`Image screenshots: ${doc.imageChunks!.length} page screenshot(s) from this document are attached as images in this message.`);
      }

      if (hasText) {
        const truncated = (doc.text || '').length > 8000
          ? (doc.text || '').substring(0, 8000) + '\n... (truncated)'
          : (doc.text || '');
        lines.push('Content:');
        lines.push(truncated);
      }
    }

    sections.push(lines.join('\n'));
  }

  return sections.join('\n\n---\n\n') + '\n\n';
}
