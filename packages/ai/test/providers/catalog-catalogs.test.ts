/**
 * packages/ai/test/providers/catalog-catalogs.test.ts
 *
 * Plan 451 Phase 6: catalog registration test. Verifies that the new
 * bedrock + google catalogs are well-formed and reachable from the
 * builtin providers / allProviderModels list.
 */

import { describe, it, expect } from 'vitest';
import { allProviders } from '../../src/providers/all.js';
import { bedrock } from '../../src/providers/bedrock.js';
import { google } from '../../src/providers/google.js';
import { bedrockModels } from '../../src/providers/bedrock.models.js';
import { googleModels } from '../../src/providers/google.models.js';
import { allProviderModels } from '../../src/providers/index.js';

describe('bedrock + google catalogs (Plan 451 Phase 6)', () => {
  it('bedrock provider is registered with models', () => {
    expect(bedrock.id).toBe('bedrock');
    const models = bedrock.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.api).toBe('bedrock');
  });

  it('google provider is registered with models', () => {
    expect(google.id).toBe('google');
    const models = google.getModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models[0]?.api).toBe('gemini');
  });

  it('all bedrock models have the bedrock api and providerId', () => {
    for (const m of bedrockModels) {
      expect(m.api).toBe('bedrock');
      expect(m.providerId).toBe('bedrock');
      expect(m.baseUrl).toContain('bedrock-runtime');
    }
  });

  it('all google models have the gemini api and providerId', () => {
    for (const m of googleModels) {
      expect(m.api).toBe('gemini');
      expect(m.providerId).toBe('google');
      expect(m.baseUrl).toContain('generativelanguage');
    }
  });

  it('bedrock and google appear in allProviders', () => {
    expect(allProviders.some((p) => p.id === 'bedrock')).toBe(true);
    expect(allProviders.some((p) => p.id === 'google')).toBe(true);
  });

  it('allProviderModels includes bedrock and google models', () => {
    const ids = new Set(allProviderModels.map((m) => `${m.providerId}:${m.id}`));
    expect(ids.has(`bedrock:${bedrockModels[0]!.id}`)).toBe(true);
    expect(ids.has(`google:${googleModels[0]!.id}`)).toBe(true);
  });
});