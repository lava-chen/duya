/**
 * The mailbox domain of the standalone Host's worker db bridge.
 *
 * ## Why this file exists
 *
 * The worker claims mailbox rows at every model checkpoint and applies them
 * afterwards. On the standalone Host those actions used to fail with
 * `unimplemented_domain`, so every claim failed, every notification was
 * lost, and the failure was invisible: the worker logs a warning and keeps
 * going with an empty mailbox.
 *
 * These assertions pin the behaviour the worker depends on:
 *  - the row shape is the LEGACY snake_case row (`session_id`,
 *    `submitted_during_run_id`, ...), not the core store's camelCase item;
 *  - a claim returns the rows AND the per-row claim token, in the same
 *    order, because the worker pairs them by index;
 *  - applying a claimed row is what moves it out of `pending`;
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { CoreDataHost } from '@duya/data/core-data-host';
import type { MainDatabase } from '@duya/data/main-database';
import type { MainSettingsStore } from '@duya/data/main-settings-store';
import type { SessionStore } from '@duya/data/session-store';
import type { RunRepository } from '../src/repository-port.js';
import { createHostWorkerDbBridge, WorkerDbBridgeError } from '../src/worker-db-bridge.js';
import { createHostLocalMailboxApi } from '../src/local-mailbox-api.js';

function createCore(root: string): CoreDataHost {
  return new CoreDataHost({
    filename: path.join(root, 'duya-core.db'),
    rolloutRoot: path.join(root, 'sessions'),
    attachmentsRoot: path.join(root, 'attachments'),
    messageLogPorts: {
      botSessionIdPrefix: 'bot:',
      parseBotSessionId: () => null,
      getBotSessionLogPath: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions.jsonl'),
      getBotSessionsDir: (agentId, dataRoot) => path.join(dataRoot, 'agents', agentId, 'sessions'),
    },
  });
}

function bridge(options: {
  readonly mailboxApi?: ReturnType<typeof createHostLocalMailboxApi>;
}) {
  return createHostWorkerDbBridge({
    runs: {} as RunRepository,
    sessions: {} as SessionStore,
    settings: {} as MainSettingsStore,
    mainDatabase: { db: {} } as MainDatabase,
    ...options,
  });
}

describe('the standalone Host mailbox domain', () => {
  it('enqueues a row and serves it in the legacy snake_case shape', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-mailbox-'));
    const core = createCore(root);
    try {
      const host = bridge({ mailboxApi: createHostLocalMailboxApi(core.stores.mailbox) });

      const row = await host.dispatch('mailbox:send', {
        id: 'mail-1',
        sessionId: 'session-1',
        submittedDuringRunId: 'run-1',
        content: 'the agent finished a background task',
        kind: 'background_notification',
        source: 'session-tool',
      });

      // The worker reads `session_id` and `submitted_during_run_id`, not the
      // core store's camelCase names: the row crosses a process boundary.
      expect(row).toMatchObject({
        id: 'mail-1',
        session_id: 'session-1',
        submitted_during_run_id: 'run-1',
        content: 'the agent finished a background task',
        kind: 'background_notification',
        status: 'pending',
        claim_token: null,
      });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('claims the rows and hands back the claim token beside each row', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-mailbox-'));
    const core = createCore(root);
    try {
      const host = bridge({ mailboxApi: createHostLocalMailboxApi(core.stores.mailbox) });
      await host.dispatch('mailbox:send', {
        id: 'mail-1',
        sessionId: 'session-1',
        submittedDuringRunId: 'run-1',
        content: 'wake up',
        // `followup` is what a model checkpoint may absorb; `queued` rows are
        // promoted to a real user turn instead (plan 570).
        kind: 'followup',
        source: 'session-tool',
      });

      const claim = await host.dispatch('mailbox:claimBatch', {
        sessionId: 'session-1',
        runId: 'run-2',
        checkpoint: 'before_model_turn',
        limit: 10,
      }) as { rows: Array<Record<string, unknown>>; claimTokens: string[] };

      // The worker pairs a row with its claim token BY INDEX, so the two
      // arrays have to stay in the same order and the same length.
      expect(claim.rows).toHaveLength(1);
      expect(claim.claimTokens).toHaveLength(1);
      // A claimed row is `observed`, not `pending`: the claim owns it until
      // the worker applies it, and only then does it become `applied`.
      expect(claim.rows[0]).toMatchObject({ id: 'mail-1', status: 'observed' });
      expect(claim.claimTokens[0]).toBeTruthy();
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('applies a claimed row', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-mailbox-'));
    const core = createCore(root);
    try {
      const host = bridge({ mailboxApi: createHostLocalMailboxApi(core.stores.mailbox) });
      await host.dispatch('mailbox:send', {
        id: 'mail-1',
        sessionId: 'session-1',
        submittedDuringRunId: 'run-1',
        content: 'wake up',
        // `queued` rows are never claimable; only `followup` and
        // `background_notification` are absorbed by a model checkpoint.
        kind: 'followup',
        source: 'session-tool',
      });
      const claim = await host.dispatch('mailbox:claimBatch', {
        sessionId: 'session-1',
        runId: 'run-2',
        checkpoint: 'before_model_turn',
      }) as { rows: Array<Record<string, unknown>>; claimTokens: string[] };

      const applied = await host.dispatch('mailbox:apply', {
        id: 'mail-1',
        claimToken: claim.claimTokens[0],
        mode: 'promote_to_user_message',
        checkpoint: 'before_model_turn',
        summary: 'applied as a user message',
      });

      expect(applied).toMatchObject({
        id: 'mail-1',
        status: 'applied',
        applied_summary: 'applied as a user message',
      });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('lists the rows of a session', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-mailbox-'));
    const core = createCore(root);
    try {
      const host = bridge({ mailboxApi: createHostLocalMailboxApi(core.stores.mailbox) });
      await host.dispatch('mailbox:send', {
        id: 'mail-1',
        sessionId: 'session-1',
        submittedDuringRunId: 'run-1',
        content: 'wake up',
        kind: 'queued',
        source: 'session-tool',
      });

      const rows = await host.dispatch('mailbox:list', { sessionId: 'session-1' }) as Array<Record<string, unknown>>;

      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: 'mail-1', session_id: 'session-1' });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails fast when the Host has not composed the mailbox API', async () => {
    await expect(bridge({}).dispatch('mailbox:claimBatch', {
      sessionId: 'session-1',
      runId: 'run-1',
      checkpoint: 'before_model_turn',
    })).rejects.toMatchObject<Partial<WorkerDbBridgeError>>({
      code: 'unimplemented_domain',
    });
  });

  it('rejects a mailbox payload that does not satisfy the action', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-host-mailbox-'));
    const core = createCore(root);
    try {
      const host = bridge({ mailboxApi: createHostLocalMailboxApi(core.stores.mailbox) });

      await expect(host.dispatch('mailbox:claimBatch', {
        sessionId: 'session-1',
        runId: '',
        checkpoint: 'before_model_turn',
      })).rejects.toMatchObject<Partial<WorkerDbBridgeError>>({
        code: 'invalid_payload',
      });
    } finally {
      core.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
