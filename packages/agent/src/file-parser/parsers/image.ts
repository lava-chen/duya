/**
 * image parser - PNG, JPEG, GIF, WebP
 *
 * Reuses the existing imageResizer utility so we stay consistent with
 * the rest of the agent's image handling. No text extracted; the
 * extractMethod is always 'vision'.
 */

import { readFile } from 'node:fs/promises';
import { resizeImageBuffer } from '../../utils/imageResizer.js';
import type { RawParse } from '../types.js';

const THUMBNAIL_TARGET_BYTES = 200 * 1024; // 200 KB

export class ImageParser {
  async parse(filePath: string): Promise<RawParse> {
    const buffer = await readFile(filePath);
    if (buffer.length === 0) {
      throw new Error(`Image file is empty: ${filePath}`);
    }

    // Main image: respect LLM vision limits from existing util
    const main = await resizeImageBuffer(buffer);
    const mainBase64 = main.buffer.toString('base64');
    const mediaType = main.mediaType;

    // Thumbnail: smaller variant for UI preview
    const thumb = await resizeImageBuffer(buffer, THUMBNAIL_TARGET_BYTES, 300);

    return {
      text: '',
      images: [
        {
          base64: mainBase64,
          mediaType,
        },
      ],
      thumbnail: {
        base64: thumb.buffer.toString('base64'),
        mediaType: thumb.mediaType,
      },
      extractMethod: 'vision',
    };
  }
}
