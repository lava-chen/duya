/**
 * The config-agent domain of the standalone Host's worker db bridge.
 *
 * ## Why this file exists
 *
 * `config:agents:create` and `config:agents:update` are the two actions the
 * agent-side `create_agent` / `update_agent` tools route through. In the
 * standalone Host both used to fall through to `unimplemented_domain`, so the
 * model could not create or edit a teammate at all — while the Desktop
 * answered the same actions from its config store.
 *
 * The bridge now serves them from the shared config write side, and the
 * payload contract is the Desktop's: `create` answers `{ id, name }` with the
 * ACTUAL id, `update` answers the same shape for the patched agent.
 */
import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bridge-config-agents-'));
}

function bridge(configRoot: string) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    configRoot,
  });
}

function readAgents(root: string): Record<string, Record<string, unknown>> {
  const raw = fs.readFileSync(path.join(root, 'config.toml'), 'utf8');
  const parsed = parse(raw) as { agents?: Record<string, Record<string, unknown>> };
  return parsed.agents ?? {};
}

describe('worker db bridge — config agents', () => {
  it('creates an agent and answers with the actual id and name', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), '[storage]\ndatabase_path = "x.db"\n', 'utf8');

    const result = await bridge(root).dispatch('config:agents:create', {
      name: 'Frontend Expert',
      description: 'Builds UIs',
    });

    expect(result).toEqual({ id: 'frontend-expert', name: 'Frontend Expert' });
    expect(readAgents(root)['frontend-expert']).toMatchObject({
      name: 'Frontend Expert',
      description: 'Builds UIs',
    });
  });

  it('patches an agent and keeps the fields the tool did not ask about', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, 'config.toml'),
      [
        '[agents.helper]',
        'name = "Helper"',
        'description = "Old description"',
        'model = "anthropic/claude-sonnet-4-20250514"',
        'provider = "anthropic"',
        'reasoning = "high"',
        '',
      ].join('\n'),
      'utf8',
    );

    const result = await bridge(root).dispatch('config:agents:update', {
      agentId: 'helper',
      name: 'Renamed',
    });

    expect(result).toEqual({ id: 'helper', name: 'Renamed' });
    const entry = readAgents(root).helper!;
    expect(entry.description).toBe('Old description');
    expect(entry.model).toBe('anthropic/claude-sonnet-4-20250514');
    expect(entry.provider).toBe('anthropic');
    expect(entry.reasoning).toBe('high');
  });

  it('refuses a create without a name', async () => {
    const root = tmpRoot();

    await expect(bridge(root).dispatch('config:agents:create', {})).rejects.toThrow(
      WorkerDbBridgeError,
    );
  });

  it('reports an unknown agent on update', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), '[storage]\n', 'utf8');

    await expect(
      bridge(root).dispatch('config:agents:update', { agentId: 'nobody', name: 'X' }),
    ).rejects.toThrow(/not found/);
  });
});

/**
 * S1 — the typed `bot:*` actions over the same bridge. The legacy actions
 * above now delegate to the Bot application service; these cases pin the
 * NEW contract: full receipts, revision conflicts as structured errors, and
 * a read side (`bot:get` / `bot:list`) every client can converge on.
 */
describe('worker db bridge — bot application actions', () => {
  it('bot:create answers the full receipt and bot:get reads it back', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), '[storage]\n', 'utf8');
    const b = bridge(root);

    const created = (await b.dispatch('bot:create', {
      name: 'Frontend Expert',
      requestId: 'r-1',
    })) as { id: string; name: string; revision: number };

    expect(created).toMatchObject({ id: 'frontend-expert', name: 'Frontend Expert', revision: 1 });

    const record = (await b.dispatch('bot:get', { botId: 'frontend-expert' })) as Record<string, unknown>;
    expect(record).toMatchObject({ id: 'frontend-expert', name: 'Frontend Expert', revision: 1 });
  });

  it('bot:update surfaces a stale revision as a structured conflict', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), '[storage]\n', 'utf8');
    const b = bridge(root);
    const created = (await b.dispatch('bot:create', { name: 'Alpha Bot' })) as {
      id: string;
      revision: number;
    };

    await expect(
      b.dispatch('bot:update', { botId: created.id, name: 'B', expectedRevision: created.revision + 6 }),
    ).rejects.toThrow(/\[bot_revision_conflict\]/s);
  });

  it('bot:list returns live bots and skips soft-deleted ones', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, 'config.toml'),
      ['[agents.live]', 'name = "Live"', '', '[agents.gone]', 'name = "Gone"', 'deleted_at = 5', ''].join('\n'),
      'utf8',
    );
    const list = (await bridge(root).dispatch('bot:list', {})) as Array<{ id: string }>;
    expect(list.map((r) => r.id)).toEqual(['live']);
  });

  it('legacy config:agents actions and bot actions see the same bots', async () => {
    const root = tmpRoot();
    fs.writeFileSync(path.join(root, 'config.toml'), '[storage]\n', 'utf8');
    const b = bridge(root);

    const legacy = (await b.dispatch('config:agents:create', { name: 'Shared Bot' })) as { id: string };
    expect(legacy).toEqual({ id: 'shared-bot', name: 'Shared Bot' });

    // One writer: the typed surface reads what the legacy surface wrote.
    const record = (await b.dispatch('bot:get', { botId: legacy.id })) as Record<string, unknown>;
    expect(record).toMatchObject({ id: 'shared-bot', name: 'Shared Bot' });
  });
});
