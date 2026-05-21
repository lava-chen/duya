/**
 * VisionTool - Analyze images using the configured vision model.
 *
 * This tool is invoked by the agent when it needs to understand image content,
 * for example screenshots it captured, user-uploaded images, or images found
 * in web pages.
 *
 * Design mirrors hermes-agent's vision_analyze: a dedicated vision model is
 * called via the analyzeImage callback (configured separately in Settings)
 * and the text description is returned as tool output.
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
  readonly description = `Analyze the content of an image using an AI vision model. Provide an image path to get a detailed text description of what the image contains — objects, people, text, colors, layout, and overall scene. Supports JPEG, PNG, GIF, WebP, and BMP formats. Use this tool whenever you need to understand the contents of an image file.`;

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: 'Absolute or relative path to the image file to analyze. Supports JPEG, PNG, GIF, WebP, BMP formats.',
      },
      question: {
        type: 'string',
        description: 'Optional: a specific question about the image to answer (e.g., "What is the error message shown?"). If omitted, a general description is returned.',
      },
    },
    required: ['image_path'],
  };

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
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
        return {
          id, name: this.name,
          result: `Error: Path is a directory, not a file: ${resolvedPath}`,
          error: true,
        };
      }

      if (fileStats.size === 0) {
        return {
          id, name: this.name,
          result: `Error: File is empty: ${resolvedPath}`,
          error: true,
        };
      }

      if (fileStats.size > MAX_IMAGE_BYTES) {
        return {
          id, name: this.name,
          result: `Error: Image too large (${(fileStats.size / (1024 * 1024)).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). Please compress and try again.`,
          error: true,
        };
      }

      const fileBuffer = await readFile(resolvedPath);
      const ext = resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase();
      const mimeType = detectMimeType(fileBuffer.subarray(0, 32), ext);

      if (!mimeType) {
        return {
          id, name: this.name,
          result: `Error: Unsupported image format. Supported: JPEG, PNG, GIF, WebP, BMP. File: ${resolvedPath}`,
          error: true,
        };
      }

      const base64Data = fileBuffer.toString('base64');

      const analyzeImage = context?.options?.analyzeImage;
      console.log('[VisionTool] analyzeImage callback:', analyzeImage ? 'present' : 'MISSING');
      console.log('[VisionTool] context.options:', JSON.stringify(Object.keys(context?.options || {})));
      if (!analyzeImage) {
        return {
          id, name: this.name,
          result: `Error: Vision model is not configured. Please configure a vision model in Settings > Vision Model to enable image analysis.`,
          error: true,
        };
      }

      const prompt = question
        ? `Answer the following question about this image: "${question}"\n\nProvide a clear and thorough answer based on what you see in the image.`
        : undefined;

      console.log('[VisionTool] Calling analyzeImage with:', {
        base64Length: base64Data.length,
        mimeType,
        hasPrompt: !!prompt,
        promptPreview: prompt?.substring(0, 100),
      });
      const analysis = await analyzeImage(base64Data, mimeType, prompt);
      console.log('[VisionTool] analyzeImage returned:', {
        analysisLength: analysis.length,
        analysisPreview: analysis.substring(0, 200),
      });

      if (!analysis) {
        console.log('[VisionTool] Analysis is empty, returning error');
        return {
          id, name: this.name,
          result: `Error: Vision model returned no analysis. Possible causes:\n`
            + `1. The configured vision model (Settings > Vision Model) may be unavailable or rate-limited\n`
            + `2. The vision model API returned an error (check DevTools console logs)\n`
            + `3. The image format (${mimeType}) may not be supported by the vision model\n`
            + `\nFile: ${resolvedPath} (${(fileStats.size / 1024).toFixed(1)} KB, ${mimeType})`,
          error: true,
        };
      }

      const resultParts: string[] = [];
      resultParts.push(`Image analyzed: ${resolvedPath}`);
      resultParts.push(`Format: ${mimeType} | Size: ${(fileStats.size / 1024).toFixed(1)} KB`);
      if (question) {
        resultParts.push(`Question: ${question}`);
      }
      resultParts.push(`\n${analysis}`);

      return {
        id,
        name: this.name,
        result: resultParts.join('\n'),
        metadata: {
          imagePath: resolvedPath,
          mimeType,
          imageSizeBytes: fileStats.size,
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