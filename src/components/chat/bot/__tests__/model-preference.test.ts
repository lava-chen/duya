// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest';
import {
  loadBotModelPreference,
  saveBotModelPreference,
} from '../model-preference';

describe('bot model preference persistence', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns null when nothing is stored', () => {
    expect(loadBotModelPreference('bot:test1')).toBeNull();
  });

  it('round-trips a saved preference', () => {
    saveBotModelPreference('bot:test1', {
      model: 'glm-4',
      providerId: 'zhipu',
      effort: 'high',
    });
    const pref = loadBotModelPreference('bot:test1');
    expect(pref).not.toBeNull();
    expect(pref?.model).toBe('glm-4');
    expect(pref?.providerId).toBe('zhipu');
    expect(pref?.effort).toBe('high');
    expect(typeof pref?.updatedAt).toBe('number');
  });

  it('isolates preferences per bot id', () => {
    saveBotModelPreference('bot:a', { model: 'm1' });
    saveBotModelPreference('bot:b', { model: 'm2' });
    expect(loadBotModelPreference('bot:a')?.model).toBe('m1');
    expect(loadBotModelPreference('bot:b')?.model).toBe('m2');
  });

  it('treats a missing model as corrupt and drops the record', () => {
    localStorage.setItem('bot-model-pref:bot:x', JSON.stringify({ effort: 'low' }));
    expect(loadBotModelPreference('bot:x')).toBeNull();
    expect(localStorage.getItem('bot-model-pref:bot:x')).toBeNull();
  });

  it('treats malformed JSON as absent', () => {
    localStorage.setItem('bot-model-pref:bot:y', 'not-json{');
    expect(loadBotModelPreference('bot:y')).toBeNull();
  });
});
