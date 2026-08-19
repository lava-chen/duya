/**
 * Image generation provider adapters (plan image-gen).
 *
 * Two backends, selected by `[image_generation] provider`:
 *   - `openai`: OpenAI Images API (`POST {baseUrl}/v1/images/generations`).
 *     Works with gpt-image-1/2, dall-e-3, and any OpenAI-compatible
 *     endpoint (custom base_url). Supports quality hints and reference
 *     images (edit/variation) when the model accepts them.
 *   - `fal`: fal.ai unified API (`POST https://fal.run/{modelId}`).
 *     Flux family and many community models; model id may omit the
 *     `fal-ai/` prefix.
 *
 * Both paths return the generated image bytes; the caller persists them.
 */

import { readFile } from 'node:fs/promises';
import { join, extname } from 'path';
import { randomUUID } from 'crypto';
import type { ImageGenerationConfig } from './image-generation-config.js';

export interface GenerateImageOptions {
  prompt: string;
  /** Optional reference image for edit/variation (OpenAI only). Local path, http(s) URL, or data URL. */
  referenceImage?: string;
  size?: string;
  quality?: 'auto' | 'low' | 'medium' | 'high';
  /** Absolute directory to persist the result into. */
  outputDir?: string;
  /** Optional explicit output file name (without extension). */
  outputName?: string;
}

export interface GeneratedImage {
  /** Absolute path of the persisted file. */
  filePath: string;
  /** Bytes written. */
  bytes: number;
  /** MIME type detected from the provider payload. */
  mimeType: string;
  width?: number;
  height?: number;
  /** Provider that produced the image. */
  provider: string;
  model: string;
  /** Total wall time in ms (API + persist). */
  durationMs: number;
}

export class ImageGenerationError extends Error {
  constructor(
    message: string,
    public readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'ImageGenerationError';
  }
}

/** Map a prompt phrase to a stable file extension via the MIME type. */
function extForMime(mimeType: string): string {
  if (mimeType.includes('jpeg')) return '.jpg';
  if (mimeType.includes('webp')) return '.webp';
  if (mimeType.includes('gif')) return '.gif';
  return '.png';
}

function toDataUrl(mimeType: string, bytes: Buffer): string {
  return `data:${mimeType};base64,${bytes.toString('base64')}`;
}

function base64FromDataUrl(dataUrl: string): Buffer {
  const match = /^data:([^;,]+);base64,(.+)$/s.exec(dataUrl);
  if (!match) throw new ImageGenerationError('Invalid data URL format', false);
  return Buffer.from(match[2], 'base64');
}

function normalizeModelId(model: string): string {
  const m = model.trim();
  if (m.startsWith('fal-ai/') || m.startsWith('http')) return m;
  return `fal-ai/${m}`;
}

function buildErrorGuidance(err: unknown): ImageGenerationError {
  const msg = err instanceof Error ? err.message : String(err);

  if (/401|403/.test(msg) || /unauthoriz|invalid api key|authentication/i.test(msg)) {
    return new ImageGenerationError(
      `Image generation provider rejected the API key (401/403). Check the key for provider "${''}" in env (IMAGE_GENERATION_API_KEY / OPENAI_API_KEY / FAL_KEY) or [image_generation] api_key in ~/.duya/config.toml, then retry.`,
      false,
    );
  }
  if (/429|rate|quota/i.test(msg)) {
    return new ImageGenerationError(
      'Image generation provider is rate-limited or out of quota (429). Wait a moment or check the provider billing page, then retry.',
      true,
    );
  }
  if (/timeout|timed out|abort/i.test(msg)) {
    return new ImageGenerationError(
      'Image generation request timed out. The model may be busy; retry, or raise [image_generation] timeout_ms in config.toml.',
      true,
    );
  }
  if (/fetch failed|econnrefused|enotfound|socket hang up|network/i.test(msg)) {
    return new ImageGenerationError(
      'Could not reach the image generation provider (network or endpoint configuration). Check base_url / model id and connectivity, then retry.',
      true,
    );
  }
  return new ImageGenerationError(
    `Image generation failed: ${msg}. Check provider, model id, and prompt, then retry.`,
    false,
  );
}

async function loadReferenceBytes(referenceImage: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (referenceImage.startsWith('data:')) {
    const match = /^data:([^;,]+);base64,(.+)$/s.exec(referenceImage);
    if (!match) throw new ImageGenerationError('Invalid reference image data URL', false);
    return { buffer: Buffer.from(match[2], 'base64'), mimeType: match[1] || 'image/png' };
  }
  if (/^https?:\/\//i.test(referenceImage)) {
    const res = await fetch(referenceImage);
    if (!res.ok) {
      throw new ImageGenerationError(`Failed to fetch reference image: HTTP ${res.status}`, false);
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
    return { buffer, mimeType };
  }
  // Local file path.
  const buffer = await readFile(referenceImage);
  const ext = extname(referenceImage).toLowerCase();
  const mimeType =
    ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg'
    : ext === '.webp' ? 'image/webp'
    : ext === '.gif' ? 'image/gif'
    : 'image/png';
  return { buffer, mimeType };
}

async function openaiGenerate(
  config: ImageGenerationConfig,
  opts: GenerateImageOptions,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string; width?: number; height?: number; model: string }> {
  const baseUrl = (config.baseUrl || 'https://api.openai.com').replace(/\/+$/, '');
  const body: Record<string, unknown> = {
    model: config.model,
    prompt: opts.prompt,
    n: 1,
    response_format: 'b64_json',
  };
  const size = opts.size ?? config.size;
  if (size) body.size = size;
  const quality = opts.quality ?? config.quality;
  if (quality && quality !== 'auto') body.quality = quality;
  if (opts.referenceImage) {
    const { buffer, mimeType } = await loadReferenceBytes(opts.referenceImage);
    body.image = toDataUrl(mimeType, buffer);
    // gpt-image edit requests go to the same generations endpoint.
    delete body.response_format;
  }

  const res = await fetch(`${baseUrl}/v1/images/generations`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }

  const json = (await res.json()) as {
    data?: Array<{ b64_json?: string; url?: string; revised_prompt?: string; width?: number; height?: number }>;
  };
  const item = json.data?.[0];
  if (!item) throw new ImageGenerationError('Provider returned no image data', true);

  if (item.b64_json) {
    return {
      bytes: Buffer.from(item.b64_json, 'base64'),
      mimeType: 'image/png',
      width: item.width,
      height: item.height,
      model: config.model,
    };
  }
  if (item.url) {
    const dl = await fetch(item.url, { signal });
    if (!dl.ok) throw new ImageGenerationError(`Failed to download generated image: HTTP ${dl.status}`, true);
    const bytes = Buffer.from(await dl.arrayBuffer());
    const mimeType = dl.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';
    return { bytes, mimeType, model: config.model };
  }
  throw new ImageGenerationError('Provider response missing both b64_json and url', true);
}

async function falGenerate(
  config: ImageGenerationConfig,
  opts: GenerateImageOptions,
  signal: AbortSignal,
): Promise<{ bytes: Buffer; mimeType: string; width?: number; height?: number; model: string }> {
  const modelId = normalizeModelId(config.model);
  const endpoint = modelId.startsWith('http') ? modelId : `https://fal.run/${modelId}`;
  const body: Record<string, unknown> = { prompt: opts.prompt };
  const size = opts.size ?? config.size;
  if (size) body.image_size = size;

  const res = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Key ${config.apiKey}`,
    },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`HTTP ${res.status} ${res.statusText}${detail ? ` — ${detail.slice(0, 300)}` : ''}`);
  }

  const json = (await res.json()) as {
    images?: Array<{ url: string; width?: number; height?: number }>;
  };
  const image = json.images?.[0];
  if (!image?.url) throw new ImageGenerationError('fal response missing images[0].url', true);

  const dl = await fetch(image.url, { signal });
  if (!dl.ok) throw new ImageGenerationError(`Failed to download generated image: HTTP ${dl.status}`, true);
  const bytes = Buffer.from(await dl.arrayBuffer());
  const mimeType = dl.headers.get('content-type')?.split(';')[0]?.trim() || 'image/png';

  return {
    bytes,
    mimeType,
    width: image.width,
    height: image.height,
    model: modelId,
  };
}

/**
 * Generate an image through the configured provider and persist it under
 * the output directory. Returns the persisted file path plus metadata.
 */
export async function generateImage(
  config: ImageGenerationConfig,
  opts: GenerateImageOptions,
): Promise<GeneratedImage> {
  const started = Date.now();
  if (!config.enabled) {
    throw new ImageGenerationError(
      'Image generation is disabled. Set `enabled = true` under [image_generation] in ~/.duya/config.toml (or DUYA_IMAGE_GENERATION_ENABLED=true), and provide an API key.',
      false,
    );
  }
  if (!config.apiKey) {
    throw new ImageGenerationError(
      'No API key configured for image generation. Set IMAGE_GENERATION_API_KEY (or OPENAI_API_KEY for the openai provider / FAL_KEY for fal) or [image_generation] api_key in ~/.duya/config.toml.',
      false,
    );
  }
  if (!opts.prompt?.trim()) {
    throw new ImageGenerationError('A non-empty prompt is required.', false);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('request timed out')), config.timeoutMs);
  const signal = controller.signal;
  // Allow the caller's abort to propagate (e.g. agent turn cancellation).
  try {
    const { bytes, mimeType, width, height, model } =
      config.provider === 'fal'
        ? await falGenerate(config, opts, signal)
        : await openaiGenerate(config, opts, signal);

    const { mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    const outputDir = opts.outputDir || config.outputDir || '';
    const dir = outputDir || (await import('./image-generation-config.js')).defaultImageOutputDir();
    await mkdir(dir, { recursive: true });

    const ext = extForMime(mimeType);
    const baseName = opts.outputName || `duya-image-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID().slice(0, 8)}`;
    const filePath = join(dir, `${baseName}${ext}`);
    const { writeFile } = await import('node:fs/promises');
    await writeFile(filePath, bytes);

    return {
      filePath,
      bytes: bytes.length,
      mimeType,
      width,
      height,
      provider: config.provider,
      model,
      durationMs: Date.now() - started,
    };
  } catch (err) {
    if (err instanceof ImageGenerationError) throw err;
    throw buildErrorGuidance(err);
  } finally {
    clearTimeout(timer);
  }
}

export { base64FromDataUrl };
