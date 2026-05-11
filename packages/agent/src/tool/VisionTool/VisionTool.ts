/**
 * VisionTool - Read and encode image files for vision model analysis
 * Supports local image files and returns base64-encoded data URLs
 */

import { readFile, stat } from 'node:fs/promises';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { expandPath } from '../../utils/path.js';

const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

const MAGIC_BYTES: Record<string, Buffer> = {
  'image/png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  'image/jpeg': Buffer.from([0xff, 0xd8, 0xff]),
  'image/gif': Buffer.from([0x47, 0x49, 0x46, 0x38]),
  'image/webp': Buffer.from([0x52, 0x49, 0x46, 0x46]),
  'image/bmp': Buffer.from([0x42, 0x4d]),
};

function detectMimeType(header: Buffer, ext: string): string | null {
  if (header.subarray(0, 8).equals(MAGIC_BYTES['image/png'])) return 'image/png';
  if (header.subarray(0, 3).equals(MAGIC_BYTES['image/jpeg'])) return 'image/jpeg';
  if (header.subarray(0, 4).equals(MAGIC_BYTES['image/gif'])) return 'image/gif';
  if (header.subarray(0, 4).equals(MAGIC_BYTES['image/webp'])) return 'image/webp';
  if (header.subarray(0, 2).equals(MAGIC_BYTES['image/bmp'])) return 'image/bmp';
  if (['.jpg', '.jpeg'].includes(ext)) return 'image/jpeg';
  if (ext === '.png') return 'image/png';
  if (ext === '.gif') return 'image/gif';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.bmp') return 'image/bmp';
  return null;
}

export class VisionTool implements Tool, ToolExecutor {
  readonly name = 'vision_analyze';
  readonly description = `Analyze images using AI vision. Provides a comprehensive description and answers specific questions about the image content. Supports JPEG, PNG, GIF, WebP, and BMP image formats.`;

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: 'Absolute or relative path to the image file to analyze. Supports JPEG, PNG, GIF, WebP, BMP formats.',
      },
      question: {
        type: 'string',
        description: 'A specific question about the image content to answer.',
      },
    },
    required: ['image_path'],
  };

  async execute(input: Record<string, unknown>, workingDirectory?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const imagePath = input.image_path as string;
    const question = input.question as string | undefined;

    if (!imagePath) {
      return { id, name: this.name, result: 'Error: image_path is required', error: true };
    }

    try {
      const resolvedPath = expandPath(imagePath, workingDirectory);
      const fileStats = await stat(resolvedPath);

      if (fileStats.isDirectory()) {
        return { id, name: this.name, result: `Error: Path is a directory, not a file: ${resolvedPath}`, error: true };
      }

      if (fileStats.size > MAX_IMAGE_BYTES) {
        return {
          id,
          name: this.name,
          result: `Error: Image file too large (${(fileStats.size / (1024 * 1024)).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). Please compress the image and try again.`,
          error: true,
        };
      }

      const fileBuffer = await readFile(resolvedPath);
      const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();

      const mimeType = detectMimeType(fileBuffer.subarray(0, 32), ext);
      if (!mimeType) {
        return {
          id,
          name: this.name,
          result: `Error: Unsupported image format. Supported formats: JPEG, PNG, GIF, WebP, BMP. File: ${resolvedPath}`,
          error: true,
        };
      }

      const base64Data = fileBuffer.toString('base64');
      const dataUrl = `data:${mimeType};base64,${base64Data}`;

      let resultText = `Image analyzed: ${resolvedPath}\n`;
      resultText += `Format: ${mimeType}\n`;
      resultText += `Size: ${(fileStats.size / 1024).toFixed(1)} KB\n`;

      if (question) {
        resultText += `Question: ${question}\n`;
      }

      resultText += `\nImage data (base64 data URL):\n${dataUrl}\n`;
      resultText += `\n[Vision analysis requires a vision-capable model. If your model supports vision, ensure it is configured as the primary model with vision capabilities.]`;

      return {
        id,
        name: this.name,
        result: resultText,
        metadata: {
          imagePath: resolvedPath,
          mimeType,
          imageSizeBytes: fileStats.size,
          durationMs: 0,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return {
        id,
        name: this.name,
        result: `Error analyzing image: ${errorMessage}`,
        error: true,
      };
    }
  }
}