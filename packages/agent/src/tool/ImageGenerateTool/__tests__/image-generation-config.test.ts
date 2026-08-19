/**
 * Image generation config tests (plan image-gen).
 *
 * Verifies the `[image_generation]` config.toml section parsing, env
 * overrides, API-key resolution order, and default values.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readImageGenerationConfig,
  getImageGenerationConfig,
  _resetImageGenerationConfigCache,
  defaultImageOutputDir,
} from '../image-generation-config.js';

const TEST_NS = 'image-gen-config-test';

function writeConfigToml(content: string): void {
  const root = path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.toml'), content, 'utf-8');
}

describe('readImageGenerationConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DUYA_TEST;
    delete process.env.DUYA_TEST_NAMESPACE;
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DUYA_IMAGE_')) delete process.env[k];
    }
    delete process.env.IMAGE_GENERATION_API_KEY;
    delete process.env.FAL_KEY;
    delete process.env.OPENAI_API_KEY;
    try {
      fs.rmSync(path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore
    }
  });

  it('returns defaults with no config file present', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    const cfg = readImageGenerationConfig();
    expect(cfg.enabled).toBe(false);
    expect(cfg.provider).toBe('openai');
    expect(cfg.model).toBe('gpt-image-1');
    expect(cfg.size).toBe('1024x1024');
    expect(cfg.quality).toBe('auto');
    expect(cfg.timeoutMs).toBe(180_000);
    expect(cfg.outputDir).toBe('');
  });

  it('reads the [image_generation] section from config.toml', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml([
      '[image_generation]',
      'enabled = true',
      'provider = "fal"',
      'model = "fal-ai/flux/dev"',
      'size = "1024x576"',
      'quality = "high"',
      'output_dir = "C:/tmp/out"',
      'timeout_ms = 60000',
    ].join('\n'));

    const cfg = readImageGenerationConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.provider).toBe('fal');
    expect(cfg.model).toBe('fal-ai/flux/dev');
    expect(cfg.size).toBe('1024x576');
    expect(cfg.quality).toBe('high');
    expect(cfg.outputDir).toBe('C:/tmp/out');
    expect(cfg.timeoutMs).toBe(60_000);
  });

  it('rejects invalid provider/quality values and keeps defaults', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml([
      '[image_generation]',
      'enabled = true',
      'provider = "midjourney"',
      'quality = "ultra"',
      'model = 42',
    ].join('\n'));

    const cfg = readImageGenerationConfig();
    expect(cfg.provider).toBe('openai');
    expect(cfg.quality).toBe('auto');
    expect(cfg.model).toBe('gpt-image-1');
  });

  it('applies env overrides on top of the file', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml([
      '[image_generation]',
      'enabled = false',
      'model = "gpt-image-1"',
    ].join('\n'));
    process.env.DUYA_IMAGE_GENERATION_ENABLED = 'true';
    process.env.DUYA_IMAGE_MODEL = 'gpt-image-2';

    const cfg = readImageGenerationConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.model).toBe('gpt-image-2');
  });

  it('resolves api key: dedicated env > provider env > config field', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml([
      '[image_generation]',
      'api_key = "from-toml"',
    ].join('\n'));
    process.env.OPENAI_API_KEY = 'from-openai-env';
    expect(readImageGenerationConfig().apiKey).toBe('from-openai-env');

    delete process.env.OPENAI_API_KEY;
    expect(readImageGenerationConfig().apiKey).toBe('from-toml');

    process.env.IMAGE_GENERATION_API_KEY = 'from-dedicated-env';
    expect(readImageGenerationConfig().apiKey).toBe('from-dedicated-env');

    // fal provider falls back to FAL_KEY.
    writeConfigToml([
      '[image_generation]',
      'provider = "fal"',
    ].join('\n'));
    delete process.env.IMAGE_GENERATION_API_KEY;
    process.env.FAL_KEY = 'from-fal-env';
    expect(readImageGenerationConfig().apiKey).toBe('from-fal-env');
  });

  it('caches via getImageGenerationConfig and resets via the test hook', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    expect(getImageGenerationConfig().enabled).toBe(false);
    writeConfigToml('[image_generation]\nenabled = true\n');
    // Cached — still false.
    expect(getImageGenerationConfig().enabled).toBe(false);
    _resetImageGenerationConfigCache();
    expect(getImageGenerationConfig().enabled).toBe(true);
  });

  it('default output dir lives under the config root', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    expect(defaultImageOutputDir()).toContain(path.join('.duya', 'test-namespaces', TEST_NS, 'media', 'generated'));
  });
});
