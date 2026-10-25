/**
 * Attachment recognition for pasted text and the clipboard.
 *
 * ## The three entrances
 *
 * minimax-code recognizes attachments at three entrances (terminal path
 * paste, Ctrl+V clipboard read, and image mentions). This module carries the
 * first two: a bracketed paste whose entire payload is a path to an
 * attachable file, and anything the clipboard hands over. The `@` completion
 * stays deliberately text-only — see the note in `candidates.ts`.
 *
 * ## Why path paste is restricted to images and documents
 *
 * A pasted path is ambiguous: "C:\repo\src\app.ts" may be a file the user
 * wants attached, or just text they are talking about. minimax-code resolves
 * the ambiguity narrowly — only media/document extensions become attachments,
 * everything else stays text (where `@` covers it). An explicit clipboard
 * file copy is not ambiguous, so the clipboard entrance accepts any file.
 */

import { randomUUID } from 'node:crypto';
import { stat } from 'node:fs/promises';
import { isAbsolute, posix, win32 } from 'node:path';
import type { FileAttachment } from '@duya/agent-protocol';

/** A file queued in the composer, before it is mapped onto the wire format. */
export interface TuiDraftAttachment {
  readonly id: string;
  readonly kind: 'image' | 'file';
  readonly name: string;
  readonly mimeType: string;
  readonly size: number;
  /** Absolute path; the worker reads the bytes from here. */
  readonly filePath: string;
  /** The chip label standing in for this attachment in the editor buffer. */
  readonly label: string;
}

/** minimax-code's limits: 10 attachments, 100 MB in total. */
export const MAX_ATTACHMENTS = 10;
export const MAX_TOTAL_ATTACHMENT_BYTES = 100 * 1024 * 1024;

const MIME_BY_EXTENSION: Readonly<Record<string, string>> = {
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.gif': 'image/gif',
  '.jpeg': 'image/jpeg',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.csv': 'text/csv',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.htm': 'text/html',
  '.html': 'text/html',
  '.json': 'application/json',
  '.log': 'text/plain',
  '.markdown': 'text/markdown',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.txt': 'text/plain',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.xml': 'application/xml',
  '.yaml': 'text/yaml',
  '.yml': 'text/yaml',
};

/** Extensions that a PASTED path may carry to become an attachment. */
const PASTEABLE_EXTENSIONS = new Set(Object.keys(MIME_BY_EXTENSION));

export function mimeTypeForExtension(filePath: string): string | null {
  const extension = posix.extname(filePath.replaceAll('\\', '/')).toLowerCase();
  return MIME_BY_EXTENSION[extension] ?? null;
}

/**
 * Strip one pair of matching surrounding quotes. Terminals wrap dragged
 * paths in quotes exactly when the path contains spaces, and Windows
 * "Copy as path" always does.
 */
export function stripSurroundingQuotes(value: string): string {
  if (value.length >= 2
    && ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith('\'') && value.endsWith('\'')))) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * The path candidate inside a pasted payload, or null when the paste does not
 * even LOOK like a single absolute path (the cheap synchronous test that
 * decides whether an async `stat` is worth firing at all).
 *
 * Unescaping `\ ` (a terminal drag escapes spaces on POSIX) mirrors
 * minimax-code's `getTuiTerminalImagePasteFallbackPath`.
 */
export function extractPathPasteCandidate(text: string): string | null {
  const trimmed = stripSurroundingQuotes(text.trim());
  if (trimmed === '' || /[\r\n]/u.test(trimmed)) return null;
  if (isAbsolute(trimmed) || win32.isAbsolute(trimmed) || posix.isAbsolute(trimmed.replaceAll('\\', '/'))) {
    return trimmed.replaceAll('\\ ', ' ');
  }
  return null;
}

/**
 * Resolve a pasted path into a draft attachment.
 *
 * Returns null when the file does not exist, is a directory, or carries an
 * extension outside the pasteable set — the caller then pastes the raw text
 * instead, which is the behaviour the user expects for non-attachment paths.
 */
export async function resolvePathAttachment(candidate: string): Promise<Omit<TuiDraftAttachment, 'label'> | null> {
  const mimeType = mimeTypeForExtension(candidate);
  if (mimeType === null) return null;
  let resolved: Awaited<ReturnType<typeof stat>>;
  try {
    resolved = await stat(candidate);
  } catch {
    return null;
  }
  if (!resolved.isFile()) return null;
  return {
    id: randomUUID(),
    kind: mimeType.startsWith('image/') ? 'image' : 'file',
    name: posix.basename(candidate.replaceAll('\\', '/')),
    mimeType,
    size: resolved.size,
    filePath: candidate,
  };
}

/**
 * Wrap a clipboard-provided file (any extension — an explicit file copy is
 * unambiguous intent) into a draft attachment.
 */
export async function resolveClipboardFileAttachment(
  filePath: string,
  mimeType: string | null,
): Promise<Omit<TuiDraftAttachment, 'label'> | null> {
  let resolved: Awaited<ReturnType<typeof stat>>;
  try {
    resolved = await stat(filePath);
  } catch {
    return null;
  }
  if (!resolved.isFile()) return null;
  const type = mimeType ?? 'application/octet-stream';
  return {
    id: randomUUID(),
    kind: type.startsWith('image/') ? 'image' : 'file',
    name: posix.basename(filePath.replaceAll('\\', '/')),
    mimeType: type,
    size: resolved.size,
    filePath,
  };
}

/**
 * The chip label. `seq` is in the label for the same reason the paste
 * placeholder carries it: two attachments of the same file (or two files
 * with identical names from different directories) must not share a label,
 * or one would shadow the other in the submit filter.
 */
export function attachmentChipLabel(attachment: Omit<TuiDraftAttachment, 'label'>, seq: number): string {
  const noun = attachment.kind === 'image' ? 'Image' : 'File';
  return `[${noun} #${seq} ${attachment.name}]`;
}

/** The first limit the current draft violates, or null when it is within bounds. */
export function findAttachmentLimitViolation(
  attachments: readonly TuiDraftAttachment[],
  incomingBytes: number,
): 'count' | 'total-size' | null {
  if (attachments.length >= MAX_ATTACHMENTS) return 'count';
  const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (total + incomingBytes > MAX_TOTAL_ATTACHMENT_BYTES) return 'total-size';
  return null;
}

/**
 * Map the draft onto the protocol's wire format.
 *
 * `url` carries the path for the same reason `path` does — the worker reads
 * local images from `path || url` (`worker-context/attachment-images.ts`) and
 * renders file context from the same location, so both fields state one fact.
 */
export function toFileAttachments(attachments: readonly Omit<TuiDraftAttachment, 'label'>[]): FileAttachment[] {
  return attachments.map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    name: attachment.name,
    type: attachment.mimeType,
    url: attachment.filePath,
    size: attachment.size,
    path: attachment.filePath,
  }));
}

/**
 * Keep only the attachments whose chip label survived in the submitted text.
 *
 * This is the whole "delete the chip to drop the attachment" semantic: the
 * label is plain buffer text, so a user edit (or an undo, or a cleared
 * buffer) that removed it also removes the attachment — no interval mapping
 * in the editor, which stays a plain text buffer.
 */
export function takeAttachmentsForSubmit(
  attachments: readonly TuiDraftAttachment[],
  submittedText: string,
): FileAttachment[] {
  return toFileAttachments(attachments.filter((attachment) => submittedText.includes(attachment.label)));
}
