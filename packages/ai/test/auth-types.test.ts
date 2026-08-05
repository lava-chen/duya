import { describe, it, expect } from 'vitest';
import type { CredentialStore, Credential } from '../src/auth/types.js';

const memStore = (): CredentialStore => {
  const m = new Map<string, Credential>();
  return {
    get: (id) => Promise.resolve(m.get(id)),
    set: (c) => { m.set(c.providerId, c); return Promise.resolve(); },
    delete: (id) => { m.delete(id); return Promise.resolve(); },
    list: () => Promise.resolve([...m.values()]),
  };
};

describe('CredentialStore contract', () => {
  it('round-trips a credential', async () => {
    const s = memStore();
    await s.set({ providerId: 'minimax-cn', type: 'api_key', apiKey: 'sk-x' });
    expect((await s.get('minimax-cn'))?.apiKey).toBe('sk-x');
    await s.delete('minimax-cn');
    expect(await s.get('minimax-cn')).toBeUndefined();
  });
});