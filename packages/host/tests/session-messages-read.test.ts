/**
 * The Host's message reads: a paged read and a whole-transcript read.
 *
 * The paged read projects the ENTIRE transcript on every page, so a caller
 * that reads a transcript end to end through the pages pays for the transcript
 * once per page. `readAllMessages` projects it once.
 */
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HostSessionHttpClient } from '../src/http-client.js';
import { startLocalHost } from '../src/local-host.js';

const TOKEN = 'session-messages-read-token';

function messageEntry(id: string, text: string) {
  return {
    type: 'message' as const,
    id,
    parentId: null,
    createdAt: 1_700_000_000_000,
    message: { role: 'user' as const, content: text },
  };
}

describe('the Host session message reads', () => {
  it('reads the whole transcript in one call while the paged read still pages', async () => {
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-message-read-'));
    const dataRoot = path.join(temporaryRoot, 'data');
    let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
    try {
      host = await startLocalHost({
        dataRoot,
        databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
        rolloutRoot: path.join(dataRoot, 'sessions'),
        attachmentsRoot: path.join(dataRoot, 'attachments'),
        runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
        port: 0,
        token: TOKEN,
      });
      const client = new HostSessionHttpClient(host.origin, TOKEN);
      await client.create({ id: 's1' as never, title: 'messages' });
      await client.appendTimeline('s1' as never, {
        entries: [
          messageEntry('m1', 'first'),
          messageEntry('m2', 'second'),
          messageEntry('m3', 'third'),
        ],
      });

      // The paged read still hands out one page and a cursor.
      const first = await client.readMessages('s1' as never, { limit: 2 });
      expect(first.messages.map((item) => item.id)).toEqual(['m1', 'm2']);
      expect(first.nextCursor).not.toBeNull();

      // The whole read hands out every row, once, with no cursor.
      const all = await client.readAllMessages('s1' as never);
      expect(all.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
      expect(all.nextCursor).toBeNull();

      // The whole read carries the same projection options as the paged one.
      const superseded = await client.readAllMessages('s1' as never, { includeSuperseded: false });
      expect(superseded.messages.map((item) => item.id)).toEqual(['m1', 'm2', 'm3']);
    } finally {
      await host?.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('rejects a whole read that carries paging options', async () => {
    // `all=1` and a page size are contradictory; the server says so instead
    // of quietly ignoring one of them.
    const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-host-message-read-bad-'));
    const dataRoot = path.join(temporaryRoot, 'data');
    let host: Awaited<ReturnType<typeof startLocalHost>> | undefined;
    try {
      host = await startLocalHost({
        dataRoot,
        databasePath: path.join(dataRoot, 'databases', 'duya-main.db'),
        rolloutRoot: path.join(dataRoot, 'sessions'),
        attachmentsRoot: path.join(dataRoot, 'attachments'),
        runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
        port: 0,
        token: TOKEN,
      });
      const client = new HostSessionHttpClient(host.origin, TOKEN);
      await client.create({ id: 's1' as never, title: 'messages' });
      for (const query of ['all=maybe', 'all=1&limit=2', 'all=1&cursor=abc']) {
        const response = await fetch(`${host.origin}/v1/sessions/s1/messages?${query}`, {
          headers: { authorization: `Bearer ${TOKEN}` },
        });
        expect(response.status, query).toBe(400);
        const body = await response.json() as { error?: { code?: string } };
        expect(body.error?.code, query).toBe('invalid_message_query');
      }
    } finally {
      await host?.close();
      await fs.rm(temporaryRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
