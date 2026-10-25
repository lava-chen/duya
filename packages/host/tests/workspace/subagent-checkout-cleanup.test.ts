import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { CoreDatabase } from '@duya/data/core-database';
import { SessionStore } from '@duya/data/session-store';
import { sessionDb } from '../../src/worker-db-client.js';
import { createCheckoutProvider } from '../../src/workspace/checkout-provider.js';
import { SessionCheckoutService } from '../../src/workspace/session-checkout-service.js';
import { finalizeCheckoutRun } from '../../src/worker-subagents/worktree.js';
import { readOwner } from '../../src/workspace/checkout-metadata.js';
import { makeRepo, tempDir, useIsolatedDataRoot } from './fixtures.js';

const restore = useIsolatedDataRoot();
afterAll(restore);
afterEach(() => vi.restoreAllMocks());

describe('subagent terminal checkout cleanup', () => {
  it.each(['unchanged', 'changed', 'ignored'] as const)('handles %s contents through authoritative Host reclamation', async (kind) => {
    const repo = makeRepo({ gitignore: 'cache/\n' });
    const checkout = await createCheckoutProvider().create({ sourceCwd: repo, ownerSessionId: 'child', label: kind });
    const db = new CoreDatabase({ filename: path.join(tempDir('duya-cleanup-db-'), 'core.db'), migrations: SessionStore.migrations });
    const sessions = new SessionStore(db.db);
    sessions.create({ id: 'child', workingDirectory: checkout.cwd });
    const service = new SessionCheckoutService({ sessions, runs: { listRunsBySession: () => [] }, backgroundBusy: () => false });
    vi.spyOn(sessionDb, 'reclaimCheckout').mockImplementation((root) => service.reclaim(root));
    vi.spyOn(sessionDb, 'setExtension').mockImplementation(async (id, key, value) => sessions.setExtension(id, key, value));
    try {
      if (kind === 'changed') writeFileSync(path.join(checkout.root, 'result.txt'), 'preserve');
      if (kind === 'ignored') {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(path.join(checkout.root, 'cache')); writeFileSync(path.join(checkout.root, 'cache', 'result'), 'preserve');
      }
      const result = await finalizeCheckoutRun({ sessionId: 'child', outcome: 'completed',
        record: { root: checkout.root, cwd: checkout.cwd, baseSha: checkout.baseSha, enteredAt: Date.now() } });
      expect(result.removed).toBe(kind === 'unchanged');
      expect(existsSync(checkout.root)).toBe(kind !== 'unchanged');
      expect((sessions.get('child')!.extensions.checkout as { cleanup: unknown }).cleanup).toEqual(result);
      if (kind !== 'unchanged') expect(await readOwner(checkout.root)).toBeNull();
      expect(existsSync(path.join(repo, 'README.md'))).toBe(true);
    } finally { db.close(); }
  });
});
