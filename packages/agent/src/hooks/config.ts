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
 *
 * [steering.anti_dead_loop]
 * enabled = true
 * nudge_at = 8
 * hard_nudge_at = 12
 * hard_stop_at = 16
 *
 * # Loop-steering policies that are skipped for this run (union with the
 * # dedicated knobs above: todo_gate / anti_dead_loop.enabled all still work
 * # and map to the same hooks).
 * disabled_loop_hooks = ["builtin.premature-stop"]
 *
 * # User hooks are declared in hook.json files (the ecosystem shape shared
 * # with Claude Code settings.json / ZCode plugin hooks.json); the config
 * # only records their paths. `~` is expanded; relative paths resolve
 * # against the config root (~/.duya).
 * # `disabled` lists individual hook ids (`file:<entry>:<event>:<matcher>:<hook>`)
 * # to skip — the Settings → Hooks page writes these from its toggles.
 * [hooks]
 * files = ["~/duya-hooks.json", "E:/projects/x/hooks.json"]
 * disabled = ["file:~/duya-hooks.json:PreToolUse:0:0"]
 * ```
 *
 * Env overrides: `DUYA_STEERING_TODO_GATE`, `DUYA_STEERING_ANTI_DEAD_LOOP`,
 * `DUYA_STEERING_DEAD_LOOP_NUDGE_AT`, `DUYA_STEERING_DEAD_LOOP_HARD_NUDGE_AT`,
 * `DUYA_STEERING_DEAD_LOOP_HARD_STOP_AT`.
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
import type { HooksSettings, HookMatcher } from './types.js';
import { parseHooksJsonContent, mergeHooksSettings } from './hooks-json.js';
import { PluginTrustLevel, TRUST_LEVEL_CAPABILITIES } from '@duya/plugin-core';
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
  /**
   * Builtin loop-hook ids skipped for this run (e.g. "builtin.premature-stop").
   * Union with the dedicated knobs above — a hook fires only when neither the
   * dedicated knob nor this list disables it.
   */
  disabledLoopHooks: string[];
}

const DEFAULTS: SteeringConfig = {
  todoGateEnabled: true,
  antiDeadLoop: { enabled: true, nudgeAt: 8, hardNudgeAt: 12, hardStopAt: 16 },
  disabledLoopHooks: [],
};

/** Config root: `~/.duya` (or `~/.duya/test-namespaces/<ns>` in test mode). */
export function resolveConfigRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}

interface SteeringToml {
  todo_gate?: unknown;
  disabled_loop_hooks?: unknown;
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
    disabledLoopHooks: [...DEFAULTS.disabledLoopHooks],
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
        if (Array.isArray(steering.disabled_loop_hooks)) {
          config.disabledLoopHooks = steering.disabled_loop_hooks.filter(
            (x): x is string => typeof x === 'string',
          );
        }
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
 * One plugin-contributed hook file, paired with the trust level that gates it.
 *
 * Plan 583 phase G2. A plugin's `hooks/hooks.json` uses the same ecosystem
 * shape as a user hook file and is parsed by the same loader, but until now
 * nothing fed plugin files in here — the only writer of `[hooks] files` was the
 * `hooks add` CLI, so plugin-declared hooks were discovered and counted in the
 * plugin catalog yet never ran. This is the bridge: the agent resolves enabled
 * plugins to their install paths and passes the resulting `hooks/hooks.json`
 * paths in, each tagged with the plugin's registry trust level.
 *
 * The trust level is not optional and not defaulted. G2 initially shipped
 * without it, which meant a plugin of any trust level could declare an
 * `http` hook and have the executor POST the hook input — including
 * `UserPromptSubmit.prompt` and `PreToolUse.tool_input` — to a URL the
 * plugin chose. `TRUST_LEVEL_CAPABILITIES` has always said `allowHttpHooks`
 * is false below `official`; nothing read it. Carrying the level here is
 * what lets {@link gatePluginHooks} enforce that at the one place every
 * consumer already goes through.
 *
 * Absolute paths only, and each must already exist — the caller filters,
 * so a stale or removed plugin contributes nothing rather than a WARN per turn.
 *
 * No cache concerns: `readHooksConfig` re-reads every file on each call, so a
 * hook file edited on disk takes effect on the next turn.
 */
export interface PluginHookFile {
  path: string;
  trustLevel: PluginTrustLevel;
  /**
   * Whether this plugin's `command` / `process` hooks may run.
   *
   * Those two hook types are arbitrary local code execution: `command` goes
   * through the shell with `cwd` set to the session working directory,
   * `process` execs directly, and a `node` command is rewritten onto the app's
   * own Electron runtime. First-party plugins are exempt; every other origin
   * needs a recorded `granted` from the user.
   *
   * Resolved by the caller rather than here, so this module stays free of IPC
   * and the gate below stays a pure function of its input. It is required, not
   * optional: a caller must state the answer, so a forgotten consent lookup
   * cannot silently widen what runs.
   */
  localExecutionAllowed: boolean;
}

let extraHookFiles: readonly PluginHookFile[] = [];

const TRUST_LEVEL_VALUES: readonly string[] = Object.values(PluginTrustLevel);

/** Narrow an untrusted value to a {@link PluginTrustLevel}, or reject it. */
export function isPluginTrustLevel(value: unknown): value is PluginTrustLevel {
  return typeof value === 'string' && TRUST_LEVEL_VALUES.includes(value);
}

export function setExtraHookFiles(files: readonly PluginHookFile[]): void {
  // An entry with an unrecognized trust level is dropped rather than
  // defaulted. Defaulting would silently grant the permissive branch of
  // every gate below, which is the wrong direction to fail.
  extraHookFiles = files.filter(
    (f): f is PluginHookFile =>
      !!f && typeof f.path === 'string' && f.path.length > 0 && isPluginTrustLevel(f.trustLevel),
  );
}

export function getExtraHookFiles(): readonly PluginHookFile[] {
  return extraHookFiles;
}

/**
 * Enforce the trust engine's declared capabilities on one plugin hook file.
 *
 * Three rules, all taken from a decision that already exists rather than
 * invented here:
 *
 *  - `allowHttpHooks` / `allowAgentHooks` gate the two hook types that can
 *    reach outside the box.
 *  - `maxHooks` caps the hook commands contributed by a single plugin, so a
 *    plugin cannot register an unbounded number of dispatch sites.
 *  - `command` / `process` hooks may run only when the caller resolved the
 *    user's consent into {@link PluginHookFile.localExecutionAllowed}. These
 *    are the hook types that spawn something on the user's machine.
 *
 * Dropping is per hook, not per file: a plugin whose consent is missing still
 * keeps the hook types that are safe to run, so refusing local execution does
 * not silently disable an unrelated prompt hook.
 *
 * Returns the surviving hooks. An unknown trust level yields undefined, so
 * the file contributes nothing.
 */
function gatePluginHooks(
  settings: HooksSettings,
  file: PluginHookFile,
): HooksSettings | undefined {
  const caps = TRUST_LEVEL_CAPABILITIES[file.trustLevel];
  if (!caps) {
    logger.warn(
      `[HooksConfig] ${file.path}: unknown trust level (plugin hooks skipped)`,
    );
    return undefined;
  }

  const gated: HooksSettings = {};
  let kept = 0;
  let dropped = 0;

  for (const [event, matchers] of Object.entries(settings)) {
    if (!Array.isArray(matchers)) continue;
    const keptMatchers: HookMatcher[] = [];
    for (const matcher of matchers) {
      const keptHooks = [];
      for (const hook of matcher.hooks ?? []) {
        const permitted =
          hook.type === 'http'
            ? caps.allowHttpHooks
            : hook.type === 'agent'
              ? caps.allowAgentHooks
              : hook.type === 'command' || hook.type === 'process'
                ? file.localExecutionAllowed
                : true;
        if (!permitted || kept >= caps.maxHooks) {
          dropped += 1;
          continue;
        }
        kept += 1;
        keptHooks.push(hook);
      }
      if (keptHooks.length > 0) keptMatchers.push({ ...matcher, hooks: keptHooks });
    }
    if (keptMatchers.length > 0) {
      (gated as Record<string, unknown>)[event] = keptMatchers;
    }
  }

  if (dropped > 0) {
    logger.warn(
      `[HooksConfig] ${file.path}: dropped ${dropped} hook(s) not permitted at trust level ${file.trustLevel} ` +
        `(allowed: ${kept})`,
    );
  }
  return Object.keys(gated).length > 0 ? gated : undefined;
}

/**
 * Read every hook file in `files` and return the per-file parse results, in
 * file order. Shared by the config.toml path and the plugin path so both get
 * identical unreadable-file and parse-failure handling.
 */
function loadHookFileParts(
  files: readonly string[],
  disabledSet: ReadonlySet<string>,
  baseDir: string,
  readFile: (p: string) => string,
): Array<HooksSettings | undefined> {
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
    const parsed = parseHooksJsonContent(body, filePath);
    parts.push(parsed ? filterDisabledHooks(parsed, disabledSet, entry) : undefined);
  }
  return parts;
}

/**
 * Read and gate every plugin hook file, in file order. Mirrors
 * `loadHookFileParts` for the read/parse failure handling, then applies
 * {@link gatePluginHooks} with each file's own trust level.
 *
 * Plugin paths are absolute and are not addressable by the `[hooks] disabled`
 * id scheme, which is keyed on the config.toml entry string. So they get an
 * empty disabled set rather than a wrong one.
 */
function loadPluginHookParts(
  files: readonly PluginHookFile[],
  readFile: (p: string) => string,
): Array<HooksSettings | undefined> {
  const parts: Array<HooksSettings | undefined> = [];
  for (const file of files) {
    let body: string;
    try {
      body = readFile(file.path);
    } catch (err) {
      logger.warn(
        `[HooksConfig] hook file not readable (skipped): ${file.path} (${err instanceof Error ? err.message : String(err)})`,
      );
      continue;
    }
    const parsed = parseHooksJsonContent(body, file.path);
    parts.push(parsed ? gatePluginHooks(parsed, file) : undefined);
  }
  return parts;
}

/**
 * Read the `[hooks]` section. Returns undefined when the section is absent,
 * `files` is missing/empty, any referenced file fails to parse, or the
 * section fails validation — hooks are strictly optional and
 * misconfiguration must never break the agent loop (fail-open, per-file
 * WARNs from the loader). NOT cached — each call re-reads config.toml and
 * every hook file so edits apply to the next streamChat (hot reload).
 *
 * Plugin-contributed files (see `setExtraHookFiles`) are merged in after the
 * config.toml ones, so their hooks fire after the user's own for the same
 * event. They apply even when there is no config.toml at all: a user with no
 * `[hooks]` section must still get their plugins' hooks. Each plugin file is
 * passed through {@link gatePluginHooks} first, so the trust engine's declared
 * capabilities apply before any plugin hook can run.
 */
export function readHooksConfig(): HooksSettings | undefined {
  const configRoot = resolveConfigRoot();
  const configPath = path.join(configRoot, 'config.toml');
  const raw = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf-8') : '';
  const readFile = (p: string): string => fs.readFileSync(p, 'utf-8');

  const fromConfig = _readHooksConfigFromRaw(raw, { baseDir: configRoot, readFile });
  if (extraHookFiles.length === 0) return fromConfig;

  // Plugin hook files are absolute and are not addressable by the
  // `[hooks] disabled` id scheme, which is keyed on the config.toml entry
  // string. So they get an empty disabled set rather than a wrong one, and
  // instead go through the trust gate.
  const pluginParts = loadPluginHookParts(extraHookFiles, readFile);
  return mergeHooksSettings([fromConfig, ...pluginParts]);
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
  let disabled: string[] = [];
  try {
    const parsed = HooksTomlSchema.strict().parse(hooks);
    files = parsed.files ?? [];
    disabled = parsed.disabled ?? [];
  } catch (err) {
    logger.warn(
      `[HooksConfig] invalid [hooks] section ignored: ${err instanceof Error ? err.message : String(err)}`,
    );
    return undefined;
  }
  if (files.length === 0) return undefined;

  const disabledSet = new Set(disabled);
  const baseDir = deps.baseDir ?? resolveConfigRoot();
  const readFile = deps.readFile ?? ((p: string) => fs.readFileSync(p, 'utf-8'));
  return mergeHooksSettings(loadHookFileParts(files, disabledSet, baseDir, readFile));
}

/** Hook-file list schema for the `[hooks]` section. */
const HooksTomlSchema = z.object({
  files: z.array(z.string()).optional(),
  /** Individual hook ids to skip (see {@link hookDisabledId}). */
  disabled: z.array(z.string()).optional(),
});

/**
 * Stable id of one configured hook within a hook.json file: the raw
 * `[hooks] files` entry (e.g. `~/duya-hooks.json`) plus the event, matcher
 * group index and hook index. The Settings → Hooks page toggles write these
 * ids into `[hooks] disabled`; the electron overview handler mirrors this
 * function so both sides address the same hooks.
 */
export function hookDisabledId(
  entry: string,
  event: string,
  matcherIdx: number,
  hookIdx: number,
): string {
  return `file:${entry}:${event}:${matcherIdx}:${hookIdx}`;
}

/**
 * Drop matcher groups / hook entries whose {@link hookDisabledId} is in the
 * disabled set. Returns the input when nothing is disabled; otherwise a new
 * HooksSettings with the removed entries (matcher groups left empty are
 * dropped entirely).
 */
export function filterDisabledHooks(
  settings: HooksSettings,
  disabled: ReadonlySet<string>,
  entry: string,
): HooksSettings {
  if (disabled.size === 0) return settings;
  const out: HooksSettings = {};
  for (const [event, matchers] of Object.entries(settings)) {
    const kept: HookMatcher[] = [];
    matchers.forEach((matcher, mi) => {
      const keptHooks = matcher.hooks.filter(
        (_, hi) => !disabled.has(hookDisabledId(entry, event, mi, hi)),
      );
      if (keptHooks.length === 0) return;
      kept.push(keptHooks.length === matcher.hooks.length ? matcher : { ...matcher, hooks: keptHooks });
    });
    if (kept.length > 0) out[event as keyof HooksSettings] = kept;
  }
  return out;
}

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
