import { describe, it, expect } from 'vitest';
import { DEFAULT_CONFIG, mergeConfig, type DuyaConfig } from '../schema';

describe('DuyaConfig schema', () => {
  it('DEFAULT_CONFIG has _config_version 1 and single memory block', () => {
    expect(DEFAULT_CONFIG._config_version).toBe(1);
    expect(DEFAULT_CONFIG.memory).toBeDefined();
    // no top-level provider/model key collision: memory is a single merged block
    expect(DEFAULT_CONFIG.memory.provider).toBe('');
    expect(DEFAULT_CONFIG.memory.model).toBe('');
  });

  it('mergeConfig fills missing keys from defaults and keeps supplied values', () => {
    const merged = mergeConfig({ storage: { database_path: '/custom/db' } });
    expect(merged.storage.database_path).toBe('/custom/db');
    expect(merged.security.secrets_encrypted).toBe(false);
    expect(merged.agent.max_turns).toBe(90);
  });

  it('mergeConfig does not mutate DEFAULT_CONFIG', () => {
    const before = JSON.stringify(DEFAULT_CONFIG);
    mergeConfig({ agent: { max_turns: 5 } } as Partial<DuyaConfig>);
    expect(JSON.stringify(DEFAULT_CONFIG)).toBe(before);
  });
});