import type { FileAttachment } from '../types.js';

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
