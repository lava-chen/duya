// Plan 455 Phase B — `.app.json` declaration schema (packages/plugin-core).

import { describe, expect, it } from 'vitest';
import {
  AppDeclarationFileSchema,
  parseAppDeclarationFile,
} from '../src/connectors/app-schema.js';
import {
  asAppConnectorId,
  isBuiltinConnectorId,
  isWellFormedConnectorId,
  pluginConnectorId,
} from '../src/connectors/app-connector-id.js';

const VALID_FILE = JSON.stringify({
  apps: [
    // definition entry — remote MCP connector with oauth client data
    {
      id: 'acme-tasks',
      name: 'Acme Tasks',
      category: 'productivity',
      interface: { label: 'Acme', monogram: 'A', description: 'Task tracking' },
      oauth: {
        authUrl: 'https://acme.example/oauth/authorize',
        tokenUrl: 'https://acme.example/oauth/token',
        redirectPath: '/callback/acme',
        defaultScopes: ['tasks:read'],
        supportsManualConfiguration: true,
        clientId: 'acme-public-client',
      },
      tools: [],
    },
    // definition entry — REST template tool (Plan 460 binding)
    {
      id: 'acme-wiki',
      oauth: { remoteMcpUrl: undefined, authUrl: 'https://acme.example/oauth/authorize', tokenUrl: 'https://acme.example/oauth/token' },
      tools: [
        {
          name: 'acme_search_wiki',
          description: 'Search the Acme wiki',
          inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
          inputSchemaSummary: 'query: string',
          riskTier: 'read',
          invoke: {
            method: 'GET',
            url: 'https://acme.example/api/wiki',
            query: { q: '${args.query}' },
            headers: { Authorization: 'Bearer ${accessToken}' },
            response: { ok: 'body.ok', errorPath: 'body.error', errorTemplate: 'Acme error: ${body.error}' },
          },
        },
      ],
    },
    // bare reference entry (Plan 452 subset)
    { id: 'notion', category: 'docs' },
  ],
});

describe('app-connector-id', () => {
  it('brands plain strings and recognizes builtins', () => {
    expect(isBuiltinConnectorId('google')).toBe(true);
    expect(isBuiltinConnectorId('plugin-acme-tasks')).toBe(false);
    expect(isWellFormedConnectorId('acme-tasks')).toBe(true);
    expect(isWellFormedConnectorId('Acme Tasks')).toBe(false);
    expect(pluginConnectorId('acme', 'tasks')).toBe('plugin-acme-tasks');
    // branded ids are strings at runtime
    expect(asAppConnectorId('google')).toBe('google');
  });
});

describe('AppDeclarationFileSchema', () => {
  it('accepts definition and reference entries', () => {
    const result = AppDeclarationFileSchema.safeParse(JSON.parse(VALID_FILE));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.apps).toHaveLength(3);
      expect(result.data.apps[0].oauth?.clientId).toBe('acme-public-client');
      expect(result.data.apps[1].tools[0].invoke?.method).toBe('GET');
      // defaults applied
      expect(result.data.apps[1].tools[0].invoke?.response?.retryableStatus).toEqual([502, 503, 504]);
    }
  });

  it('rejects http (non-https) URLs', () => {
    const result = AppDeclarationFileSchema.safeParse({
      apps: [{ id: 'x', oauth: { remoteMcpUrl: 'http://insecure.example/mcp' } }],
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-snake_case tool names and bad ids', () => {
    expect(
      AppDeclarationFileSchema.safeParse({
        apps: [{ id: 'x', tools: [{ name: 'SearchWiki', description: 'd', inputSchema: { type: 'object', properties: {} }, inputSchemaSummary: 's', riskTier: 'read' }] }],
      }).success,
    ).toBe(false);
    expect(AppDeclarationFileSchema.safeParse({ apps: [{ id: 'Bad Id' }] }).success).toBe(false);
  });

  it('rejects an unknown riskTier', () => {
    expect(
      AppDeclarationFileSchema.safeParse({
        apps: [{ id: 'x', tools: [{ name: 'a', description: 'd', inputSchema: { type: 'object', properties: {} }, inputSchemaSummary: 's', riskTier: 'apocalyptic' }] }],
      }).success,
    ).toBe(false);
  });
});

describe('parseAppDeclarationFile', () => {
  it('parses a valid file leniently', () => {
    const result = parseAppDeclarationFile(VALID_FILE);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.apps).toHaveLength(3);
  });

  it('returns a structured failure for invalid JSON', () => {
    const result = parseAppDeclarationFile('{ not json');
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('not valid JSON');
  });

  it('returns the first offending path for schema violations', () => {
    const result = parseAppDeclarationFile(JSON.stringify({ apps: [{ id: 'ok' }, { id: 'BAD ID' }] }));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain('apps.1.id');
  });

  it('accepts an empty apps array', () => {
    expect(parseAppDeclarationFile('{}')).toEqual({ ok: true, apps: [], warnings: [] });
  });
});
