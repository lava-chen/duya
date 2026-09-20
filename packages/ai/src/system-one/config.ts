/**
 * system-one/config.ts — System One configuration surface (plan 551 Phase 1).
 *
 * This module defines the config SHAPE and env resolution only — it never
 * touches the filesystem. Reading the `[system_one]` section of
 * `~/.duya/config.toml` happens in @duya/agent (which owns the config root
 * and the TOML parser); the resolved values flow in through
 * `resolveSystemOneConfig` overrides.
 *
 * Env fallbacks (checked when the caller does not supply a value):
 *   TYPESAFE_API_KEY   — API key
 *   TYPESAFE_BASE_URL  — API origin
 *   TYPESAFE_MODEL     — model id (default jev-latest)
 */

import {
  DEFAULT_SYSTEM_ONE_BASE_URL,
  DEFAULT_SYSTEM_ONE_MODEL,
  DEFAULT_SYSTEM_ONE_TIMEOUT_MS,
} from './client.js';

export interface SystemOneConfig {
  /** Master switch. When false, every Jev call site is a no-op. */
  enabled: boolean;
  apiKey?: string;
  model: string;
  baseUrl: string;
  timeoutMs: number;
}

export const DEFAULT_SYSTEM_ONE_CONFIG: SystemOneConfig = {
  enabled: false,
  model: DEFAULT_SYSTEM_ONE_MODEL,
  baseUrl: DEFAULT_SYSTEM_ONE_BASE_URL,
  timeoutMs: DEFAULT_SYSTEM_ONE_TIMEOUT_MS,
};

function envString(name: string): string | undefined {
  const raw = process.env[name];
  return raw !== undefined && raw !== '' ? raw : undefined;
}

function envNumber(name: string): number | undefined {
  const raw = envString(name);
  if (raw === undefined) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/**
 * Merge defaults ← config file values ← overrides ← env. `enabled` flips
 * to true only when a final API key exists (explicit enabled=false always
 * wins), so a stray key in the environment silently enables nothing unless
 * the feature is on.
 */
export function resolveSystemOneConfig(
  overrides?: Partial<SystemOneConfig>,
): SystemOneConfig {
  const merged: SystemOneConfig = {
    ...DEFAULT_SYSTEM_ONE_CONFIG,
    ...overrides,
  };
  merged.apiKey = merged.apiKey ?? envString('TYPESAFE_API_KEY');
  merged.baseUrl = overrides?.baseUrl ?? envString('TYPESAFE_BASE_URL') ?? merged.baseUrl;
  merged.model = overrides?.model ?? envString('TYPESAFE_MODEL') ?? merged.model;
  merged.timeoutMs = overrides?.timeoutMs ?? envNumber('TYPESAFE_TIMEOUT_MS') ?? merged.timeoutMs;
  if (merged.enabled && !merged.apiKey) {
    merged.enabled = false;
  }
  return merged;
}
