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

type ResolvedImageSource = {
  label: string;
  resolvedPath: string | null;
  base64Data: string;
  mimeType: string | null;
  fileSizeBytes: number;
};

function isHttpUrl(input: string): boolean {
  return /^https?:\/\//i.test(input);
}

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

function parseDataUrl(input: string): { mimeType: string; base64Data: string } | null {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(input);
  if (!match) return null;
  const [, mimeType, base64Data] = match;
  if (!mimeType || !base64Data) return null;
  return { mimeType, base64Data };
}

function resolveRequestedSource(
  requestedSource: string,
  context?: ToolUseContext,
): { source: string; label: string; mimeType: string | null } | null {
  const recentImages = context?.options?.recentImageAttachments ?? [];

  if (!requestedSource) {
    const latest = recentImages[0];
    if (!latest) return null;
    return {
      source: latest.path || latest.url || '',
      label: latest.name || latest.path || latest.url || 'recent uploaded image',
      mimeType: latest.type || null,
    };
  }

  const matchedRecent = recentImages.find((item) =>
    item.name === requestedSource || item.path === requestedSource || item.url === requestedSource,
  );

  if (matchedRecent) {
    return {
      source: matchedRecent.path || matchedRecent.url || requestedSource,
      label: matchedRecent.name || requestedSource,
      mimeType: matchedRecent.type || null,
    };
  }

  return {
    source: requestedSource,
    label: requestedSource,
    mimeType: null,
  };
}

async function loadImageSource(
  imageSource: string,
  label: string,
  hintedMimeType: string | null,
  workingDirectory?: string,
): Promise<ResolvedImageSource> {
  const parsedDataUrl = parseDataUrl(imageSource);
  if (parsedDataUrl) {
    const fileSizeBytes = Buffer.from(parsedDataUrl.base64Data, 'base64').length;
    return {
      label,
      resolvedPath: null,
      base64Data: parsedDataUrl.base64Data,
      mimeType: parsedDataUrl.mimeType || hintedMimeType,
      fileSizeBytes,
    };
  }

  if (isHttpUrl(imageSource)) {
    const response = await fetch(imageSource);
    if (!response.ok) {
      throw new Error(`Failed to fetch image URL: ${response.status} ${response.statusText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    const fileBuffer = Buffer.from(arrayBuffer);
    const fileSizeBytes = fileBuffer.length;

    if (fileSizeBytes === 0) {
      throw new Error(`Fetched image is empty: ${imageSource}`);
    }

    if (fileSizeBytes > MAX_IMAGE_BYTES) {
      throw new Error(`Image too large (${(fileSizeBytes / (1024 * 1024)).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). Please compress and try again.`);
    }

    const pathname = (() => {
      try {
        return new URL(imageSource).pathname.toLowerCase();
      } catch {
        return '';
      }
    })();
    const ext = pathname.includes('.') ? pathname.slice(pathname.lastIndexOf('.')) : '';
    const contentType = response.headers.get('content-type')?.split(';')[0]?.trim() || null;
    const mimeType = detectMimeType(fileBuffer.subarray(0, 32), ext) || contentType || hintedMimeType;

    return {
      label,
      resolvedPath: imageSource,
      base64Data: fileBuffer.toString('base64'),
      mimeType,
      fileSizeBytes,
    };
  }

  const resolvedPath = expandPath(imageSource, workingDirectory);
  const fileStats = await stat(resolvedPath);

  if (fileStats.isDirectory()) {
    throw new Error(`Path is a directory, not a file: ${resolvedPath}`);
  }

  if (fileStats.size === 0) {
    throw new Error(`File is empty: ${resolvedPath}`);
  }

  if (fileStats.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image too large (${(fileStats.size / (1024 * 1024)).toFixed(1)} MB, max ${MAX_IMAGE_BYTES / (1024 * 1024)} MB). Please compress and try again.`);
  }

  const fileBuffer = await readFile(resolvedPath);
  const ext = resolvedPath.includes('.') ? resolvedPath.slice(resolvedPath.lastIndexOf('.')).toLowerCase() : '';
  const mimeType = detectMimeType(fileBuffer.subarray(0, 32), ext) || hintedMimeType;

  return {
    label,
    resolvedPath,
    base64Data: fileBuffer.toString('base64'),
    mimeType,
    fileSizeBytes: fileStats.size,
  };
}

export class VisionTool implements Tool, ToolExecutor {
  readonly name = 'vision_analyze';
  readonly description = 'Analyze the content of an image using an AI vision model. Accepts a local file path, a data URL, or reuses the most recent uploaded image attachment when no path is provided. Returns a detailed text description of objects, text, layout, and scene content.';

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      image_path: {
        type: 'string',
        description: 'Optional. Absolute or relative path to the image file, or a data URL. If omitted, the tool analyzes the most recent uploaded image attachment in the conversation.',
      },
      question: {
        type: 'string',
        description: 'Optional: a specific question about the image to answer (e.g., "What is the error message shown?"). If omitted, a general description is returned.',
      },
    },
  };

  async execute(
    input: Record<string, unknown>,
    workingDirectory?: string,
    context?: ToolUseContext,
  ): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const requestedSource = typeof input.image_path === 'string' ? input.image_path.trim() : '';
    const question = input.question as string | undefined;

    const resolvedSource = resolveRequestedSource(requestedSource, context);
    if (!resolvedSource || !resolvedSource.source) {
      return {
        id,
        name: this.name,
        result: 'Error: No image source was provided and no recent uploaded image attachment is available in this conversation.',
        error: true,
      };
    }

    const analyzeImage = context?.options?.analyzeImage;
    if (!analyzeImage) {
      return {
        id,
        name: this.name,
        result: 'Vision model is not configured or not available. Please configure a vision model in Settings > Vision Model to enable image analysis, or use a multimodal model that supports images natively.',
        error: true,
      };
    }

    try {
      const loaded = await loadImageSource(
        resolvedSource.source,
        resolvedSource.label,
        resolvedSource.mimeType,
        workingDirectory,
      );

      if (!loaded.mimeType) {
        return {
          id,
          name: this.name,
          result: `Error: Unsupported image format. Supported: JPEG, PNG, GIF, WebP, BMP. Source: ${loaded.resolvedPath || loaded.label}`,
          error: true,
        };
      }

      const prompt = question
        ? `Answer the following question about this image: "${question}"\n\nProvide a clear and thorough answer based on what you see in the image.`
        : undefined;

      console.log('[VisionTool] Calling analyzeImage with:', {
        source: loaded.resolvedPath || loaded.label,
        base64Length: loaded.base64Data.length,
        mimeType: loaded.mimeType,
        hasPrompt: !!prompt,
        promptPreview: prompt?.substring(0, 100),
      });

      let analysis: string;
      try {
        analysis = await analyzeImage(loaded.base64Data, loaded.mimeType, prompt);
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        console.log('[VisionTool] analyzeImage threw error:', errMsg);
        return {
          id,
          name: this.name,
          result: `Error: ${errMsg}\n\nImage: ${loaded.resolvedPath || loaded.label} (${(loaded.fileSizeBytes / 1024).toFixed(1)} KB, ${loaded.mimeType})`,
          error: true,
        };
      }

      console.log('[VisionTool] analyzeImage returned:', {
        analysisLength: analysis.length,
        analysisPreview: analysis.substring(0, 200),
      });

      const resultParts: string[] = [];
      resultParts.push(`Image analyzed: ${loaded.resolvedPath || loaded.label}`);
      resultParts.push(`Format: ${loaded.mimeType} | Size: ${(loaded.fileSizeBytes / 1024).toFixed(1)} KB`);
      if (question) {
        resultParts.push(`Question: ${question}`);
      }
      resultParts.push(`\n${analysis}`);

      return {
        id,
        name: this.name,
        result: resultParts.join('\n'),
        metadata: {
          imagePath: loaded.resolvedPath || loaded.label,
          mimeType: loaded.mimeType,
          imageSizeBytes: loaded.fileSizeBytes,
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
