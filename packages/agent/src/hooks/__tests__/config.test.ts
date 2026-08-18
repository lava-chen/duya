/**
 * Steering & hooks config tests (plan 426 Phase 4).
 *
 * Verifies the `[steering]` section parsing (defaults, partial overrides,
 * clamps), env overrides, the no-cache (hot reload) semantics, and the
 * `[hooks]` section validation via `_readHooksConfigFromRaw` / `readHooksConfig`.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readSteeringConfig,
  getSteeringConfig,
  readHooksConfig,
  _readHooksConfigFromRaw,
} from '../config.js';

const TEST_NS = 'hooks-config-test';

function writeConfigToml(content: string): void {
  const root = path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.toml'), content, 'utf-8');
}

function stubTestNamespace(): void {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', TEST_NS);
}

afterEach(() => {
  vi.unstubAllEnvs();
  // Clean the test-namespace config so a later test starts fresh.
  try {
    fs.rmSync(path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS), {
      recursive: true,
      force: true,
    });
  } catch {
    // ignore
  }
});

describe('readSteeringConfig', () => {
  it('returns defaults with no config file present', () => {
    stubTestNamespace();
    const cfg = readSteeringConfig();
    expect(cfg.todoGateEnabled).toBe(true);
    expect(cfg.antiDeadLoop).toEqual({ enabled: true, nudgeAt: 8, hardNudgeAt: 12, hardStopAt: 16 });
    expect(cfg.toolIntentNudgeMax).toBe(2);
  });

  it('reads the [steering] section from config.toml', () => {
    stubTestNamespace();
    writeConfigToml([
      '[steering]',
      'todo_gate = false',
      'tool_intent_nudge_max = 3',
      '',
      '[steering.anti_dead_loop]',
      'enabled = false',
      'nudge_at = 5',
      'hard_nudge_at = 9',
      'hard_stop_at = 13',
      '',
    ].join('\n'));
    const cfg = readSteeringConfig();
    expect(cfg.todoGateEnabled).toBe(false);
    expect(cfg.antiDeadLoop).toEqual({ enabled: false, nudgeAt: 5, hardNudgeAt: 9, hardStopAt: 13 });
    expect(cfg.toolIntentNudgeMax).toBe(3);
  });

  it('partial overrides keep the remaining defaults', () => {
    stubTestNamespace();
    writeConfigToml('[steering]\ntodo_gate = false\n');
    const cfg = readSteeringConfig();
    expect(cfg.todoGateEnabled).toBe(false);
    expect(cfg.antiDeadLoop).toEqual({ enabled: true, nudgeAt: 8, hardNudgeAt: 12, hardStopAt: 16 });
    expect(cfg.toolIntentNudgeMax).toBe(2);
  });

  it('clamps out-of-range values to sane ranges', () => {
    stubTestNamespace();
    writeConfigToml([
      '[steering]',
      'tool_intent_nudge_max = 99',
      '',
      '[steering.anti_dead_loop]',
      'nudge_at = 500',
      'hard_nudge_at = 1',
      'hard_stop_at = -7',
      '',
    ].join('\n'));
    const cfg = readSteeringConfig();
    // nudgeAt 2-50, hardNudgeAt 2-50, hardStopAt 2-100, toolIntentNudgeMax 0-10.
    expect(cfg.antiDeadLoop.nudgeAt).toBe(50);
    expect(cfg.antiDeadLoop.hardNudgeAt).toBe(2);
    expect(cfg.antiDeadLoop.hardStopAt).toBe(2);
    expect(cfg.toolIntentNudgeMax).toBe(10);
  });

  it('non-numeric TOML values fall back to defaults', () => {
    stubTestNamespace();
    writeConfigToml('[steering]\ntodo_gate = "yes"\ntool_intent_nudge_max = "many"\n');
    const cfg = readSteeringConfig();
    expect(cfg.todoGateEnabled).toBe(true);
    expect(cfg.toolIntentNudgeMax).toBe(2);
  });

  it('env overrides beat the config file', () => {
    stubTestNamespace();
    writeConfigToml('[steering]\ntodo_gate = true\ntool_intent_nudge_max = 4\n');
    vi.stubEnv('DUYA_STEERING_TODO_GATE', '0');
    vi.stubEnv('DUYA_STEERING_ANTI_DEAD_LOOP', '0');
    vi.stubEnv('DUYA_STEERING_DEAD_LOOP_NUDGE_AT', '5');
    vi.stubEnv('DUYA_STEERING_DEAD_LOOP_HARD_NUDGE_AT', '7');
    vi.stubEnv('DUYA_STEERING_DEAD_LOOP_HARD_STOP_AT', '9');
    vi.stubEnv('DUYA_STEERING_TOOL_INTENT_NUDGE_MAX', '3');
    const cfg = readSteeringConfig();
    expect(cfg.todoGateEnabled).toBe(false);
    expect(cfg.antiDeadLoop.enabled).toBe(false);
    expect(cfg.antiDeadLoop.nudgeAt).toBe(5);
    expect(cfg.antiDeadLoop.hardNudgeAt).toBe(7);
    expect(cfg.antiDeadLoop.hardStopAt).toBe(9);
    expect(cfg.toolIntentNudgeMax).toBe(3);
  });

  it('env overrides are clamped too', () => {
    stubTestNamespace();
    vi.stubEnv('DUYA_STEERING_DEAD_LOOP_NUDGE_AT', '999');
    vi.stubEnv('DUYA_STEERING_TOOL_INTENT_NUDGE_MAX', '-4');
    const cfg = readSteeringConfig();
    expect(cfg.antiDeadLoop.nudgeAt).toBe(50);
    expect(cfg.toolIntentNudgeMax).toBe(0);
  });

  it('tolerates a malformed config file', () => {
    stubTestNamespace();
    writeConfigToml('this is not [valid toml {{{');
    const cfg = readSteeringConfig();
    expect(cfg.todoGateEnabled).toBe(true);
    expect(cfg.antiDeadLoop.nudgeAt).toBe(8);
  });

  it('has no module-level cache — re-reads on every call (hot reload)', () => {
    stubTestNamespace();
    writeConfigToml('[steering]\ntool_intent_nudge_max = 1\n');
    expect(readSteeringConfig().toolIntentNudgeMax).toBe(1);
    // Rewrite the file; the next read must pick the new value up immediately.
    writeConfigToml('[steering]\ntool_intent_nudge_max = 6\n');
    expect(readSteeringConfig().toolIntentNudgeMax).toBe(6);
    // getSteeringConfig is a fresh-read alias, not a cached singleton.
    expect(getSteeringConfig().toolIntentNudgeMax).toBe(6);
  });
});

describe('_readHooksConfigFromRaw', () => {
  it('parses a valid [hooks] section', () => {
    const raw = [
      '[hooks]',
      'PreTurn = [{ hooks = [{ type = "command", command = "echo hi" }] }]',
      'PostToolUse = [{ matcher = "Read", hooks = [{ type = "http", url = "http://127.0.0.1:1/x" }] }]',
      '',
    ].join('\n');
    const settings = _readHooksConfigFromRaw(raw);
    expect(settings).toBeDefined();
    expect(settings?.PreTurn).toHaveLength(1);
    expect(settings?.PreTurn?.[0].hooks[0]).toEqual({ type: 'command', command: 'echo hi' });
    expect(settings?.PostToolUse?.[0].matcher).toBe('Read');
    expect(settings?.PostToolUse?.[0].hooks[0].type).toBe('http');
  });

  it('returns undefined when the section is absent', () => {
    expect(_readHooksConfigFromRaw('[goal]\nenabled = true\n')).toBeUndefined();
    expect(_readHooksConfigFromRaw('')).toBeUndefined();
  });

  it('returns undefined on an invalid section', () => {
    // Matchers must be an array of objects with a `hooks` array.
    expect(_readHooksConfigFromRaw('[hooks]\nPreTurn = "not-an-array"\n')).toBeUndefined();
    // Unknown event keys fail the strict schema.
    expect(_readHooksConfigFromRaw('[hooks]\nNotAnEvent = [{ hooks = [] }]\n')).toBeUndefined();
    // Malformed TOML.
    expect(_readHooksConfigFromRaw('[hooks\nbroken {{{')).toBeUndefined();
  });
});

describe('readHooksConfig', () => {
  it('reads and validates [hooks] from the namespaced config.toml', () => {
    stubTestNamespace();
    writeConfigToml('[hooks]\nPostTurn = [{ hooks = [{ type = "command", command = "echo done" }] }]\n');
    const settings = readHooksConfig();
    expect(settings?.PostTurn).toHaveLength(1);
    expect(settings?.PostTurn?.[0].hooks[0]).toMatchObject({ type: 'command', command: 'echo done' });
  });

  it('returns undefined when no config file exists', () => {
    stubTestNamespace();
    expect(readHooksConfig()).toBeUndefined();
  });

  it('returns undefined when the section is absent or invalid', () => {
    stubTestNamespace();
    writeConfigToml('[goal]\nenabled = true\n');
    expect(readHooksConfig()).toBeUndefined();
    writeConfigToml('[hooks]\nPreTurn = 3\n');
    expect(readHooksConfig()).toBeUndefined();
  });
});
