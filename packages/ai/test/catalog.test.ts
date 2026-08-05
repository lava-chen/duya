import { describe, it, expect } from 'vitest';
import { createProviderCatalog, type ProviderCatalogEntry } from '../src/providers/catalog.js';

const entries: ProviderCatalogEntry[] = [
  { id: 'minimax-cn', name: 'MiniMax (CN)', descriptionZh: 'MiniMax 编程套餐 — 中国区', protocol: 'anthropic', authTypes: ['auth_token'], baseUrl: 'https://api.minimaxi.com/anthropic', iconKey: 'minimax', defaultModels: [{ modelId: 'MiniMax-M3', displayName: 'MiniMax-M3' }] },
];

describe('ProviderCatalog', () => {
  it('lists and gets entries', () => {
    const c = createProviderCatalog(entries);
    expect(c.list()).toHaveLength(1);
    expect(c.get('minimax-cn')?.name).toBe('MiniMax (CN)');
  });
  it('filters by protocol', () => {
    const c = createProviderCatalog(entries);
    expect(c.byProtocol('anthropic')).toHaveLength(1);
    expect(c.byProtocol('ollama')).toHaveLength(0);
  });
});