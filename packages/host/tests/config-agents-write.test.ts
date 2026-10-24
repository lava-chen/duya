/**
 * The config-agent write side of the standalone Host.
 *
 * ## Why this file exists
 *
 * The agent-side `create_agent` / `update_agent` tools route through the
 * worker db bridge to `config:agents:create` / `config:agents:update`. In the
 * standalone Host both actions used to fall through to `unimplemented_domain`,
 * so a model could not spin up a teammate at all. The write side lives in
 * `packages/host/src/config-agents` and edits `~/.duya/config.toml` directly,
 * because the standalone Host has no config store.
 *
 * These assertions pin the invariants that make that write safe:
 *   - only the `[agents]` namespace changes — every other table, and every
 *     comment, survives byte for byte;
 *   - an update preserves the fields the tool did not ask about
 *     (model / provider / reasoning / prompt / tools / plugins);
 *   - a soft-deleted agent is never resurrected;
 *   - a config file that does not parse is never overwritten.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';
import {
  createConfigAgent,
  updateConfigAgentIdentity,
} from '../src/config-agents/config-agents-api.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-config-agents-'));
}

function configPath(root: string): string {
  return path.join(root, 'config.toml');
}

function readConfig(root: string): string {
  return fs.readFileSync(configPath(root), 'utf8');
}

function readAgents(root: string): Record<string, Record<string, unknown>> {
  const parsed = parse(readConfig(root)) as { agents?: Record<string, Record<string, unknown>> };
  return parsed.agents ?? {};
}

const EXISTING_CONFIG = `# my providers
[providers.openai]
base_url = "https://api.openai.com/v1"

# a bot that is already there
[agents.helper]
name = "Helper"
description = "Does chores"

[storage]
database_path = "duya-main.db"
`;

describe('config-agents write side', () => {
  it('creates an agent and answers with the actual id', async () => {
    const root = tmpRoot();
    fs.writeFileSync(configPath(root), EXISTING_CONFIG, 'utf8');

    const created = await createConfigAgent('Frontend Expert', 'Builds UIs', { root });

    expect(created.id).toBe('frontend-expert');
    expect(created.name).toBe('Frontend Expert');
    expect(readAgents(root)['frontend-expert']).toMatchObject({
      name: 'Frontend Expert',
      description: 'Builds UIs',
    });
  });

  it('leaves every other table and every comment untouched', async () => {
    const root = tmpRoot();
    fs.writeFileSync(configPath(root), EXISTING_CONFIG, 'utf8');

    await createConfigAgent('Frontend Expert', 'Builds UIs', { root });

    const after = readConfig(root);
    expect(after).toContain('# my providers');
    expect(after).toContain('# a bot that is already there');
    expect(after).toContain('base_url = "https://api.openai.com/v1"');
    expect(after).toContain('database_path = "duya-main.db"');
    // The pre-existing agent survives untouched.
    expect(readAgents(root).helper).toMatchObject({ name: 'Helper', description: 'Does chores' });
  });

  it('seeds the runtime profile on first creation', async () => {
    const root = tmpRoot();
    fs.writeFileSync(configPath(root), EXISTING_CONFIG, 'utf8');

    const created = await createConfigAgent('Helper Two', 'Second helper', { root });

    const profilePath = path.join(root, 'agents', created.id, 'profile.json');
    expect(fs.existsSync(profilePath)).toBe(true);
    const profile = JSON.parse(fs.readFileSync(profilePath, 'utf8')) as { name: string };
    expect(profile.name).toBe('Helper Two');
  });

  it('never overwrites an existing runtime profile', async () => {
    const root = tmpRoot();
    fs.writeFileSync(configPath(root), EXISTING_CONFIG, 'utf8');
    const profileDir = path.join(root, 'agents', 'helper');
    fs.mkdirSync(profileDir, { recursive: true });
    fs.writeFileSync(
      path.join(profileDir, 'profile.json'),
      JSON.stringify({ schemaVersion: 1, name: 'Runtime Name', title: '', description: '' }),
      'utf8',
    );

    await createConfigAgent('Helper', 'Different description', { root });

    const profile = JSON.parse(
      fs.readFileSync(path.join(profileDir, 'profile.json'), 'utf8'),
    ) as { name: string };
    expect(profile.name).toBe('Runtime Name');
  });

  it('suffixes the id when the slug is taken', async () => {
    const root = tmpRoot();
    fs.writeFileSync(configPath(root), EXISTING_CONFIG, 'utf8');

    const created = await createConfigAgent('Helper', 'Another helper', { root });

    expect(created.id).not.toBe('helper');
    expect(created.id.startsWith('helper-')).toBe(true);
    expect(readAgents(root).helper).toMatchObject({ name: 'Helper' });
    expect(readAgents(root)[created.id]).toMatchObject({ name: 'Helper' });
  });

  it('never reuses the id of a soft-deleted agent', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      configPath(root),
      '[agents.gone]\nname = "Gone"\ndeleted_at = 1700000000000\n',
      'utf8',
    );

    const created = await createConfigAgent('Gone', 'Back again', { root });

    expect(created.id).not.toBe('gone');
    expect(readAgents(root).gone).toMatchObject({ deleted_at: 1700000000000 });
  });

  it('preserves the fields an update did not ask about', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      configPath(root),
      [
        '[agents.helper]',
        'name = "Helper"',
        'description = "Old description"',
        'model = "anthropic/claude-sonnet-4-20250514"',
        'provider = "anthropic"',
        'reasoning = "high"',
        'plugins = ["mcp:github"]',
        '',
        '[agents.helper.prompt.sections]',
        'enable = ["botIdentity"]',
        '',
      ].join('\n'),
      'utf8',
    );

    const updated = await updateConfigAgentIdentity('helper', { name: 'Renamed' }, { root });

    expect(updated).toEqual({ id: 'helper', name: 'Renamed' });
    const entry = readAgents(root).helper!;
    expect(entry.name).toBe('Renamed');
    expect(entry.description).toBe('Old description');
    expect(entry.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(entry.provider).toBe('anthropic');
    expect(entry.reasoning).toBe('high');
    expect(entry.plugins).toEqual(['mcp:github']);
    expect(entry.prompt).toMatchObject({ sections: { enable: ['botIdentity'] } });
  });

  it('refuses to update an unknown agent', async () => {
    const root = tmpRoot();
    fs.writeFileSync(configPath(root), EXISTING_CONFIG, 'utf8');

    await expect(
      updateConfigAgentIdentity('nobody', { name: 'X' }, { root }),
    ).rejects.toThrow(/not found/);
  });

  it('refuses to resurrect a soft-deleted agent', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      configPath(root),
      '[agents.gone]\nname = "Gone"\ndeleted_at = 1700000000000\n',
      'utf8',
    );

    await expect(
      updateConfigAgentIdentity('gone', { name: 'Back' }, { root }),
    ).rejects.toThrow(/soft-deleted/);
    expect(readAgents(root).gone).toMatchObject({ name: 'Gone' });
  });

  it('never overwrites a config file that does not parse', async () => {
    const root = tmpRoot();
    const broken = 'this is not = = toml\n';
    fs.writeFileSync(configPath(root), broken, 'utf8');

    await expect(createConfigAgent('Helper', 'nope', { root })).rejects.toThrow(/could not be parsed/);
    expect(readConfig(root)).toBe(broken);
  });

  it('leaves no tmp files behind', async () => {
    const root = tmpRoot();
    fs.writeFileSync(configPath(root), EXISTING_CONFIG, 'utf8');

    await createConfigAgent('Helper', 'nope', { root });

    expect(fs.readdirSync(root).filter((name) => name.endsWith('.tmp'))).toEqual([]);
  });
});
