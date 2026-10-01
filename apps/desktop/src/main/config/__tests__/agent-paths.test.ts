import { describe, it, expect } from 'vitest';
import path from 'path';
import {
  getDuyaAgentsRoot,
  resolveDuyaAgentDir,
  getBotProfilePath,
  getBotSettingsPath,
  getBotStateDir,
  getBotMemoryDir,
} from '../agent-paths';

const ROOT = path.join('C:', 'duya-home');

describe('agent-paths (Plan 485 P1.1)', () => {
  it('derives the agents root under the duya root', () => {
    expect(getDuyaAgentsRoot(ROOT)).toBe(path.join(ROOT, 'agents'));
  });

  it('resolves agent dir = root/agents/<id>', () => {
    expect(resolveDuyaAgentDir('frontend-expert', ROOT)).toBe(
      path.join(ROOT, 'agents', 'frontend-expert'),
    );
  });

  it('derives profile/settings/state/memory paths under the agent dir', () => {
    const agentDir = path.join(ROOT, 'agents', 'alpha');
    expect(getBotProfilePath('alpha', ROOT)).toBe(path.join(agentDir, 'profile.json'));
    expect(getBotSettingsPath('alpha', ROOT)).toBe(path.join(agentDir, 'settings.json'));
    expect(getBotStateDir('alpha', ROOT)).toBe(path.join(agentDir, 'state'));
    expect(getBotMemoryDir('alpha', ROOT)).toBe(path.join(agentDir, 'memory'));
  });

  it('rejects ids that would escape the agents root', () => {
    expect(() => resolveDuyaAgentDir('..', ROOT)).toThrow(/Invalid bot id/);
    expect(() => resolveDuyaAgentDir('../etc', ROOT)).toThrow(/Invalid bot id/);
    expect(() => resolveDuyaAgentDir('a/b', ROOT)).toThrow(/Invalid bot id/);
    expect(() => resolveDuyaAgentDir('a\\b', ROOT)).toThrow(/Invalid bot id/);
    expect(() => resolveDuyaAgentDir('UPPER', ROOT)).toThrow(/Invalid bot id/);
  });

  it('never lets a resolved path leave the agents root for any rejected id', () => {
    for (const bad of ['..', '../x', 'a/b', 'a\\b', '.', 'UPPER', 'a b']) {
      expect(() => resolveDuyaAgentDir(bad, ROOT)).toThrow();
    }
  });
});
