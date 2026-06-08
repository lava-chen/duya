/**
 * chunker - paragraph-aware text chunking with overlap
 *
 * Ported from electron/services/document-parser/sidecar/registry.py:chunk_text
 * Behavior is preserved so the downstream IPC contract stays identical.
 */

import { TEXT_CHUNK_MAX_SIZE, TEXT_CHUNK_OVERLAP } from './types.js';

const PARAGRAPH_SEP = '\n\n';

export function chunkText(
  text: string,
  maxChunkSize: number = TEXT_CHUNK_MAX_SIZE,
  overlap: number = TEXT_CHUNK_OVERLAP,
): Array<{ type: 'text'; index: number; text: string }> {
  if (!text) {
    return [{ type: 'text', index: 0, text: '' }];
  }

  const chunks: Array<{ type: 'text'; index: number; text: string }> = [];
  const paragraphs = text.split(PARAGRAPH_SEP);
  let current = '';
  let index = 0;

  for (const para of paragraphs) {
    if (current.length + para.length + PARAGRAPH_SEP.length <= maxChunkSize) {
      current = current ? `${current}${PARAGRAPH_SEP}${para}` : para;
      continue;
    }

    // Flush current chunk first
    if (current) {
      chunks.push({ type: 'text', index: index++, text: current });
      const overlapText =
        current.length > overlap ? current.slice(-overlap) : current;
      // Drop overlap when next paragraph doesn't continue the same tail
      current = para.startsWith(overlapText) ? para : overlapText + para;
    } else {
      // Single paragraph longer than maxChunkSize — hard split
      let start = 0;
      while (start < para.length) {
        const end = Math.min(start + maxChunkSize, para.length);
        chunks.push({ type: 'text', index: index++, text: para.slice(start, end) });
        start = end - (end < para.length ? overlap : 0);
      }
      current = '';
    }
  }

  if (current) {
    chunks.push({ type: 'text', index: index++, text: current });
  }

  return chunks;
}
