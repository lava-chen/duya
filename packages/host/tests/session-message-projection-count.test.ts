/**
 * How many times a message read projects the transcript.
 *
 * The paged read projects the WHOLE transcript on every page, so a caller that
 * reads a transcript end to end through the pages pays for it once per page —
 * the quadratic behaviour behind a ten-thousand-message session taking minutes
 * to open. The whole-transcript read projects it once.
 *
 * This gate counts projections instead of measuring milliseconds: the number is
 * exact on any machine, so a regression that reintroduces per-page projection
 * fails here rather than showing up as a slow session.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost } from '@duya/data';
import type { CoreDataHostStores } from '@duya/data/core-data-host';
import { describe, expect, it } from 'vitest';
import { createHostSessionApi } from '../src/session-api.js';

function messageEntry(id: string, text: string) {
  return {
    type: 'message' as const,
    id,
    parentId: null,
    createdAt: 1_700_000_000_000,
    message: { role: 'user' as const, content: text },
  };
}

/**
 * A message log that counts how often the transcript is read out of storage.
 *
 * The count is the point of this test, so it wraps the real log instead of
 * replacing it: the rows come from the same storage the product reads.
 */
function countingMessageLog(stores: CoreDataHostStores) {
  const log = stores.messageLog;
  const state = { projections: 0 };
  const counted = new Proxy(log, {
    get(target, property, receiver) {
      if (property === 'listBySession') {
        return (...args: Parameters<typeof target.listBySession>) => {
          state.projections += 1;
          return target.listBySession(...args);
        };
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return { counted: counted as CoreDataHostStores['messageLog'], state };
}

describe('the projection count of a message read', () => {
  it('projects the transcript once for a whole read and once per page for a paged read', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-projection-count-'));
    const dataRoot = path.join(temporaryRoot, 'data');
    const dataHost = new CoreDataHost({
      filename: path.join(dataRoot, 'duya-core.db'),
      rolloutRoot: path.join(dataRoot, 'sessions'),
      attachmentsRoot: path.join(dataRoot, 'attachments'),
      messageLogPorts: {
        botSessionIdPrefix: 'bot:',
        parseBotSessionId: () => null,
        getBotSessionLogPath: (agentId, root) => path.join(root, 'agents', agentId, 'sessions.jsonl'),
        getBotSessionsDir: (agentId, root) => path.join(root, 'agents', agentId, 'sessions'),
      },
    });
    try {
      const { counted, state } = countingMessageLog(dataHost.stores);
      const api = createHostSessionApi({
        stores: { ...dataHost.stores, messageLog: counted },
        rolloutRoot: path.join(dataRoot, 'sessions'),
      });
      await api.create({ id: 's1' as never, title: 'projection count' });
      await api.appendTimeline('s1' as never, {
        entries: [
          messageEntry('m1', 'first'),
          messageEntry('m2', 'second'),
          messageEntry('m3', 'third'),
          messageEntry('m4', 'fourth'),
          messageEntry('m5', 'fifth'),
        ],
      });

      // A whole read projects the transcript exactly once, whatever its size.
      state.projections = 0;
      const all = await api.readAllMessages('s1' as never);
      expect(all.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      expect(all.nextCursor).toBeNull();
      expect(state.projections).toBe(1);

      // The paged read projects the whole transcript once per page — the
      // behaviour the whole read removes.
      state.projections = 0;
      let cursor: string | undefined;
      let pages = 0;
      const paged: string[] = [];
      do {
        const page = await api.readMessages('s1' as never, { limit: 2, cursor });
        pages += 1;
        paged.push(...page.messages.map((item) => item.id));
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);
      expect(paged).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
      expect(pages).toBe(3);
      expect(state.projections).toBe(pages);
    } finally {
      dataHost.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
