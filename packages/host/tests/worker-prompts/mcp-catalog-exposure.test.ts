/**
 * Plan 619 Phase 1 — MCP catalog exposure.
 *
 * The catalog was gated by two different predicates (`=== 'search'` in the
 * session runtime, `!== 'full'` in the legacy agent shell), so the default
 * `hint` configuration injected the catalog on one path and not the other.
 */

import { describe, expect, it } from 'vitest';

import { shouldInjectMcpCatalog } from '@duya/host/worker-config/tool-exposure';

describe('plan 619 phase 1 — MCP catalog exposure', () => {
  it('injects the catalog only when the MCP tools are deferred', () => {
    expect(shouldInjectMcpCatalog('search')).toBe(true);
    expect(shouldInjectMcpCatalog('hint')).toBe(false);
    expect(shouldInjectMcpCatalog('full')).toBe(false);
  });
});
