/**
 * decisions/config.ts — `[system_one]` config.toml reader (plan 551).
 *
 * @duya/agent owns the config root (~/.duya/config.toml) and the TOML
 * parser, so the file-reading half of the System One configuration
 * lives here; the shape lives in @duya/ai/system-one/config.ts.
 *
 * Accepted section:
 *   [system_one]
 *   enabled = true
 *   api_key = "..."          # or TYPESAFE_API_KEY env
 *   model = "jev-latest"
 *   base_url = "https://api.typesafe.ai/v1"
 *   timeout_ms = 2000
 *
 *   [system_one.policy]      # optional threshold overrides
 *   done_at = 0.85
 *   reject_at = 0.45
 *   irreversible_at = 0.6
 *   min_target_confidence = 0.8
 *
 *   [system_one.prescreen]   # plan 551 Phase 2 infra channel, default off
 *   permissions = false      # risk noul before tool execution (419 suggestion only)
 *
 * Missing file / section / key → defaults (silent, same pattern as
 * readToolExposureConfig). The resolved config feeds
 * createDecisionServiceFromConfig; with no key everything downstream
 * is a no-op (零行为破坏 guarantee).
 */

import * as fs from 'fs';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { resolveConfigRoot } from '../agent-profile/config-agents.js';
import { resolveSystemOneConfig, type SystemOneConfig } from '@duya/ai';
import { resolveDecisionPolicy, type DecisionPolicy } from './policy.js';

/** Phase 2 infra-channel switches, all default-off. */
export interface DecisionPrescreenConfig {
  /** Risk noul before tool execution — suggestion only, 419 semantics untouched. */
  permissions: boolean;
}

export interface DecisionsConfig {
  systemOne: SystemOneConfig;
  policy: DecisionPolicy;
  prescreen: DecisionPrescreenConfig;
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function bool(v: unknown): boolean | undefined {
  return typeof v === 'boolean' ? v : undefined;
}

export function readDecisionsConfig(configRootOverride?: string): DecisionsConfig {
  const overrides: Partial<SystemOneConfig> = {};
  const policyOverrides: Partial<DecisionPolicy> = {};
  const prescreen: DecisionPrescreenConfig = { permissions: false };
  try {
    const configPath = path.join(configRootOverride ?? resolveConfigRoot(), 'config.toml');
    if (fs.existsSync(configPath)) {
      const doc = parse(fs.readFileSync(configPath, 'utf-8')) as {
        system_one?: {
          enabled?: unknown;
          api_key?: unknown;
          model?: unknown;
          base_url?: unknown;
          timeout_ms?: unknown;
          policy?: {
            done_at?: unknown;
            reject_at?: unknown;
            irreversible_at?: unknown;
            min_target_confidence?: unknown;
          };
          prescreen?: { permissions?: unknown };
        };
      };
      const section = doc?.system_one;
      if (section) {
        const enabled = bool(section.enabled);
        if (enabled !== undefined) overrides.enabled = enabled;
        if (typeof section.api_key === 'string' && section.api_key !== '') overrides.apiKey = section.api_key;
        if (typeof section.model === 'string' && section.model !== '') overrides.model = section.model;
        if (typeof section.base_url === 'string' && section.base_url !== '') overrides.baseUrl = section.base_url;
        const timeout = num(section.timeout_ms);
        if (timeout !== undefined) overrides.timeoutMs = timeout;
        const pol = section.policy;
        if (pol) {
          const doneAt = num(pol.done_at);
          if (doneAt !== undefined) policyOverrides.doneAt = doneAt;
          const rejectAt = num(pol.reject_at);
          if (rejectAt !== undefined) policyOverrides.rejectAt = rejectAt;
          const irreversibleAt = num(pol.irreversible_at);
          if (irreversibleAt !== undefined) policyOverrides.irreversibleAt = irreversibleAt;
          const minConf = num(pol.min_target_confidence);
          if (minConf !== undefined) policyOverrides.minTargetConfidence = minConf;
        }
        const permissions = bool(section.prescreen?.permissions);
        if (permissions !== undefined) prescreen.permissions = permissions;
      }
    }
  } catch {
    // Config is optional — keep defaults.
  }

  return {
    systemOne: resolveSystemOneConfig(overrides),
    policy: resolveDecisionPolicy(policyOverrides),
    prescreen,
  };
}
