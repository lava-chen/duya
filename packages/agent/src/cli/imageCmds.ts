/**
 * `duya image` — CLI subcommand (plan image-gen).
 *
 * Generates an image directly from the terminal, without an LLM round
 * trip. Reads `[image_generation]` from ~/.duya/config.toml; every
 * option can be overridden on the command line.
 */

import { Colors, color } from './colors.js';
import { getImageGenerationConfig, readImageGenerationConfig } from '../tool/ImageGenerateTool/index.js';
import { generateImage, ImageGenerationError } from '../tool/ImageGenerateTool/index.js';
import type { ImageProvider } from '../tool/ImageGenerateTool/index.js';

export interface ImageCommandOptions {
  provider?: string;
  model?: string;
  size?: string;
  quality?: string;
  output?: string;
  outputName?: string;
  json?: boolean;
}

function isProvider(v: string | undefined): v is ImageProvider {
  return v === 'openai' || v === 'fal';
}

/**
 * Run `duya image <prompt>`. Returns the process exit code (0 ok, 1 error).
 */
export async function runImageCommand(
  prompt: string,
  options: ImageCommandOptions,
): Promise<number> {
  if (!prompt?.trim()) {
    console.error(color('Error: image prompt is required (usage: duya image "<prompt>")', Colors.BRIGHT_RED));
    return 1;
  }

  // Re-read config so CLI overrides layer on top of the file values.
  const base = getImageGenerationConfig();
  const config = {
    ...base,
    provider: isProvider(options.provider) ? options.provider : base.provider,
    model: options.model?.trim() ? options.model.trim() : base.model,
    size: options.size?.trim() ? options.size.trim() : base.size,
    quality:
      options.quality && ['auto', 'low', 'medium', 'high'].includes(options.quality)
        ? (options.quality as 'auto' | 'low' | 'medium' | 'high')
        : base.quality,
    outputDir: options.output?.trim() ? options.output.trim() : base.outputDir,
    // CLI explicitly opts in for this run even if the config toggle is off.
    enabled: true,
  };

  try {
    if (!config.apiKey) {
      throw new ImageGenerationError(
        'No API key configured for image generation. Set IMAGE_GENERATION_API_KEY (or OPENAI_API_KEY / FAL_KEY) or [image_generation] api_key in ~/.duya/config.toml.',
        false,
      );
    }

    if (!options.json) {
      const preview = prompt.length > 90 ? `${prompt.slice(0, 90)}…` : prompt;
      console.log(color(`Generating image: ${preview}`, Colors.CYAN));
      console.log(color(`  provider=${config.provider} model=${config.model} size=${config.size}`, Colors.DIM));
    }

    const generated = await generateImage(config, {
      prompt,
      size: config.size,
      quality: config.quality === 'auto' ? undefined : config.quality,
      outputDir: config.outputDir,
      outputName: options.outputName?.trim() || undefined,
    });

    if (options.json) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            filePath: generated.filePath,
            width: generated.width ?? null,
            height: generated.height ?? null,
            bytes: generated.bytes,
            mimeType: generated.mimeType,
            provider: generated.provider,
            model: generated.model,
            durationMs: generated.durationMs,
          },
          null,
          2,
        ),
      );
    } else {
      console.log(color(`✔ Generated: ${generated.filePath}`, Colors.GREEN));
      const dims = generated.width && generated.height ? `${generated.width}x${generated.height}px` : config.size;
      console.log(
        color(
          `  ${dims} | ${(generated.bytes / 1024).toFixed(1)} KB | ${generated.mimeType} | ${generated.provider}/${generated.model} | ${generated.durationMs} ms`,
          Colors.DIM,
        ),
      );
    }
    return 0;
  } catch (error) {
    const message =
      error instanceof ImageGenerationError || error instanceof Error
        ? error.message
        : String(error);
    if (options.json) {
      console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    } else {
      console.error(color(`✘ ${message}`, Colors.BRIGHT_RED));
    }
    return 1;
  }
}

/** Show the effective image generation configuration (for `duya image --show-config` style debugging). */
export function printImageConfigSummary(): void {
  const config = readImageGenerationConfig();
  console.log(color('Image Generation Configuration:', Colors.CYAN));
  console.log(color(`  Enabled:   ${config.enabled ? 'yes' : 'no'}`, Colors.DIM));
  console.log(color(`  Provider:  ${config.provider}`, Colors.DIM));
  console.log(color(`  Model:     ${config.model}`, Colors.DIM));
  console.log(color(`  Size:      ${config.size}`, Colors.DIM));
  console.log(color(`  Quality:   ${config.quality}`, Colors.DIM));
  console.log(color(`  Base URL:  ${config.baseUrl || '(provider default)'}`, Colors.DIM));
  console.log(color(`  Output:    ${config.outputDir || '(default ~/.duya/media/generated)'}`, Colors.DIM));
  console.log(color(`  API key:   ${config.apiKey ? '***' : '(not set)'}`, config.apiKey ? Colors.GREEN : Colors.RED));
  console.log(color(`  Timeout:   ${config.timeoutMs} ms`, Colors.DIM));
}
