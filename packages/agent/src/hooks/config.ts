/**
 * Steering & hooks configuration (plan 426 Phase 4).
 *
 * Reads the `[steering]` and `[hooks]` sections of `~/.duya/config.toml`
 * (the unified config store, plan 334) plus env-var overrides, mirroring
 * the agent's existing config patterns (goal-config.ts / config-agents.ts).
 *
 * ```toml
 * [steering]
 * todo_gate = true
 * tool_intent_nudge_max = 2
 *
 * [steering.anti_dead_loop]
 * enabled = true
 * nudge_at = 8
 * hard_nudge_at = 12
 * hard_stop_at = 16
 *
 * # User hooks are declared in hook.json files (the ecosystem shape shared
 * # with Claude Code settings.json / ZCode plugin hooks.json); the config
 * # only records their paths. `~` is expanded; relative paths resolve
 * # against the config root (~/.duya).
 * [hooks]
 * files = ["~/duya-hooks.json", "E:/projects/x/hooks.json"]
 * ```
 *
 * Env overrides: `DUYA_STEERING_TODO_GATE`, `DUYA_STEERING_ANTI_DEAD_LOOP`,
 * `DUYA_STEERING_DEAD_LOOP_NUDGE_AT`, `DUYA_STEERING_DEAD_LOOP_HARD_NUDGE_AT`,
 * `DUYA_STEERING_DEAD_LOOP_HARD_STOP_AT`, `DUYA_STEERING_TOOL_INTENT_NUDGE_MAX`.
 *
 * No module-level cache: every `streamChat` reads fresh so config edits take
 * effect on the next run without a process restart (hot reload semantics,
 * mirroring config-agents.ts).
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parse } from '@iarna/toml';
import { z } from 'zod';
import type { HooksSettings } from './types.js';
import { parseHooksJsonContent, mergeHooksSettings } from './hooks-json.js';
import { logger } from '../utils/logger.js';

// ============================================================================
// [steering]
// ============================================================================

export interface AntiDeadLoopConfig {
  enabled: boolean;
  /** Consecutive identical calls before the soft "change approach" nudge. */
  nudgeAt: number;
  /** Consecutive identical calls before the stronger "stop repeating" nudge. */
  hardNudgeAt: number;
  /** Consecutive identical calls before the engine hard-stops the loop. */
  hardStopAt: number;
}

export interface SteeringConfig {
  /** Todo gate: veto finalize while pending/in-progress tasks remain. */
  todoGateEnabled: boolean;
  antiDeadLoop: AntiDeadLoopConfig;
  /** Per-run cap of tool-intent nudges (plan 418). */
  toolIntentNudgeMax: number;
}

const DEFAULTS: SteeringConfig = {
  todoGateEnabled: true,
  antiDeadLoop: { enabled: true, nudgeAt: 8, hardNudgeAt: 12, hardStopAt: 16 },
  toolIntentNudgeMax: 2,
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

interface SteeringToml {
  todo_gate?: unknown;
  tool_intent_nudge_max?: unknown;
  anti_dead_loop?: {
    enabled?: unknown;
    nudge_at?: unknown;
    hard_nudge_at?: unknown;
    hard_stop_at?: unknown;
  };
}

/**
 * Read the `[steering]` section. Best-effort: any parse / I/O failure falls
 * back to defaults (config is optional). NOT cached — each call re-reads the
 * file so config edits apply to the next streamChat (hot reload).
 */
export function readSteeringConfig(): SteeringConfig {
  const config: SteeringConfig = {
    todoGateEnabled: DEFAULTS.todoGateEnabled,
    antiDeadLoop: { ...DEFAULTS.antiDeadLoop },
    toolIntentNudgeMax: DEFAULTS.toolIntentNudgeMax,
  };

  try {
    const configPath = path.join(resolveConfigRoot(), 'config.toml');
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const doc = parse(raw) as { steering?: SteeringToml };
      const steering = doc?.steering;
      if (steering && typeof steering === 'object') {
        if (typeof steering.todo_gate === 'boolean') {
          config.todoGateEnabled = steering.todo_gate;
        }
        const adl = steering.anti_dead_loop;
        if (adl && typeof adl === 'object') {
          if (typeof adl.enabled === 'boolean') config.antiDeadLoop.enabled = adl.enabled;
          config.antiDeadLoop.nudgeAt = clamp(
            numberOr(adl.nudge_at, DEFAULTS.antiDeadLoop.nudgeAt),
            2,
            50,
          );
          config.antiDeadLoop.hardNudgeAt = clamp(
            numberOr(adl.hard_nudge_at, DEFAULTS.antiDeadLoop.hardNudgeAt),
            2,
            50,
          );
          config.antiDeadLoop.hardStopAt = clamp(
            numberOr(adl.hard_stop_at, DEFAULTS.antiDeadLoop.hardStopAt),
            2,
            100,
          );
        }
        config.toolIntentNudgeMax = clamp(
          numberOr(steering.tool_intent_nudge_max, DEFAULTS.toolIntentNudgeMax),
          0,
          10,
        );
      }
    }
  } catch {
    // Config is optional — keep defaults.
  }

  // Env overrides (agent process gets config via env in production).
  const envTodoGate = process.env.DUYA_STEERING_TODO_GATE;
  if (envTodoGate !== undefined && envTodoGate !== '') {
    config.todoGateEnabled = envTodoGate === '1' || envTodoGate === 'true';
  }
  const envAntiDeadLoop = process.env.DUYA_STEERING_ANTI_DEAD_LOOP;
  if (envAntiDeadLoop !== undefined && envAntiDeadLoop !== '') {
    config.antiDeadLoop.enabled = envAntiDeadLoop === '1' || envAntiDeadLoop === 'true';
  }
  const envNudgeAt = envInt('DUYA_STEERING_DEAD_LOOP_NUDGE_AT');
  if (envNudgeAt !== undefined) config.antiDeadLoop.nudgeAt = clamp(envNudgeAt, 2, 50);
  const envHardNudgeAt = envInt('DUYA_STEERING_DEAD_LOOP_HARD_NUDGE_AT');
  if (envHardNudgeAt !== undefined) {
    config.antiDeadLoop.hardNudgeAt = clamp(envHardNudgeAt, 2, 50);
  }
  const envHardStopAt = envInt('DUYA_STEERING_DEAD_LOOP_HARD_STOP_AT');
  if (envHardStopAt !== undefined) {
    config.antiDeadLoop.hardStopAt = clamp(envHardStopAt, 2, 100);
  }
  const envToolIntent = envInt('DUYA_STEERING_TOOL_INTENT_NUDGE_MAX');
  if (envToolIntent !== undefined) config.toolIntentNudgeMax = clamp(envToolIntent, 0, 10);

  return config;
}

/**
 * Fresh-read alias for call sites that conceptually want "the" config.
 * Deliberately uncached (hot reload semantics — see readSteeringConfig).
 */
export function getSteeringConfig(): SteeringConfig {
  return readSteeringConfig();
}

// ============================================================================
// [hooks]
// ============================================================================

/**
 * The `[hooks]` section only records hook.json file paths; the hook content
 * itself lives in those JSON files (see ./hooks-json.ts).
 */

/** Injectable file reader for tests (avoid touching the real filesystem). */
export interface HooksConfigFileDeps {
  /** Read a hook.json file body; throws on I/O failure. */
  readFile?: (filePath: string) => string;
  /** Base directory for resolving relative paths (defaults to the config root). */
  baseDir?: string;
}

/**
 * Expand `~` and resolve a hook.json path against the config root.
 * Relative paths are anchored at `~/.duya` (the config file's directory) so
 * a path written in config.toml behaves like a path written next to it.
 */
export function resolveHookFilePath(rawPath: string, baseDir: string): string {
  if (rawPath === '~') return os.homedir();
  if (rawPath.startsWith('~/') || rawPath.startsWith('~\\')) {
    return path.join(os.homedir(), rawPath.slice(2));
  }
  return path.isAbsolute(rawPath) ? rawPath : path.resolve(baseDir, rawPath);
}

/**
 * Read the `[hooks]` section. Returns undefined when the section is absent,
 * `files` is missing/empty, any referenced file fails to parse, or the
 * section fails validation — hooks are strictly optional and
 * misconfiguration must never break the agent loop (fail-open, per-file
 * WARNs from the loader). NOT cached — each call re-reads config.toml and
 * every hook file so edits apply to the next streamChat (hot reload).
 */
export function readHooksConfig(): HooksSettings | undefined {
  const configPath = path.join(resolveConfigRoot(), 'config.toml');
  if (!fs.existsSync(configPath)) return undefined;
  return _readHooksConfigFromRaw(fs.readFileSync(configPath, 'utf-8'), {
    baseDir: resolveConfigRoot(),
    readFile: (p) => fs.readFileSync(p, 'utf-8'),
  });
}

/**
 * Test-friendly variant: parse the `[hooks]` section from a TOML string and
 * load every referenced hook.json via the injected reader. Returns undefined
 * when the section is absent or invalid.
 */
export function _readHooksConfigFromRaw(
  raw: string,
  deps: HooksConfigFileDeps = {},
): HooksSettings | undefined {
  let doc: { hooks?: unknown };
  try {
    doc = parse(raw) as { hooks?: unknown };
  } catch {
    return undefined;
  }
  const hooks = doc.hooks;
  if (hooks === undefined || hooks === null || typeof hooks !== 'object' || Array.isArray(hooks)) {
    return undefined;
  }

  // strict(): unknown keys inside `[hooks]` (typos, or the legacy inline
  // event-keyed shape) fail validation and surface as a WARN instead of
  // silently producing a hooks section that never fires.
  let files: string[];
  try {
    const parsed = HooksTomlSchema.strict().parse(hooks);
    files = parsed.files ?? [];
  } catch (err) {
    logger.warn(
      `[HooksConfig] invalid [hooks] section ignored: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (files.length === 0) return undefined;

  const baseDir = deps.baseDir ?? resolveConfigRoot();
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
  const parts: Array<HooksSettings | undefined> = [];
  for (const entry of files) {
    const filePath = resolveHookFilePath(entry, baseDir);
    let body: string;
    try {
      body = readFile(filePath);
    } catch (err) {
      logger.warn(
        `[HooksConfig] hook file not readable (skipped): ${filePath} (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    parts.push(parseHooksJsonContent(body, filePath));
  }
  return mergeHooksSettings(parts);
}

/** Hook-file list schema for the `[hooks]` section. */
const HooksTomlSchema = z.object({
  files: z.array(z.string()).optional(),
});

// ============================================================================
// helpers
// ============================================================================

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
