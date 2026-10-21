import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { CoreDataHost } from '../src/core-data-host.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function makeTempDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'duya-core-host-test-'));
  temporaryDirectories.push(directory);
  return directory;
}

function createHost(root: string): CoreDataHost {
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

describe('CoreDataHost', () => {
  it('owns migrations and reopens durable session stores', () => {
    const root = makeTempDirectory();
    const first = createHost(root);

    first.stores.sessions.create({ id: 'session-1', title: 'Persisted from Host' });
    first.close();
    first.close();

    const reopened = createHost(root);
    expect(reopened.stores.sessions.get('session-1')?.title).toBe('Persisted from Host');
    reopened.close();
  });
});
