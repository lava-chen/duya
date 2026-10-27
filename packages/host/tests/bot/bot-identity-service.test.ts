/**
 * The Bot identity application service over the Host file backend (S1; S2
 * moved the pure core to `@duya/bot` — these cases stay because the crash
 * windows they pin are FILE states, exercised through the Host barrel).
 *
 * These are the named tests the plan's S1 slice hangs its acceptance on:
 * one service answering Desktop and TUI alike, revision conflicts REJECTED,
 * requestId dedup across crashes, and the identity journal rolling pending
 * intents forward at open. The crash cases are simulated the only honest way
 * — by writing the journal line and NOT writing the config, exactly the
 * on-disk state a killed process leaves behind. The in-memory-port case of
 * this suite moved to `packages/bot/tests/bot-service-in-memory.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parse } from '@iarna/toml';

import {
  BOT_IDENTITY_JOURNAL_FILENAME,
  BotIdentityJournal,
  BotServiceError,
  openHostBotService,
} from '../../src/bot/index.js';
import { getDuyaAgentsRoot } from '../../src/config-agents/bot-paths.js';

function tmpRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-bot-service-'));
  fs.writeFileSync(path.join(root, 'config.toml'), '[storage]\ndatabase_path = "x.db"\n', 'utf8');
  return root;
}

function readAgents(root: string): Record<string, Record<string, unknown>> {
  const raw = fs.readFileSync(path.join(root, 'config.toml'), 'utf8');
  return (parse(raw) as { agents?: Record<string, Record<string, unknown>> }).agents ?? {};
}

/**
 * Resolve a path that must stay inside `root`. Test ids are service-minted
 * kebab-case slugs, but the resolver does not trust that — a traversal out
 * of the temp root is a precondition failure, not a read.
 */
function insideRoot(root: string, ...segments: string[]): string {
  const target = path.resolve(root, ...segments);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`path escapes the test root: ${segments.join('/')}`);
  }
  return target;
}

function readProfile(root: string, id: string): Record<string, unknown> | null {
  const p = insideRoot(root, 'agents', id, 'profile.json');
  if (!fs.existsSync(p)) return null;
  return JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, unknown>;
}

describe('bot service — create and the canonical view', () => {
  it('creates a bot at revision 1, seeds the profile, and answers the receipt', async () => {
    const root = tmpRoot();
    const service = await openHostBotService(root);

    const receipt = await service.createBot({ name: 'Frontend Expert', description: 'Builds UIs' });
    expect(receipt).toEqual({ id: 'frontend-expert', name: 'Frontend Expert', revision: 1 });

    expect(readAgents(root)['frontend-expert']).toMatchObject({
      name: 'Frontend Expert',
      description: 'Builds UIs',
      revision: 1,
    });
    expect(readProfile(root, 'frontend-expert')).toMatchObject({
      name: 'Frontend Expert',
      description: 'Builds UIs',
    });
  });

  it('merges the runtime profile over the config entry in the canonical view', async () => {
    const root = tmpRoot();
    const service = await openHostBotService(root);
    const { id } = await service.createBot({ name: 'Config Name' });

    // The runtime identity self-edit lands in profile.json (the model's
    // update_state path); the canonical view must surface IT, not the
    // config.toml name that seeded it.
    const profilePath = insideRoot(root, 'agents', id, 'profile.json');
    fs.writeFileSync(
      profilePath,
      JSON.stringify({ schemaVersion: 1, name: 'Runtime Name', title: 'The Role', description: 'runtime desc' }),
      'utf8',
    );

    const record = await service.getBot(id);
    expect(record).toMatchObject({ id, name: 'Runtime Name', title: 'The Role', description: 'runtime desc' });
  });

  it('answers an empty name with bot_invalid_name, not a generic throw', async () => {
    const root = tmpRoot();
    const service = await openHostBotService(root);
    expect.assertions(2);
    try {
      await service.createBot({ name: '   ' });
    } catch (error) {
      expect(error).toBeInstanceOf(BotServiceError);
      expect((error as BotServiceError).code).toBe('bot_invalid_name');
    }
  });
});

describe('bot service — revision conflicts are rejected, not clobbered', () => {
  it('bumps the revision on update and rejects a stale expectedRevision with both numbers', async () => {
    const root = tmpRoot();
    const service = await openHostBotService(root);
    const first = await service.createBot({ name: 'A' });
    const second = await service.updateBot({ id: first.id, name: 'B', expectedRevision: 1 });
    expect(second.revision).toBe(2);

    expect.assertions(5);
    try {
      await service.updateBot({ id: first.id, name: 'C', expectedRevision: 1 });
    } catch (error) {
      expect(error).toBeInstanceOf(BotServiceError);
      const botError = error as BotServiceError;
      expect(botError.code).toBe('bot_revision_conflict');
      expect(botError.details).toMatchObject({ storedRevision: 2, expectedRevision: 1 });
      // The code rides the message for transports that serialize only that.
      expect(botError.message).toContain('[bot_revision_conflict]');
    }
  });

  it('updates without expectedRevision keep working (legacy last-writer-wins)', async () => {
    const root = tmpRoot();
    const service = await openHostBotService(root);
    const created = await service.createBot({ name: 'A' });
    const receipt = await service.updateBot({ id: created.id, description: 'patched' });
    expect(receipt.revision).toBe(2);
    expect(readAgents(root)[created.id]).toMatchObject({ name: 'A', description: 'patched', revision: 2 });
  });

  it('preserves provider / model / tools across an identity patch', async () => {
    const root = tmpRoot();
    const raw = [
      '[agents.helper]',
      'name = "Helper"',
      'model = "anthropic/claude-sonnet-4-20250514"',
      'provider = "anthropic"',
      'reasoning = "high"',
      'revision = 3',
      '',
    ].join('\n');
    fs.writeFileSync(path.join(root, 'config.toml'), raw, 'utf8');

    const service = await openHostBotService(root);
    const receipt = await service.updateBot({ id: 'helper', name: 'Renamed' });
    expect(receipt.revision).toBe(4);
    expect(readAgents(root)['helper']).toMatchObject({
      name: 'Renamed',
      model: 'anthropic/claude-sonnet-4-20250514',
      provider: 'anthropic',
      reasoning: 'high',
      revision: 4,
    });
  });
});

describe('bot service — requestId dedup survives crashes', () => {
  it('answers a retried create with the SAME bot, flagged deduplicated', async () => {
    const root = tmpRoot();
    const service = await openHostBotService(root);
    const first = await service.createBot({ name: 'Researcher', requestId: 'req-1' });
    const retry = await service.createBot({ name: 'Researcher', requestId: 'req-1' });
    expect(retry).toEqual({ ...first, deduplicated: true });
    expect(Object.keys(readAgents(root))).toHaveLength(1);
  });

  it('dedups ACROSS service instances (process restart), from the journal file', async () => {
    const root = tmpRoot();
    const first = await openHostBotService(root);
    await first.createBot({ name: 'Researcher', requestId: 'req-9' });

    const second = await openHostBotService(root);
    const retry = await second.createBot({ name: 'Researcher', requestId: 'req-9' });
    expect(retry.deduplicated).toBe(true);
    expect(retry.id).toBe('researcher');
    expect(Object.keys(readAgents(root))).toHaveLength(1);
  });
});

describe('bot service — the identity journal repairs a crash window', () => {
  it('rolls a pending CREATE forward on open: config write + profile seeding', async () => {
    const root = tmpRoot();
    // Simulate: the journal line landed, then the process died before the
    // config write. The on-disk state is journal-with-intent, config-without-bot.
    const journal = new BotIdentityJournal(getDuyaAgentsRoot(root));
    journal.appendCreate({
      requestId: null,
      id: 'crashed-bot',
      entry: { name: 'Crashed Bot', description: 'durable intent', revision: 1 },
      nextRevision: 1,
    });
    expect(readAgents(root)['crashed-bot']).toBeUndefined();

    const service = await openHostBotService(root);
    const record = await service.getBot('crashed-bot');
    expect(record).toMatchObject({ id: 'crashed-bot', name: 'Crashed Bot', revision: 1 });
    expect(readAgents(root)['crashed-bot']).toMatchObject({ name: 'Crashed Bot' });
    expect(readProfile(root, 'crashed-bot')).toMatchObject({ name: 'Crashed Bot' });

    // Repaired intents are marked applied: a second open is a no-op.
    const second = await openHostBotService(root);
    const report = await second.repair();
    expect(report.repaired).toBe(0);
  });

  it('rolls a pending UPDATE forward and keeps the revision chain intact', async () => {
    const root = tmpRoot();
    const seed = await openHostBotService(root);
    const created = await seed.createBot({ name: 'A' });
    const revision = created.revision;

    // Crash after the intent, before the config write.
    const journal = new BotIdentityJournal(getDuyaAgentsRoot(root));
    journal.appendUpdate({ id: created.id, patch: { name: 'B' }, nextRevision: revision + 1 });

    const service = await openHostBotService(root);
    const record = await service.getBot(created.id);
    expect(record).toMatchObject({ name: 'B', revision: revision + 1 });
  });

  it('leaves a conflicting pending create pending and reports it instead of clobbering', async () => {
    const root = tmpRoot();
    const journal = new BotIdentityJournal(getDuyaAgentsRoot(root));
    journal.appendCreate({
      requestId: null,
      id: 'taken-id',
      entry: { name: 'Wanted Name', revision: 1 },
      nextRevision: 1,
    });
    // The id got taken by a DIFFERENT entry while the writer was down.
    fs.writeFileSync(
      path.join(root, 'config.toml'),
      '[agents.taken-id]\nname = "Someone Else"\nrevision = 2\n',
      'utf8',
    );

    const service = await openHostBotService(root);
    const report = await service.repair();
    expect(report.conflicts).toEqual([
      { seq: expect.any(Number), id: 'taken-id', reason: 'create-target-exists-with-different-name' },
    ]);
    // Never clobber: the surviving entry is untouched and still wins.
    expect(readAgents(root)['taken-id']).toMatchObject({ name: 'Someone Else', revision: 2 });
  });

  it('counts a torn tail line instead of failing the load', async () => {
    const root = tmpRoot();
    const journalPath = insideRoot(root, 'agents', BOT_IDENTITY_JOURNAL_FILENAME);
    fs.mkdirSync(path.dirname(journalPath), { recursive: true });
    const good = JSON.stringify({
      v: 1, seq: 1, kind: 'create', requestId: null, id: 'ok-bot',
      entry: { name: 'Ok', revision: 1 }, nextRevision: 1, recordedAt: 1,
    });
    fs.writeFileSync(journalPath, `${good}\n{"v":1,"seq":2,"kind":"cre`, 'utf8');

    const service = await openHostBotService(root);
    const report = await service.repair();
    expect(report.corruptJournalLines).toBe(1);
    expect((await service.getBot('ok-bot'))?.name).toBe('Ok');
  });
});

describe('bot service — list and soft-delete', () => {
  it('lists live bots sorted, excluding soft-deleted entries', async () => {
    const root = tmpRoot();
    fs.writeFileSync(
      path.join(root, 'config.toml'),
      [
        '[agents.b-bot]',
        'name = "B"',
        '',
        '[agents.a-bot]',
        'name = "A"',
        '',
        '[agents.gone-bot]',
        'name = "Gone"',
        'deleted_at = 123',
        '',
      ].join('\n'),
      'utf8',
    );
    const service = await openHostBotService(root);
    const list = await service.listBots();
    expect(list.map((r) => r.id)).toEqual(['a-bot', 'b-bot']);
  });
});
