import { BaseTool } from '../BaseTool.js';
import type { ToolResult, ToolUseContext } from '../contracts/tool.js';
import { NodeVisionAnalysisPort } from './node-port.js';
import type {
  ResolvedVisionImageSource,
  VisionAnalysisPort,
  VisionImageSourceRequest,
} from './ports.js';

const TOOL_NAME = 'vision_analyze';
const DESCRIPTION = 'Analyze the content of an image using an AI vision model. Accepts a local file path, a data URL, or reuses the most recent uploaded image attachment when no path is provided. Returns a detailed text description of objects, text, layout, and scene content.';

interface VisionImageAttachment {
  name: string;
  path?: string;
  url?: string;
  type: string;
}

interface VisionContextOptions {
  recentImageAttachments?: readonly VisionImageAttachment[];
  analyzeImage?: VisionAnalysisPort['analyzeImage'];
}

function getVisionContextOptions(context?: ToolUseContext): VisionContextOptions | undefined {
  return context?.options as (NonNullable<ToolUseContext['options']> & VisionContextOptions) | undefined;
}

function resolveRequestedSource(
  requestedSource: string,
  context?: ToolUseContext,
): { source: string; label: string; mimeType: string | null } | null {
  const recentImages = getVisionContextOptions(context)?.recentImageAttachments ?? [];

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

  return { source: requestedSource, label: requestedSource, mimeType: null };
}

function buildErrorGuidance(errMsg: string): string {
  const message = errMsg.toLowerCase();
  if (
    /401|403/.test(message) ||
    message.includes('unauthoriz') ||
    message.includes('auth') ||
    message.includes('invalid api key') ||
    message.includes('authentication')
  ) {
    return '视觉 provider 的 API key/凭据无效或已过期，请在 设置 > 视觉模型 检查凭据配置后再试';
  }
  if (/fetch failed|connection|econnrefused|enotfound|timeout|socket hang up/.test(message)) {
    return '无法连接视觉 provider（网络或端点配置问题），检查端点地址与网络后重试';
  }
  if (/429|rate|quota/.test(message)) {
    return '视觉 provider 限流或配额不足，稍后重试或改用多模态主模型';
  }
  return '请检查视觉 provider 配置（模型、端点、API key）与网络，确认无误后再试；不要盲目重试同一调用';
}

export class VisionTool extends BaseTool {
  readonly name = TOOL_NAME;
  readonly description = DESCRIPTION;
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

  constructor(private readonly analysisPort: VisionAnalysisPort = new NodeVisionAnalysisPort()) {
    super();
  }

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

    const analyzeImage = this.analysisPort.analyzeImage ?? getVisionContextOptions(context)?.analyzeImage;
    if (!analyzeImage) {
      return {
        id,
        name: this.name,
        result: 'Vision model is not configured or not available. Please configure a vision model in Settings > Vision Model to enable image analysis, or use a multimodal model that supports images natively.',
        error: true,
      };
    }

    try {
      const request: VisionImageSourceRequest = {
        source: resolvedSource.source,
        label: resolvedSource.label,
        hintedMimeType: resolvedSource.mimeType,
        ...(workingDirectory === undefined ? {} : { workingDirectory }),
      };
      const loaded: ResolvedVisionImageSource = await this.analysisPort.loadImageSource(request);

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

      let analysis: string;
      try {
        analysis = await analyzeImage(loaded.base64Data, loaded.mimeType, prompt);
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        const guidance = buildErrorGuidance(errorMessage);
        return {
          id,
          name: this.name,
          result: `Error: ${errorMessage}\n\nImage: ${loaded.resolvedPath || loaded.label} (${(loaded.fileSizeBytes / 1024).toFixed(1)} KB, ${loaded.mimeType})\n\n建议: ${guidance}`,
          error: true,
        };
      }

      const resultParts = [
        `Image analyzed: ${loaded.resolvedPath || loaded.label}`,
        `Format: ${loaded.mimeType} | Size: ${(loaded.fileSizeBytes / 1024).toFixed(1)} KB`,
      ];
      if (question) resultParts.push(`Question: ${question}`);
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

