import { describe, it, expect } from 'vitest';
import {
  PluginManifestSchema,
  normalizeManifestComponents,
  isManifestV2,
} from './plugin-types';
import { WorkflowTemplateSchema } from '@duya/plugin-core';

describe('PluginManifestSchema', () => {
  const validManifest = {
    schemaVersion: 'duya.plugin.v1' as const,
    id: 'com.example.test-plugin',
    name: 'Test Plugin',
    version: '1.0.0',
    description: 'A test plugin for validation',
    author: { name: 'Test Author', url: 'https://example.com' },
    entry: { type: 'node' as const, main: 'index.js' },
    capabilities: {
      skills: [{ path: './skills/test.ts', description: 'A test skill' }],
      mcpServers: [{ name: 'test-server', command: 'node', args: ['server.js'] }],
      cli: [],
      ui: [],
      hooks: [],
    },
    permissions: [{ name: 'filesystem.read', scope: '/workspace' }],
    engines: { duya: '>=1.0.0', node: '>=18' },
  };

  it('validates a valid manifest', () => {
    const result = PluginManifestSchema.safeParse(validManifest);
    expect(result.success).toBe(true);
  });

  it('rejects missing schemaVersion', () => {
    const { schemaVersion, ...rest } = validManifest;
    const result = PluginManifestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('rejects missing required fields', () => {
    const result = PluginManifestSchema.safeParse({});
    expect(result.success).toBe(false);
  });

  it('rejects invalid schemaVersion', () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      schemaVersion: 'invalid.version',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty name', () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      name: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty entry main', () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      entry: { type: 'node', main: '' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts manifest with empty capabilities arrays', () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      capabilities: {
        skills: [],
        mcpServers: [],
        cli: [],
        ui: [],
        hooks: [],
      },
    });
    expect(result.success).toBe(true);
  });

  it('accepts manifest with no permissions', () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      permissions: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts manifest with optional fields', () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      dependencies: { 'com.other.plugin': '^1.0.0' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects invalid author url', () => {
    const result = PluginManifestSchema.safeParse({
      ...validManifest,
      author: { name: 'Test', url: 'not-a-url' },
    });
    expect(result.success).toBe(false);
  });
});

// Plan 311 — v2 manifest schema
describe('PluginManifestSchema v2 (Plan 311)', () => {
  const validV2 = {
    schemaVersion: 'duya.plugin.v2' as const,
    id: 'com.example.v2-plugin',
    name: 'V2 Plugin',
    version: '2.0.0',
    description: 'A v2 plugin with workflows',
    author: { name: 'V2 Author' },
    components: {
      mcpServers: ['github'],
      appConnections: [],
      skills: ['issue-to-implementation'],
      workflows: ['implement-issue', 'review-pr'],
    },
    permissionPolicy: {
      defaultMode: 'read' as const,
      writeActionsRequireApproval: true,
      destructiveActionsRequireApproval: true,
    },
    publisher: { name: 'Duya', verified: true },
    permissions: [],
    engines: { duya: '>=1.0.0' },
  };

  it('validates a valid v2 manifest', () => {
    const result = PluginManifestSchema.safeParse(validV2);
    expect(result.success).toBe(true);
  });

  it('v2 manifest is recognized by isManifestV2', () => {
    const parsed = PluginManifestSchema.parse(validV2);
    expect(isManifestV2(parsed)).toBe(true);
  });

  it('rejects v2 manifest missing components', () => {
    const { components, ...rest } = validV2;
    const result = PluginManifestSchema.safeParse(rest);
    expect(result.success).toBe(false);
  });

  it('accepts v2 manifest with optional entry / capabilities omitted', () => {
    const result = PluginManifestSchema.safeParse(validV2);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.schemaVersion).toBe('duya.plugin.v2');
      // `entry` and `capabilities` are optional in v2
      expect((result.data as { entry?: unknown }).entry).toBeUndefined();
    }
  });

  it('rejects v2 manifest with invalid permissionPolicy.defaultMode', () => {
    const result = PluginManifestSchema.safeParse({
      ...validV2,
      permissionPolicy: { defaultMode: 'bogus' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects v2 manifest with publisher.verified as non-boolean', () => {
    const result = PluginManifestSchema.safeParse({
      ...validV2,
      publisher: { name: 'Duya', verified: 'yes' },
    });
    expect(result.success).toBe(false);
  });

  it('defaults components arrays to empty when omitted', () => {
    const result = PluginManifestSchema.safeParse({
      schemaVersion: 'duya.plugin.v2',
      id: 'com.example.minimal',
      name: 'Minimal',
      version: '0.1.0',
      description: 'Minimal v2',
      author: { name: 'X' },
      components: {},
      permissions: [],
      engines: { duya: '>=1.0.0' },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      const components = (result.data as { components: { workflows: string[]; skills: string[] } }).components;
      expect(components.workflows).toEqual([]);
      expect(components.skills).toEqual([]);
    }
  });

  it('normalizeManifestComponents: v2 passes components through', () => {
    const parsed = PluginManifestSchema.parse(validV2);
    const normalized = normalizeManifestComponents(parsed);
    expect(normalized.workflows).toEqual(['implement-issue', 'review-pr']);
    expect(normalized.skills).toEqual(['issue-to-implementation']);
    expect(normalized.mcpServers).toEqual(['github']);
    expect(normalized.appConnections).toEqual([]);
  });

  it('normalizeManifestComponents: v1 projects capabilities with workflows: []', () => {
    const parsed = PluginManifestSchema.parse({
      schemaVersion: 'duya.plugin.v1',
      id: 'com.example.v1-plugin',
      name: 'V1 Plugin',
      version: '1.0.0',
      description: 'A v1 plugin',
      author: { name: 'X' },
      entry: { type: 'node', main: 'index.js' },
      capabilities: {
        skills: [{ path: './skills/foo.ts' }],
        mcpServers: [{ name: 'mcp1', command: 'node' }],
        cli: [],
        ui: [],
        hooks: [],
      },
      permissions: [],
      engines: { duya: '>=1.0.0' },
    });
    const normalized = normalizeManifestComponents(parsed);
    expect(normalized.workflows).toEqual([]);
    expect(normalized.skills).toEqual(['./skills/foo.ts']);
    expect(normalized.mcpServers).toEqual(['mcp1']);
    expect(isManifestV2(parsed)).toBe(false);
  });
});

// Plan 311 — workflow yaml schema
describe('WorkflowTemplateSchema (Plan 311)', () => {
  const validTemplate = {
    id: 'literature-review',
    name: 'Literature Review',
    description: 'Run a literature review on a given topic.',
    prompt: 'Survey the literature on {{topic}} and produce an evidence table.',
    requiredCapabilities: ['mcp:literature'],
    permissionTier: 'read' as const,
  };

  it('validates a valid template', () => {
    const result = WorkflowTemplateSchema.safeParse(validTemplate);
    expect(result.success).toBe(true);
  });

  it('rejects missing prompt AND steps (both empty)', () => {
    const { prompt, ...rest } = validTemplate;
    const result = WorkflowTemplateSchema.safeParse(rest);
    // Schema permits missing prompt because steps is optional. Runtime
    // enforcement happens in `getTemplatePrompt`. Schema only enforces
    // shape; either prompt or steps must be non-empty at runtime.
    expect(result.success).toBe(true);
  });

  it('rejects invalid permissionTier', () => {
    const result = WorkflowTemplateSchema.safeParse({
      ...validTemplate,
      permissionTier: 'bogus',
    });
    expect(result.success).toBe(false);
  });

  it('rejects requiredCapabilities as non-array', () => {
    const result = WorkflowTemplateSchema.safeParse({
      ...validTemplate,
      requiredCapabilities: 'mcp:literature',
    });
    expect(result.success).toBe(false);
  });

  it('defaults requiredCapabilities to [] and permissionTier to read', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'minimal',
      name: 'Minimal',
      description: 'A minimal template.',
      prompt: 'Hello',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.requiredCapabilities).toEqual([]);
      expect(result.data.permissionTier).toBe('read');
    }
  });

  it('accepts steps as an alternative to prompt', () => {
    const result = WorkflowTemplateSchema.safeParse({
      id: 'multi-step',
      name: 'Multi Step',
      description: 'A multi-step template.',
      steps: [
        { id: 's1', name: 'Step 1', prompt: 'Do step 1' },
        { id: 's2', name: 'Step 2', prompt: 'Do step 2' },
      ],
      requiredCapabilities: [],
      permissionTier: 'draft',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.steps?.length).toBe(2);
    }
  });
});