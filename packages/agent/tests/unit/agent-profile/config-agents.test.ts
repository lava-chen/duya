/**
 * Tests for config-driven custom agent profiles (Plan 424).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as os from 'os';
import * as fs from 'fs';
import * as path from 'path';
import { readConfigAgents, toAgentProfile } from '../../../src/agent-profile/config-agents.js';

// `import * as os` is a non-configurable namespace in ESM, so we mock the
// whole module and redirect `homedir` to a per-test temp dir via a hoisted
// holder (config-agents.ts reads `os.homedir()` for the config root).
const homedirHolder = vi.hoisted(() => ({ value: '' }));
vi.mock('os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('os')>();
  return { ...actual, homedir: () => homedirHolder.value };
});

describe('config-agents (Plan 424)', () => {
  let tempDir: string;
  let configRoot: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cfg-agents-'));
    configRoot = path.join(tempDir, '.duya');
    fs.mkdirSync(configRoot, { recursive: true });
    homedirHolder.value = tempDir;
  });

  afterEach(() => {
    homedirHolder.value = '';
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeConfig(toml: string): void {
    fs.writeFileSync(path.join(configRoot, 'config.toml'), toml, 'utf8');
  }

  it('returns {} when no config.toml exists', async () => {
    const agents = await readConfigAgents();
    expect(agents).toEqual({});
  });

  it('reads [agents."foo"] into a map with name/model/workspace/tools/plugins', async () => {
    writeConfig(`
[agents."foo"]
name = "Foo"
description = "A test agent"
model = "anthropic/claude-sonnet-4-20250514"
workspace = "~/work/foo"
agents_md = "~/.duya/foo/AGENTS.md"
tools = { profile = "coding", allow = ["file:*"], deny = ["browser"] }
plugins = ["mcp:github"]
`);
    const agents = await readConfigAgents();
    expect(agents['foo']).toBeDefined();
    expect(agents['foo']!.name).toBe('Foo');
    expect(agents['foo']!.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(agents['foo']!.workspace).toBe('~/work/foo');
    expect(agents['foo']!.tools?.profile).toBe('coding');
    expect(agents['foo']!.tools?.allow).toEqual(['file:*']);
    expect(agents['foo']!.plugins).toEqual(['mcp:github']);
  });

  it('toAgentProfile maps a config entry to an AgentProfile descriptor', async () => {
    const profile = await toAgentProfile('foo', {
      name: 'Foo',
      description: 'desc',
      model: 'anthropic/claude-sonnet-4-20250514',
      tools: { profile: 'coding', allow: ['file:*'], deny: ['browser'] },
    });
    expect(profile.kind).toBe('main');
    expect(profile.userVisible).toBe(true);
    expect(profile.isPreset).toBe(false);
    expect(profile.isEnabled).toBe(true);
    // Explicit allow overrides the profile's allow list.
    expect(profile.allowedTools).toEqual(['file:*']);
    // Deny merges the coding-profile deny list with the explicit deny.
    expect(profile.disallowedTools).toContain('browser:*');
    expect(profile.disallowedTools).toContain('gateway:*');
    expect(profile.disallowedTools).toContain('browser');
    expect(profile.defaultModel).toBe('anthropic/claude-sonnet-4-20250514');
  });

  it('reads agents_md file content into globalInstructions', async () => {
    const mdPath = path.join(configRoot, 'AGENTS.md');
    fs.writeFileSync(mdPath, '# Foo Rules\nAlways be concise.', 'utf8');
    const profile = await toAgentProfile('foo', {
      name: 'Foo',
      agents_md: mdPath,
    });
    expect(profile.globalInstructions).toContain('Always be concise.');
  });

  it('leaves globalInstructions undefined when the agents_md file is missing', async () => {
    const profile = await toAgentProfile('foo', {
      name: 'Foo',
      agents_md: path.join(configRoot, 'missing.md'),
    });
    expect(profile.globalInstructions).toBeUndefined();
  });
});