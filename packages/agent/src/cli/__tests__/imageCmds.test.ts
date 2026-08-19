/**
 * `duya image` CLI command tests (plan image-gen).
 *
 * Verifies runImageCommand: config layering, error output, JSON output,
 * and the success path with a mocked provider.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runImageCommand, printImageConfigSummary } from '../imageCmds.js';
import { _resetImageGenerationConfigCache } from '../../tool/ImageGenerateTool/image-generation-config.js';

const TEST_NS = 'image-gen-cli-test';

const TINY_PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg==';

function writeConfigToml(content: string): void {
  const root = path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.toml'), content, 'utf-8');
}

describe('runImageCommand', () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const originalError = console.error;

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DUYA_TEST;
    delete process.env.DUYA_TEST_NAMESPACE;
    delete process.env.IMAGE_GENERATION_API_KEY;
    globalThis.fetch = originalFetch;
    console.log = originalLog;
    console.error = originalError;
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

  it('rejects an empty prompt', async () => {
    const logs: string[] = [];
    console.error = (msg: unknown) => logs.push(String(msg));
    const code = await runImageCommand('  ', {});
    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/prompt is required/i);
  });

  it('fails cleanly with a guidance error when no key is configured', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml('[image_generation]\nenabled = true\n');

    const logs: string[] = [];
    console.error = (msg: unknown) => logs.push(String(msg));
    const code = await runImageCommand('a cat', {});
    expect(code).toBe(1);
    expect(logs.join('\n')).toMatch(/API key/i);
  });

  it('emits JSON output on failure when --json is set', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    writeConfigToml('[image_generation]\nenabled = true\n');

    const logs: string[] = [];
    console.log = (msg: unknown) => logs.push(String(msg));
    const code = await runImageCommand('a cat', { json: true });
    expect(code).toBe(1);
    const parsed = JSON.parse(logs.join('\n')) as { ok: boolean; error: string };
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/API key/i);
  });

  it('generates and prints the saved path with CLI overrides', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    process.env.IMAGE_GENERATION_API_KEY = 'cli-key';
    writeConfigToml('[image_generation]\nenabled = true\nmodel = "gpt-image-1"\n');

    globalThis.fetch = (async (url: string) => {
      if (String(url).includes('/v1/images/generations')) {
        return new Response(
          JSON.stringify({ data: [{ b64_json: TINY_PNG_B64, width: 1024, height: 576 }] }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`unexpected fetch: ${String(url)}`);
    }) as unknown as typeof fetch;

    const logs: string[] = [];
    console.log = (msg: unknown) => logs.push(String(msg));
    const code = await runImageCommand('a cat', { size: '1024x576' });

    expect(code).toBe(0);
    const all = logs.join('\n');
    expect(all).toMatch(/✔ Generated: .+\.png/);
    expect(all).toMatch(/1024x576/);
  });

  it('emits structured JSON on success when --json is set', async () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    process.env.IMAGE_GENERATION_API_KEY = 'cli-key';
    writeConfigToml('[image_generation]\nenabled = true\n');

    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ b64_json: TINY_PNG_B64 }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })) as unknown as typeof fetch;

    const logs: string[] = [];
    console.log = (msg: unknown) => logs.push(String(msg));
    const code = await runImageCommand('a cat', { json: true, provider: 'openai' });
    expect(code).toBe(0);
    const parsed = JSON.parse(logs.join('\n')) as { ok: boolean; filePath: string };
    expect(parsed.ok).toBe(true);
    expect(fs.existsSync(parsed.filePath)).toBe(true);
  });

  it('printImageConfigSummary shows the effective config without secrets', () => {
    vi.stubEnv('DUYA_TEST', '1');
    vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
    process.env.IMAGE_GENERATION_API_KEY = 'super-secret';
    writeConfigToml('[image_generation]\nenabled = true\nprovider = "fal"\n');

    const logs: string[] = [];
    console.log = (msg: unknown) => logs.push(String(msg));
    printImageConfigSummary();
    const all = logs.join('\n');
    expect(all).toMatch(/Provider:\s+fal/);
    expect(all).toMatch(/API key:\s+\*\*\*/);
    expect(all).not.toContain('super-secret');
  });
});
