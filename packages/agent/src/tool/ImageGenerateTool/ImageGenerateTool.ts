/**
 * ImageGenerateTool (plan image-gen).
 *
 * Generates images from a text prompt through a configurable provider
 * (`[image_generation]` in ~/.duya/config.toml: openai Images API or
 * fal.ai). Registered with `exposeMode: 'discoverable'` — it is NOT on
 * the default tool surface; the model reaches it via `tool_search`.
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { getImageGenerationConfig } from './image-generation-config.js';
import { generateImage, ImageGenerationError } from './provider.js';

export const IMAGE_GENERATE_TOOL_NAME = 'image_generate';

export const DESCRIPTION = `Generate an image from a text prompt using the configured image generation provider (OpenAI Images API or fal.ai). Use when the user asks for an image, illustration, logo, icon, meme, banner, or any visual asset described in text. Also supports editing a reference image (OpenAI models) by passing reference_image. The image is saved to disk and the returned file path can be shown to the user, embedded via data URL, or attached to a message.`;

const INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  properties: {
    prompt: {
      type: 'string',
      description:
        'Detailed description of the image to generate. Include subject, style, composition, colors, and mood for best results.',
    },
    size: {
      type: 'string',
      description:
        'Optional output size, e.g. "1024x1024", "1024x1536", "1536x1024". Defaults to [image_generation] size in config.toml.',
    },
    quality: {
      type: 'string',
      enum: ['auto', 'low', 'medium', 'high'],
      description: 'Optional quality hint (OpenAI gpt-image series). Defaults to config.',
    },
    reference_image: {
      type: 'string',
      description:
        'Optional path, http(s) URL, or data URL of a reference image to edit or vary (OpenAI models only).',
    },
    output_path: {
      type: 'string',
      description:
        'Optional absolute output directory. Defaults to [image_generation] output_dir or ~/.duya/media/generated.',
    },
  },
  required: ['prompt'],
};

function getPrompt(): string {
  return `## image_generate usage guide

The image_generate tool creates images from text prompts via the provider configured under [image_generation] in ~/.duya/config.toml.

- Call it with a detailed \`prompt\` (subject, style, composition, colors). The more specific the prompt, the better the result.
- \`size\` and \`quality\` are optional per-call overrides; the config.toml values are the defaults.
- \`reference_image\` enables editing/variation on OpenAI gpt-image models: pass a local path, URL, or data URL.
- The tool persists the image under output_dir (default ~/.duya/media/generated) and returns the absolute file path plus dimensions.
- After generation, show the user the saved path; you may embed the image in a widget via a data URL (the widget CSP blocks file:// paths).
- If the tool reports a configuration error, the user must enable [image_generation] (enabled = true) and set an API key before retrying — do not loop on the same call.`;
}

export class ImageGenerateTool implements Tool, ToolExecutor {
  readonly name = IMAGE_GENERATE_TOOL_NAME;
  readonly description = DESCRIPTION;
  readonly input_schema = INPUT_SCHEMA;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  getPrompt(): string {
    return getPrompt();
  }

  async execute(
    input: Record<string, unknown>,
    _workingDirectory?: string,
  ): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : '';
    const size = typeof input.size === 'string' && input.size.trim() ? input.size.trim() : undefined;
    const quality =
      typeof input.quality === 'string' && ['auto', 'low', 'medium', 'high'].includes(input.quality)
        ? (input.quality as 'auto' | 'low' | 'medium' | 'high')
        : undefined;
    const referenceImage =
      typeof input.reference_image === 'string' && input.reference_image.trim()
        ? input.reference_image.trim()
        : undefined;
    const outputPath =
      typeof input.output_path === 'string' && input.output_path.trim() ? input.output_path.trim() : undefined;

    try {
      const config = getImageGenerationConfig();
      const generated = await generateImage(config, {
        prompt,
        size,
        quality,
        referenceImage,
        outputDir: outputPath,
      });

      const lines = [
        `Image generated: ${generated.filePath}`,
        `Provider: ${generated.provider} | Model: ${generated.model}`,
        `Size: ${generated.width && generated.height ? `${generated.width}x${generated.height}px` : config.size} | ${(generated.bytes / 1024).toFixed(1)} KB | ${generated.mimeType}`,
        `Took ${generated.durationMs} ms`,
      ];

      return {
        id,
        name: this.name,
        result: lines.join('\n'),
        metadata: {
          filePath: generated.filePath,
          mimeType: generated.mimeType,
          bytes: generated.bytes,
          width: generated.width,
          height: generated.height,
          provider: generated.provider,
          model: generated.model,
          durationMs: generated.durationMs,
        },
      };
    } catch (error) {
      const message = error instanceof ImageGenerationError || error instanceof Error
        ? error.message
        : 'Unknown error';
      return {
        id,
        name: this.name,
        result: `Error: ${message}`,
        error: true,
      };
    }
  }
}

export const imageGenerateTool = new ImageGenerateTool();
