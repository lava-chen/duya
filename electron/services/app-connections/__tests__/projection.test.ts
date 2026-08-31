// Plan 460 — declaration → provider-config projection tests.

import { describe, expect, it } from 'vitest';
import { declarationToProviderConfig } from '../declarative/projection.js';
import type { AppDeclaration } from '@duya/plugin-core/src/connectors/app-schema.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';

function decl(partial: Partial<AppDeclaration>): AppDeclaration {
  return { id: 'acme-tasks', name: 'Acme', tools: [], ...partial } as AppDeclaration;
}

describe('declarationToProviderConfig', () => {
  it('returns undefined for bare references (no oauth block)', () => {
    expect(declarationToProviderConfig(decl({}))).toBeUndefined();
  });

  it('projects remoteMcpUrl declarations to remote-MCP providers', () => {
    const config = declarationToProviderConfig(decl({
      id: 'acme-tasks',
      oauth: { remoteMcpUrl: 'https://mcp.acme.example/mcp' },
    }));
    expect(config).toMatchObject({
      id: asAppConnectorId('acme-tasks'),
      remoteMcpUrl: 'https://mcp.acme.example/mcp',
      requiresClientSecret: false,
    });
  });

  it('projects oauth authUrl/tokenUrl/clientId', () => {
    const config = declarationToProviderConfig(decl({
      id: 'acme-tasks',
      oauth: {
        authUrl: 'https://auth.acme.example/authorize',
        tokenUrl: 'https://auth.acme.example/token',
        clientId: 'public-client-123',
        defaultScopes: ['read'],
        redirectPath: '/callback/acme-tasks',
      },
    }));
    expect(config).toMatchObject({
      id: asAppConnectorId('acme-tasks'),
      authUrl: 'https://auth.acme.example/authorize',
      tokenUrl: 'https://auth.acme.example/token',
      clientId: 'public-client-123',
      defaultScopes: ['read'],
      redirectPath: '/callback/acme-tasks',
      requiresClientSecret: false,
    });
  });

  it('returns undefined when authUrl or tokenUrl is missing (non-OAuth)', () => {
    expect(declarationToProviderConfig(decl({
      oauth: { authUrl: '', tokenUrl: '', defaultScopes: [] },
    }))).toBeUndefined();
  });

  it('derives label and monogram from interface', () => {
    const config = declarationToProviderConfig(decl({
      oauth: {
        authUrl: 'https://a.example/auth',
        tokenUrl: 'https://a.example/token',
        clientId: 'c',
      },
      interface: { label: 'Acme Tasks', monogram: 'A' },
    }));
    expect(config?.label).toBe('Acme Tasks');
    expect(config?.monogram).toBe('A');
  });

  it('defaults requiresOAuthClient to true and supportsManualConfiguration to false', () => {
    const config = declarationToProviderConfig(decl({
      oauth: {
        authUrl: 'https://a.example/auth',
        tokenUrl: 'https://a.example/token',
        clientId: 'c',
      },
    }));
    expect(config?.requiresOAuthClient).toBe(true);
    expect(config?.supportsManualConfiguration).toBe(false);
  });
});
