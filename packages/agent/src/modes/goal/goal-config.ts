/**
 * Goal mode configuration (plan 411 Phase 4).
 *
 * Reads the `[goal]` section of `~/.duya/config.toml` (the unified config
 * store, plan 334) plus env-var overrides, mirroring the agent's existing
 * config patterns. All values have sane defaults so goal mode works
 * out-of-the-box with no config file present.
 *
 * ```toml
 * [goal]
 * enabled = true
 * verifier_count = 3
 * strategist_every = 3
 * max_not_achieved_rounds = 5
 * auto_resume = true
 * auto_continue = true
 * max_auto_continues = 200
 * verification = "panel"   # "panel" | "none" | "auto"
 * verify_timeout_seconds = 300
 * ```
 *
 * Env overrides (all `DUYA_GOAL_*`): `DUYA_GOAL_VERIFIER_COUNT`,
 * `DUYA_GOAL_STRATEGIST_EVERY`, `DUYA_GOAL_MAX_NOT_ACHIEVED_ROUNDS`,
 * `DUYA_GOAL_AUTO_RESUME`, `DUYA_GOAL_AUTO_CONTINUE`,
 * `DUYA_GOAL_MAX_AUTO_CONTINUES`, `DUYA_GOAL_VERIFICATION`,
 * `DUYA_GOAL_VERIFY_TIMEOUT_SECONDS`.
 *
 * Plan 553 semantics:
 *  - `auto_resume`    — after a restart the coordinator auto-resumes a goal
 *                       folded to `user_paused(restart)` instead of waiting
 *                       for an explicit user resume.
 *  - `auto_continue`  — the PreFinalize continuation hook keeps the turn
 *                       running while the goal is active (bounded by
 *                       `max_auto_continues` per run; engine invariants
 *                       like max-turns still win).
 *  - `verification`   — `"panel"` runs the skeptic panel; `"none"` trusts
 *                       the worker's completion proposal (BYOK cost
 *                       protection, minimax `verificationModeForRoute`
 *                       parity); `"auto"` skips the panel only for local
 *                       runtimes (`provider === 'ollama'`).
 *  - `verify_timeout_seconds` — hard bound on the blocking verification
 *                       panel; a timeout settles as
 *                       `blocked(verifier_timeout)` instead of hanging the
 *                       tool loop forever.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from '@iarna/toml';

export type GoalVerificationMode = 'panel' | 'none' | 'auto';

export interface GoalConfig {
  /** Master switch — goal mode disabled → goal tools/prompts not injected. */
  enabled: boolean;
  /** Number of skeptic sub-agents in the verification panel (1–5). */
  verifierCount: number;
  /** Fire the strategist after this many consecutive not-achieved rounds. */
  strategistEvery: number;
  /** Stall guard: auto-pause after this many consecutive not-achieved rounds. */
  maxNotAchievedRounds: number;
  /** Auto-resume a goal folded to `user_paused(restart)` after a restart. */
  autoResume: boolean;
  /** Keep the turn running (PreFinalize veto) while the goal is active. */
  autoContinue: boolean;
  /** Max auto-continuation vetoes per run (0 = unlimited). */
  maxAutoContinues: number;
  /** Verification backend policy. */
  verification: GoalVerificationMode;
  /** Hard bound on the blocking verification panel (seconds). */
  verifyTimeoutSeconds: number;
}

const DEFAULTS: GoalConfig = {
  enabled: true,
  verifierCount: 1,
  strategistEvery: 3,
  maxNotAchievedRounds: 5,
  autoResume: true,
  autoContinue: true,
  maxAutoContinues: 200,
  verification: 'panel',
  verifyTimeoutSeconds: 300,
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
 * Read the `[goal]` section from config.toml. Best-effort: any parse /
 * I/O failure falls back to defaults (config is optional).
 */
export function readGoalConfig(): GoalConfig {
  const config: GoalConfig = { ...DEFAULTS };

  const configPath = path.join(resolveConfigRoot(), 'config.toml');
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const doc = parse(raw) as { goal?: Partial<Record<string, unknown>> };
      const goal = doc?.goal;
      if (goal && typeof goal === 'object') {
        if (typeof goal.enabled === 'boolean') config.enabled = goal.enabled;
        const verifierCount = numberOr(goal.verifier_count, DEFAULTS.verifierCount);
        config.verifierCount = clamp(verifierCount, 1, 5);
        const strategistEvery = numberOr(goal.strategist_every, DEFAULTS.strategistEvery);
        config.strategistEvery = clamp(strategistEvery, 1, 20);
        const maxRounds = numberOr(goal.max_not_achieved_rounds, DEFAULTS.maxNotAchievedRounds);
        config.maxNotAchievedRounds = clamp(maxRounds, 1, 50);
        if (typeof goal.auto_resume === 'boolean') config.autoResume = goal.auto_resume;
        if (typeof goal.auto_continue === 'boolean') config.autoContinue = goal.auto_continue;
        const maxContinues = numberOr(goal.max_auto_continues, DEFAULTS.maxAutoContinues);
        config.maxAutoContinues = clamp(Math.floor(maxContinues), 0, 100_000);
        if (
          goal.verification === 'panel' ||
          goal.verification === 'none' ||
          goal.verification === 'auto'
        ) {
          config.verification = goal.verification;
        }
        const timeout = numberOr(goal.verify_timeout_seconds, DEFAULTS.verifyTimeoutSeconds);
        config.verifyTimeoutSeconds = clamp(Math.floor(timeout), 30, 1800);
      }
    }
  } catch {
    // Config is optional — keep defaults.
  }

  // Env overrides (agent process gets config via env in production).
  const envVerifier = envInt('DUYA_GOAL_VERIFIER_COUNT');
  if (envVerifier !== undefined) config.verifierCount = clamp(envVerifier, 1, 5);
  const envStrategist = envInt('DUYA_GOAL_STRATEGIST_EVERY');
  if (envStrategist !== undefined) config.strategistEvery = clamp(envStrategist, 1, 20);
  const envMaxRounds = envInt('DUYA_GOAL_MAX_NOT_ACHIEVED_ROUNDS');
  if (envMaxRounds !== undefined) config.maxNotAchievedRounds = clamp(envMaxRounds, 1, 50);
  const envMaxContinues = envInt('DUYA_GOAL_MAX_AUTO_CONTINUES');
  if (envMaxContinues !== undefined) config.maxAutoContinues = clamp(envMaxContinues, 0, 100_000);
  const envTimeout = envInt('DUYA_GOAL_VERIFY_TIMEOUT_SECONDS');
  if (envTimeout !== undefined) config.verifyTimeoutSeconds = clamp(envTimeout, 30, 1800);
  const envAutoResume = process.env.DUYA_GOAL_AUTO_RESUME;
  if (envAutoResume !== undefined) {
    config.autoResume = envAutoResume === 'true' || envAutoResume === '1';
  }
  const envAutoContinue = process.env.DUYA_GOAL_AUTO_CONTINUE;
  if (envAutoContinue !== undefined) {
    config.autoContinue = envAutoContinue === 'true' || envAutoContinue === '1';
  }
  const envVerification = process.env.DUYA_GOAL_VERIFICATION;
  if (envVerification === 'panel' || envVerification === 'none' || envVerification === 'auto') {
    config.verification = envVerification;
  }
  const envEnabled = process.env.DUYA_GOAL_ENABLED;
  if (envEnabled !== undefined) {
    config.enabled = envEnabled === 'true' || envEnabled === '1';
  }

  return config;
}

/** Goal config accessor with a module-level cache (static per process). */
let cached: GoalConfig | undefined;
export function getGoalConfig(): GoalConfig {
  if (!cached) cached = readGoalConfig();
  return cached;
}

/** Test hook — clear the cache so a subsequent read picks up changes. */
export function _resetGoalConfigCache(): void {
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
  return Number.isFinite(n) ? Math.floor(n) : undefined;
}
