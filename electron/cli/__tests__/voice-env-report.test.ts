/**
 * cli/__tests__/voice-env-report.test.ts — unit tests for the voice doctor
 * report builder. Pure module: no Electron imports, config/provider stores
 * are passed in as plain objects.
 */
import { describe, expect, it } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildVoiceEnvBody } from '../handlers/voice-env-report';
import type { CloudEndpointSource } from '../../services/voice/cloud-endpoint';

function fakeCloudSource(providers: Array<{ id?: string; baseUrl?: string; apiKey?: string }>): CloudEndpointSource {
  const resolve = (p: (typeof providers)[number]) => ({
    endpoints: { baseUrl: p.baseUrl },
    auth: { apiKey: p.apiKey },
  });
  return {
    getLlmProvider: (id) => {
      const p = providers.find((x) => x.id === id);
      return p ? resolve(p) : undefined;
    },
    getDefaultLlmProvider: () => {
      const p = providers.find((x) => !x.id);
      return p ? resolve(p) : undefined;
    },
    listLlmProviders: () => providers.map(resolve),
  };
}

function baseOpts(overrides?: Partial<Parameters<typeof buildVoiceEnvBody>[0]>) {
  return {
    rawConfig: {},
    userDataRoot: mkdtempSync(join(tmpdir(), 'duya-voice-report-')),
    cloudSource: fakeCloudSource([]),
    modelReady: false,
    modelSizeMb: 0,
    ...overrides,
  };
}

describe('buildVoiceEnvBody — readiness flag', () => {
  it('is not ok when voice is disabled, even with a full local setup', () => {
    const body = buildVoiceEnvBody(baseOpts({
      rawConfig: { enabled: false },
      modelReady: true,
      modelSizeMb: 142,
    }));
    // Binary missing here, but the point is disabled dominates.
    expect(body.enabled).toBe(false);
    expect(body.ok).toBe(false);
    expect(body.summary).toContain('未启用');
  });

  it('is ok for a complete local setup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-voice-report-bin-'));
    try {
      const bin = join(dir, 'whisper-cli.exe');
      writeFileSync(bin, 'fake');
      const body = buildVoiceEnvBody(baseOpts({
        rawConfig: { enabled: true },
        userDataRoot: join(dir, 'root'),
        modelReady: true,
        modelSizeMb: 142,
      }));
      // Managed dir is empty; binary must still be found via PATH/candidates
      // on dev machines — force the explicit path to keep the test hermetic.
      if (!body.binaryFound) {
        const forced = buildVoiceEnvBody(baseOpts({
          rawConfig: { enabled: true, stt: { local: { binary_path: bin } } },
          modelReady: true,
          modelSizeMb: 142,
        }));
        expect(forced.ok).toBe(true);
        expect(forced.binarySource).toBe('config');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('local engine: missing model blocks readiness even with a binary', () => {
    const body = buildVoiceEnvBody(baseOpts({
      rawConfig: { enabled: true },
      cloudSource: fakeCloudSource([{ baseUrl: 'https://api.example.com', apiKey: 'k' }]),
      modelReady: false,
    }));
    expect(body.engine).toBe('local');
    expect(body.ok).toBe(false);
  });

  it('cloud engine: ready endpoint → ok, regardless of local whisper state', () => {
    const body = buildVoiceEnvBody(baseOpts({
      rawConfig: { enabled: true, stt: { engine: 'cloud' } },
      cloudSource: fakeCloudSource([{ baseUrl: 'https://api.example.com/', apiKey: 'k' }]),
      modelReady: false,
    }));
    expect(body.engine).toBe('cloud');
    expect(body.cloud?.ready).toBe(true);
    expect(body.cloud?.baseUrl).toBe('https://api.example.com'); // trailing slash stripped
    expect(body.ok).toBe(true);
    expect(body.summary).toContain('云端');
  });

  it('cloud engine: missing provider key → not ok', () => {
    const body = buildVoiceEnvBody(baseOpts({
      rawConfig: { enabled: true, stt: { engine: 'cloud' } },
      cloudSource: fakeCloudSource([{ id: 'p1' }]),
    }));
    expect(body.cloud?.ready).toBe(false);
    expect(body.ok).toBe(false);
  });

  it('explicit binary_path is honored (previously misreported as MISSING)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'duya-voice-report-explicit-'));
    try {
      const bin = join(dir, 'custom-whisper.exe');
      writeFileSync(bin, 'fake');
      const body = buildVoiceEnvBody(baseOpts({
        rawConfig: {
          enabled: true,
          stt: { local: { binary_path: bin }, },
        },
        modelReady: true,
        modelSizeMb: 142,
      }));
      expect(body.binaryFound).toBe(true);
      expect(body.binaryPath).toBe(bin);
      expect(body.binarySource).toBe('config');
      expect(body.ok).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
