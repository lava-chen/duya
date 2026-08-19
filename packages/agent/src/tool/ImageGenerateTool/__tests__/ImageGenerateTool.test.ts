/**
 * ImageGenerateTool tests (plan image-gen).
 *
 * Verifies the discoverable tool's execute path: config plumbing, error
 * surfacing when disabled / misconfigured, and successful generation
 * result shape with mocked fetch.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  ImageGenerateTool,
  imageGenerateTool,
  IMAGE_GENERATE_TOOL_NAME,
} from '../ImageGenerateTool.js';
import { _resetImageGenerationConfigCache } from '../image-generation-config.js';

const TEST_NS = 'image-gen-tool-test';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function writeConfigToml(content: string): void {
  const root = path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.toml'), content, 'utf-8');
}

describe('ImageGenerateTool', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DUYA_TEST;
    delete process.env.DUYA_TEST_NAMESPACE;
    delete process.env.IMAGE_GENERATION_API_KEY;
    globalThis.fetch = originalFetch;
    _resetImageGenerationConfigCache();
    try {
      fs.rmSync(path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore
    }
  });

  it('exposes the expected tool shape', () => {
    expect(imageGenerateTool.name).toBe(IMAGE_GENERATE_TOOL_NAME);
    expect(imageGenerateTool.toTool().name).toBe(IMAGE_GENERATE_TOOL_NAME);
    const schema = imageGenerateTool.input_schema as { required?: string[]; properties?: Record<string, unknown> };
    expect(schema.required).toContain('prompt');
    expect(Object.keys(schema.properties ?? {})).toEqual(
      expect.arrayContaining(['prompt', 'size', 'quality', 'reference_image', 'output_path']),
    );
  });

  it('returns a configuration error when image generation is disabled', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml('[image_generation]\nenabled = false\n');

    const tool = new ImageGenerateTool();
    const result = await tool.execute({ prompt: 'a cat' });
    expect(result.error).toBe(true);
    expect(result.result).toMatch(/disabled/i);
  });

  it('returns a configuration error when no api key is available', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml('[image_generation]\nenabled = true\n');

    const tool = new ImageGenerateTool();
    const result = await tool.execute({ prompt: 'a cat' });
    expect(result.error).toBe(true);
    expect(result.result).toMatch(/API key/i);
  });

  it('generates an image and returns path + metadata', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    process.env.IMAGE_GENERATION_API_KEY = 'tool-test-key';
    writeConfigToml('[image_generation]\nenabled = true\nmodel = "gpt-image-1"\n');

    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/v1/images/generations')) {
        return new Response(
          JSON.stringify({ data: [{ b64_json: TINY_PNG_B64, width: 1024, height: 1024 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;

    const tool = new ImageGenerateTool();
    const result = await tool.execute({ prompt: 'a red panda astronaut' });

    expect(result.error).toBeFalsy();
    expect(result.result).toContain('Image generated:');
    expect(result.result).toContain('.png');
    expect(result.metadata?.filePath).toBeTruthy();
    expect(result.metadata?.provider).toBe('openai');
    expect(fs.existsSync(String(result.metadata?.filePath))).toBe(true);
  });

  it('surfaces provider errors with guidance instead of raw text', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    process.env.IMAGE_GENERATION_API_KEY = 'tool-test-key';
    writeConfigToml('[image_generation]\nenabled = true\n');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: { message: 'Rate limit' } }), { status: 429 })) as unknown as typeof fetch;

    const tool = new ImageGenerateTool();
    const result = await tool.execute({ prompt: 'a cat' });
    expect(result.error).toBe(true);
    expect(result.result).toMatch(/rate-limited|429/i);
  });
});
