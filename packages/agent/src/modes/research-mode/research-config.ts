/**
 * Research mode configuration (plan 423 Phase 2).
 *
 * Reads the `[research]` section of `~/.duya/config.toml` plus an env-var
 * override, mirroring goal-mode's config pattern. All values have sane
 * defaults so research mode works out-of-the-box with no config file.
 *
 * ```toml
 * [research]
 * enabled = true
 * max_converge_rounds = 3
 * ```
 *
 * Env overrides: `DUYA_RESEARCH_ENABLED`, `DUYA_RESEARCH_MAX_CONVERGE_ROUNDS`.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { RESEARCH_DEFAULT_CONVERGE_ROUNDS } from './research-tracker.js';

export interface ResearchConfig {
  /** Master switch — research disabled → research tools/prompts not injected. */
  enabled: boolean;
  /** Auto-converge after this many consecutive unchanged coverage-gap rounds. */
  maxConvergeRounds: number;
}

const DEFAULTS: ResearchConfig = {
  enabled: true,
  maxConvergeRounds: RESEARCH_DEFAULT_CONVERGE_ROUNDS,
};

/** Config root: `~/.duya` (or `~/.duya/test-namespaces/<ns>` in test mode). */
function resolveConfigRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}

/**
 * Read the `[research]` section from config.toml. Best-effort: any parse /
 * I/O failure falls back to defaults (config is optional).
 */
export function readResearchConfig(): ResearchConfig {
  const config: ResearchConfig = { ...DEFAULTS };

  const configPath = path.join(resolveConfigRoot(), 'config.toml');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const doc = parse(raw) as { research?: Partial<Record<string, unknown>> };
      const research = doc?.research;
      if (research && typeof research === 'object') {
        if (typeof research.enabled === 'boolean') config.enabled = research.enabled;
        const maxRounds = numberOr(research.max_converge_rounds, DEFAULTS.maxConvergeRounds);
        config.maxConvergeRounds = clamp(maxRounds, 1, 20);
      }
    }
  } catch {
    // Config is optional — keep defaults.
  }

  const envEnabled = process.env.DUYA_RESEARCH_ENABLED;
  if (envEnabled !== undefined) {
    config.enabled = envEnabled === 'true' || envEnabled === '1';
  }
  const envMaxRounds = envInt('DUYA_RESEARCH_MAX_CONVERGE_ROUNDS');
  if (envMaxRounds !== undefined) config.maxConvergeRounds = clamp(envMaxRounds, 1, 20);

  return config;
}

/** Research config accessor with a module-level cache (static per process). */
let cached: ResearchConfig | undefined;
export function getResearchConfig(): ResearchConfig {
  if (!cached) cached = readResearchConfig();
  return cached;
}

/** Test hook — clear the cache so a subsequent read picks up changes. */
export function _resetResearchConfigCache(): void {
  cached = undefined;
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function clamp(v: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, v));
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) ? n : undefined;
}