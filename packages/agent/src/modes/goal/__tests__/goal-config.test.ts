/**
 * Goal config tests (plan 411 Phase 4).
 *
 * Verifies the `[goal]` config.toml section parsing + env overrides with
 * sane defaults, and that `verifyGoalCompletion` falls back to config
 * values when the caller omits them.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  readGoalConfig,
  getGoalConfig,
  _resetGoalConfigCache,
} from '../goal-config.js';

const TEST_NS = 'goal-config-test';

function writeConfigToml(content: string): void {
  const root = path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS);
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'config.toml'), content, 'utf-8');
}

describe('readGoalConfig', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...originalEnv };
    delete process.env.DUYA_TEST;
    delete process.env.DUYA_TEST_NAMESPACE;
    for (const k of Object.keys(process.env)) {
      if (k.startsWith('DUYA_GOAL_')) delete process.env[k];
    }
    // Clean the test-namespace config so a later test starts fresh.
    try {
      fs.rmSync(path.join(os.homedir(), '.duya', 'test-namespaces', TEST_NS), {
        recursive: true,
        force: true,
      });
    } catch {
      // ignore
    }
    _resetGoalConfigCache();
  });

  it('returns defaults with no config file present', () => {
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = TEST_NS;
    _resetGoalConfigCache();
    const cfg = readGoalConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.verifierCount).toBe(1);
    expect(cfg.strategistEvery).toBe(3);
    expect(cfg.maxNotAchievedRounds).toBe(5);
  });

  it('reads the [goal] section from config.toml', () => {
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = TEST_NS;
    writeConfigToml(`[goal]\nenabled = true\nverifier_count = 3\nstrategist_every = 4\nmax_not_achieved_rounds = 7\n`);
    _resetGoalConfigCache();
    const cfg = readGoalConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.verifierCount).toBe(3);
    expect(cfg.strategistEvery).toBe(4);
    expect(cfg.maxNotAchievedRounds).toBe(7);
  });

  it('clamps out-of-range values', () => {
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = TEST_NS;
    writeConfigToml(`[goal]\nverifier_count = 99\nstrategist_every = 0\nmax_not_achieved_rounds = -3\n`);
    _resetGoalConfigCache();
    const cfg = readGoalConfig();
    expect(cfg.verifierCount).toBe(5);
    expect(cfg.strategistEvery).toBe(1);
    expect(cfg.maxNotAchievedRounds).toBe(1);
  });

  it('env overrides beat the config file', () => {
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = TEST_NS;
    writeConfigToml(`[goal]\nverifier_count = 2\n`);
    process.env.DUYA_GOAL_VERIFIER_COUNT = '4';
    process.env.DUYA_GOAL_ENABLED = 'false';
    _resetGoalConfigCache();
    const cfg = readGoalConfig();
    expect(cfg.verifierCount).toBe(4);
    expect(cfg.enabled).toBe(false);
  });

  it('tolerates a malformed config file', () => {
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = TEST_NS;
    writeConfigToml('this is not [valid toml {{{');
    _resetGoalConfigCache();
    const cfg = readGoalConfig();
    expect(cfg.enabled).toBe(true);
    expect(cfg.verifierCount).toBe(1);
  });

  it('getGoalConfig caches per process', () => {
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = TEST_NS;
    writeConfigToml(`[goal]\nverifier_count = 2\n`);
    _resetGoalConfigCache();
    expect(getGoalConfig().verifierCount).toBe(2);
    // Second call uses the cache (same object identity).
    expect(getGoalConfig()).toBe(getGoalConfig());
  });

  it('verifyGoalCompletion falls back to config defaults when params omit them', async () => {
    // Re-import verifyGoalCompletion with a mocked runAgent to avoid a real
    // spawn. Path is relative to THIS test file (goal/__tests__/) → src/tool.
    vi.resetModules();
    vi.doMock('../../../tool/SubagentTool/runAgent.js', () => ({
      runAgentSync: vi.fn(async () => ({
        id: 'm1',
        role: 'assistant',
        content: 'ok\nVERDICT: PASS',
        timestamp: Date.now(),
      })),
    }));
    process.env.DUYA_TEST = '1';
    process.env.DUYA_TEST_NAMESPACE = TEST_NS;
    writeConfigToml(`[goal]\nverifier_count = 2\n`);
    _resetGoalConfigCache();
    const { verifyGoalCompletion } = await import('../goal-evaluator.js');
    const result = await verifyGoalCompletion({
      objective: 'X',
      finalSummary: 'y',
      context: { options: { tools: [] } } as never,
      agentDefinitions: [{ agentType: 'verification', whenToUse: 'v' } as never],
      // verifierCount omitted → config (2) is used; runAgent mocked so the
      // panel runs 2 skeptics.
    });
    expect(result.verdict).toBe('achieved');
    expect(result.skepticVerdicts).toHaveLength(2);
  });
});
