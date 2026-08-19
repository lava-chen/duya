/**
 * Image generation configuration (plan image-gen).
 *
 * Reads the `[image_generation]` section of `~/.duya/config.toml` plus
 * env-var overrides, mirroring research/goal mode config patterns. All
 * values have sane defaults so the tool can be discovered without any
 * config file.
 *
 * ```toml
 * [image_generation]
 * enabled = true
 * provider = "openai"      # openai | fal
 * model = "gpt-image-1"    # openai: gpt-image-1/2, dall-e-3; fal: fal-ai/flux/dev ...
 * base_url = ""            # OpenAI-compatible endpoint override (optional)
 * api_key = ""             # optional; prefer env IMAGE_GENERATION_API_KEY / OPENAI_API_KEY / FAL_KEY
 * size = "1024x1024"
 * quality = "auto"         # auto | low | medium | high (gpt-image series)
 * output_dir = ""          # default: <config-root>/media/generated
 * timeout_ms = 180000
 * ```
 *
 * Env overrides: `DUYA_IMAGE_GENERATION_ENABLED`, `DUYA_IMAGE_PROVIDER`,
 * `DUYA_IMAGE_MODEL`, `DUYA_IMAGE_SIZE`, `DUYA_IMAGE_OUTPUT_DIR`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from '@iarna/toml';

export type ImageProvider = 'openai' | 'fal';

export interface ImageGenerationConfig {
  /** Master switch — disabled → the tool reports a clear configuration error. */
  enabled: boolean;
  /** Provider backend: `openai` (Images API / compatible) or `fal` (fal.ai). */
  provider: ImageProvider;
  /** Provider-specific model id. */
  model: string;
  /** OpenAI-compatible base URL override (ignored by fal). */
  baseUrl: string;
  /** Optional inline API key; prefer env vars (IMAGE_GENERATION_API_KEY / OPENAI_API_KEY / FAL_KEY). */
  apiKey: string;
  /** Output resolution hint, e.g. `1024x1024`. */
  size: string;
  /** Quality hint for the gpt-image series: auto | low | medium | high. */
  quality: 'auto' | 'low' | 'medium' | 'high';
  /** Directory where generated images are persisted. Defaults to `<config-root>/media/generated`. */
  outputDir: string;
  /** Per-request timeout in milliseconds. */
  timeoutMs: number;
}

const DEFAULTS: ImageGenerationConfig = {
  enabled: false,
  provider: 'openai',
  model: 'gpt-image-1',
  baseUrl: '',
  apiKey: '',
  size: '1024x1024',
  quality: 'auto',
  outputDir: '',
  timeoutMs: 180_000,
};

/** Config root: `~/.duya` (or `~/.duya/test-namespaces/<ns>` in test mode). */
export function resolveImageConfigRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}

/** Default output directory for generated media. */
export function defaultImageOutputDir(configRoot: string = resolveImageConfigRoot()): string {
  return path.join(configRoot, 'media', 'generated');
}

function isQuality(v: unknown): v is ImageGenerationConfig['quality'] {
  return v === 'auto' || v === 'low' || v === 'medium' || v === 'high';
}

function isProvider(v: unknown): v is ImageProvider {
  return v === 'openai' || v === 'fal';
}

function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined) return fallback;
  return v === 'true' || v === '1';
}

function envStr(key: string): string | undefined {
  const v = process.env[key];
  return v !== undefined && v.trim() !== '' ? v.trim() : undefined;
}

function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined) return fallback;
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : fallback;
}

/**
 * Read the `[image_generation]` section from config.toml. Best-effort:
 * any parse / I/O failure falls back to defaults (config is optional).
 * Env vars override file values; CLI flag overrides are applied by the
 * caller on top.
 */
export function readImageGenerationConfig(): ImageGenerationConfig {
  const config: ImageGenerationConfig = { ...DEFAULTS };

  const configPath = path.join(resolveImageConfigRoot(), 'config.toml');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const doc = parse(raw) as { image_generation?: Partial<Record<string, unknown>> };
      const section = doc?.image_generation;
      if (section && typeof section === 'object') {
        if (typeof section.enabled === 'boolean') config.enabled = section.enabled;
        if (isProvider(section.provider)) config.provider = section.provider;
        if (typeof section.model === 'string' && section.model.trim()) config.model = section.model.trim();
        if (typeof section.base_url === 'string') config.baseUrl = section.base_url.trim();
        if (typeof section.api_key === 'string') config.apiKey = section.api_key.trim();
        if (typeof section.size === 'string' && section.size.trim()) config.size = section.size.trim();
        if (isQuality(section.quality)) config.quality = section.quality;
        if (typeof section.output_dir === 'string' && section.output_dir.trim()) {
          config.outputDir = section.output_dir.trim();
        }
        const timeout = section.timeout_ms;
        if (typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0) {
          config.timeoutMs = Math.round(timeout);
        }
      }
    }
  } catch {
    // Config is optional — keep defaults.
  }

  // Env overrides.
  config.enabled = envBool('DUYA_IMAGE_GENERATION_ENABLED', config.enabled);
  const envProvider = envStr('DUYA_IMAGE_PROVIDER');
  if (envProvider && isProvider(envProvider)) config.provider = envProvider;
  const envModel = envStr('DUYA_IMAGE_MODEL');
  if (envModel) config.model = envModel;
  const envSize = envStr('DUYA_IMAGE_SIZE');
  if (envSize) config.size = envSize;
  const envOutput = envStr('DUYA_IMAGE_OUTPUT_DIR');
  if (envOutput) config.outputDir = envOutput;

  // Resolve the effective API key: dedicated env > provider env > config field.
  const envDedicated = process.env.IMAGE_GENERATION_API_KEY?.trim();
  const envProviderKey =
    config.provider === 'fal' ? process.env.FAL_KEY?.trim() : process.env.OPENAI_API_KEY?.trim();
  config.apiKey = envDedicated || envProviderKey || config.apiKey;

  return config;
}

/** Image generation config accessor with a module-level cache (static per process). */
let cached: ImageGenerationConfig | undefined;
export function getImageGenerationConfig(): ImageGenerationConfig {
  if (!cached) cached = readImageGenerationConfig();
  return { ...cached };
}

/** Test hook: drop the module-level cache. */
export function _resetImageGenerationConfigCache(): void {
  cached = undefined;
}
