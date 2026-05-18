import type { FileAttachment } from '../types.js';

/**
 * Build a text context string from file attachments for the LLM.
 * Assembled on-the-fly from the attachments field. Never persisted to DB.
 */
export function buildAttachmentContext(attachments: FileAttachment[]): string | null {
  const docFiles = attachments.filter(f => f.path || f.text);
  if (docFiles.length === 0) return null;

  const sections: string[] = [];
  for (const doc of docFiles) {
    const hasText = !!(doc.text);
    const hasImageChunks = !!(doc.imageChunks && doc.imageChunks.length > 0);
    const isImage = doc.type.startsWith('image/');

    if (!hasText && !isImage) continue;

    const lines: string[] = [];
    lines.push('[System Parsed File]');
    lines.push(`Type: ${doc.type}`);
    lines.push(`Path: ${doc.path || doc.url || doc.name || '(unknown)'}`);

    if (isImage && !hasText) {
      lines.push('Note: This image file is attached as an image in this message.');
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