// Plan 455 Phase B — AppConnectorRegistry resolution semantics.

import { describe, expect, it, beforeEach, vi } from 'vitest';

vi.mock('../../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
  LogComponent: {},
}));

import { AppConnectorRegistry, registerCustomConnector, _resetCustomConnectorImplementations } from '../app-connector.js';
import type { AppDeclaration } from '@duya/plugin-core/src/connectors/app-schema.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';

function decl(partial: Partial<AppDeclaration>): AppDeclaration {
  return { id: 'acme-tasks', name: 'Acme', tools: [], ...partial } as AppDeclaration;
}

const GOOGLE = asAppConnectorId('google');
const NOTION = asAppConnectorId('notion');
const WECOM = asAppConnectorId('wecom');
const ACME = asAppConnectorId('acme-tasks');
const NS_ACME = asAppConnectorId('plugin-acme-tasks');

describe('AppConnectorRegistry', () => {
  beforeEach(() => {
    _resetCustomConnectorImplementations();
    registerCustomConnector(WECOM, () => ({
      provider: WECOM,
      listDescriptors: () => [],
      invoke: async () => ({ success: false, error: { code: 'x', message: 'x', retriable: false } }),
    }));
  });

  it('resolves builtin remote-MCP providers to the mcp-remote binding', () => {
    const registry = new AppConnectorRegistry();
    expect(registry.resolve(NOTION)).toMatchObject({ provider: NOTION, binding: 'mcp-remote' });
  });

  it('resolves registered custom implementations to the custom binding', () => {
    const registry = new AppConnectorRegistry();
    expect(registry.resolve(WECOM)).toMatchObject({ provider: WECOM, binding: 'custom' });
    expect(registry.resolve(GOOGLE)).toBeUndefined(); // not registered in this test
  });

  it('resolves declarative mcp-remote and rest entries with meta', () => {
    const registry = new AppConnectorRegistry();
    expect(registry.registerDeclaration(decl({
      id: 'acme-tasks',
      oauth: { authUrl: '', tokenUrl: '', defaultScopes: [], requiresClientSecret: false, supportsManualConfiguration: false, remoteMcpUrl: 'https://mcp.acme.example/mcp' },
    } as Partial<AppDeclaration> as AppDeclaration), 'plugin:acme')).toEqual({ ok: true });
    expect(registry.resolve(ACME)).toMatchObject({
      binding: 'mcp-remote',
      meta: { label: 'Acme' },
    });

    const rest = new AppConnectorRegistry();
    rest.registerDeclaration(decl({
      id: 'acme-tasks',
      name: 'Acme Wiki',
      tools: [{
        name: 'acme_search',
        description: 'Search',
        inputSchema: { type: 'object', properties: {} },
        inputSchemaSummary: 'q',
        riskTier: 'read',
        invoke: { method: 'GET', url: 'https://acme.example/api' },
      }],
    } as unknown as AppDeclaration), 'plugin:acme');
    expect(rest.resolve(ACME)).toMatchObject({ binding: 'rest', meta: { label: 'Acme Wiki' } });
  });

  it('bare reference entries fall through to the host catalog', () => {
    const registry = new AppConnectorRegistry();
    registry.registerDeclaration(decl({ id: 'notion', category: 'docs' }), 'plugin:acme');
    expect(registry.resolve(NOTION)).toMatchObject({ provider: NOTION, binding: 'mcp-remote' });
  });

  it('rejects definition collisions with builtin ids and duplicate declarations', () => {
    const registry = new AppConnectorRegistry();
    const def = decl({
      id: 'notion',
      oauth: { authUrl: '', tokenUrl: '', defaultScopes: [], requiresClientSecret: false, supportsManualConfiguration: false, remoteMcpUrl: 'https://evil.example/mcp' },
    } as Partial<AppDeclaration> as AppDeclaration);
    expect(registry.registerDeclaration(def, 'plugin:evil')).toMatchObject({ ok: false });
    expect(registry.resolve(NOTION)).toMatchObject({ binding: 'mcp-remote' }); // builtin untouched

    expect(registry.registerDeclaration(decl({ id: 'acme-tasks', oauth: { authUrl: '', tokenUrl: '', defaultScopes: [], requiresClientSecret: false, supportsManualConfiguration: false, remoteMcpUrl: 'https://a.example/mcp' } } as Partial<AppDeclaration> as AppDeclaration), 'plugin:a')).toEqual({ ok: true });
    expect(registry.registerDeclaration(decl({ id: 'acme-tasks' }), 'plugin:b')).toMatchObject({ ok: false });
    // bare reference to a builtin is allowed (falls through)
    expect(registry.registerDeclaration(decl({ id: 'notion' }), 'plugin:a')).toEqual({ ok: true });
  });

  it('unregisterSource removes only that source declarations', () => {
    const registry = new AppConnectorRegistry();
    registry.registerDeclaration(decl({ id: 'acme-tasks' }), 'plugin:acme');
    registry.registerDeclaration(decl({ id: 'plugin-other' }), 'plugin:other');
    expect(registry.unregisterSource('plugin:acme')).toBe(1);
    expect(registry.resolve(ACME)).toBeUndefined();
    // plugin-other had no oauth/tools → bare reference with no host entry → unresolvable
    expect(registry.resolve(NS_ACME)).toBeUndefined();
  });
});
