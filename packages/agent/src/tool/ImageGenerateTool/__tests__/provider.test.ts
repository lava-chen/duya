/**
 * Image generation provider tests (plan image-gen).
 *
 * Mocks global fetch to verify the openai / fal request shapes, response
 * parsing (b64_json vs url), persistence, and error mapping.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { generateImage, ImageGenerationError } from '../provider.js';
import type { ImageGenerationConfig } from '../image-generation-config.js';

const TEST_NS = 'image-gen-provider-test';
const OUT_DIR = path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS, 'media', 'generated');

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function makeConfig(overrides: Partial<ImageGenerationConfig> = {}): ImageGenerationConfig {
  return {
    enabled: true,
    provider: 'openai',
    model: 'gpt-image-1',
    baseUrl: '',
    apiKey: 'test-key',
    size: '1024x1024',
    quality: 'auto',
    outputDir: OUT_DIR,
    timeoutMs: 30_000,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  try {
    fs.rmSync(path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS), {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
});

describe('generateImage (openai provider)', () => {
  it('posts to /v1/images/generations and persists b64_json output', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.openai.com/v1/images/generations');
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(sent.model).toBe('gpt-image-1');
      expect(sent.prompt).toBe('a red panda astronaut');
      expect(sent.n).toBe(1);
      expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-key' });
      return jsonResponse({ data: [{ b64_json: TINY_PNG_B64, width: 1024, height: 1024 }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateImage(makeConfig(), { prompt: 'a red panda astronaut' });

    expect(result.filePath).toMatch(/\.png$/);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.mimeType).toBe('image/png');
    expect(result.width).toBe(1024);
    expect(result.height).toBe(1024);
    expect(result.provider).toBe('openai');
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('uses a custom base_url when configured', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      expect(String(url)).toBe('https://my-proxy.example/v1/images/generations');
      return jsonResponse({ data: [{ b64_json: TINY_PNG_B64 }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await generateImage(makeConfig({ baseUrl: 'https://my-proxy.example' }), { prompt: 'x' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('downloads a url payload when b64_json is absent (dall-e-3 style)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/v1/images/generations')) {
        return jsonResponse({ data: [{ url: 'https://cdn.example/img.png' }] });
      }
      return new Response(Buffer.from(TINY_PNG_B64, 'base64'), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateImage(makeConfig(), { prompt: 'x' });
    expect(result.mimeType).toBe('image/png');
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('sends a reference image as a data URL for edit requests', async () => {
    const refPath = path.join(OUT_DIR, 'ref.png');
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(refPath, Buffer.from(TINY_PNG_B64, 'base64'));

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
      expect(sent.image).toMatch(/^data:image\/png;base64,/);
      return jsonResponse({ data: [{ b64_json: TINY_PNG_B64 }] });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await generateImage(makeConfig(), { prompt: 'make it blue', referenceImage: refPath });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('maps auth errors to a non-retryable guidance error', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: 'Invalid API key' } }, 401)) as unknown as typeof fetch;

    await expect(generateImage(makeConfig(), { prompt: 'x' })).rejects.toThrow(ImageGenerationError);
    await expect(generateImage(makeConfig(), { prompt: 'x' })).rejects.toThrow(/401|API key/i);
  });

  it('maps HTTP 429 to a retryable guidance error', async () => {
    globalThis.fetch = (async () =>
      jsonResponse({ error: { message: 'Rate limit' } }, 429)) as unknown as typeof fetch;

    const err = await generateImage(makeConfig(), { prompt: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect((err as ImageGenerationError).retryable).toBe(true);
  });
});

describe('generateImage (fal provider)', () => {
  it('posts to fal.run with Key auth and downloads the image', async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('fal.run')) {
        expect(String(url)).toBe('https://fal.run/fal-ai/flux/dev');
        const sent = JSON.parse(String(init?.body)) as Record<string, unknown>;
        expect(sent.prompt).toBe('a cat');
        expect(sent.image_size).toBe('1024x576');
        expect(init?.headers).toMatchObject({ Authorization: 'Key fal-key' });
        return jsonResponse({
          images: [{ url: 'https://fal-cdn.example/out.png', width: 1024, height: 576 }],
        });
      }
      return new Response(Buffer.from(TINY_PNG_B64, 'base64'), {
        status: 200,
        headers: { 'Content-Type': 'image/png' },
      });
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const result = await generateImage(
      makeConfig({ provider: 'fal', model: 'flux/dev', apiKey: 'fal-key', size: '1024x576' }),
      { prompt: 'a cat' },
    );
    expect(result.provider).toBe('fal');
    expect(result.model).toBe('fal-ai/flux/dev');
    expect(result.width).toBe(1024);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });
});

describe('generateImage (validation)', () => {
  it('rejects when disabled', async () => {
    const err = await generateImage(makeConfig({ enabled: false }), { prompt: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect((err as Error).message).toMatch(/disabled/i);
  });

  it('rejects when no api key is configured', async () => {
    const err = await generateImage(makeConfig({ apiKey: '' }), { prompt: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect((err as Error).message).toMatch(/API key/i);
  });

  it('rejects an empty prompt', async () => {
    const err = await generateImage(makeConfig(), { prompt: '   ' }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect((err as Error).message).toMatch(/prompt/i);
  });

  it('honors a per-call output directory', async () => {
    const customOut = path.join(OUT_DIR, 'custom');
    globalThis.fetch = (async () =>
      jsonResponse({ data: [{ b64_json: TINY_PNG_B64 }] })) as unknown as typeof fetch;

    const result = await generateImage(makeConfig(), { prompt: 'x', outputDir: customOut });
    expect(result.filePath.startsWith(customOut)).toBe(true);
    expect(fs.existsSync(result.filePath)).toBe(true);
  });

  it('aborts with a timeout error when the provider is slow', async () => {
    globalThis.fetch = (async (_url: string, init?: RequestInit) => {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (init?.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      return jsonResponse({ data: [{ b64_json: TINY_PNG_B64 }] });
    }) as unknown as typeof fetch;

    const err = await generateImage(makeConfig({ timeoutMs: 50 }), { prompt: 'x' }).catch((e) => e);
    expect(err).toBeInstanceOf(ImageGenerationError);
    expect((err as Error).message).toMatch(/timed out|abort|timeout/i);
  });
});
