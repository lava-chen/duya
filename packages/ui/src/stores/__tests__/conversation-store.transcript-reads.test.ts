// @vitest-environment jsdom
/**
 * A session switch must read the transcript ONCE.
 *
 * The regression this pins: switching to a session read its WHOLE history
 * three times over -- once by the broad metadata refresh, once by the forced
 * message load, and once more when the chat view mounted to read three
 * fields off the session row. Every read is a full transcript: the DB row,
 * the JSON parse in the main process, the IPC serialization and the parse in
 * the renderer. On a long session that is megabytes, three times, on the one
 * interaction the user is waiting for.
 *
 * The contract is a COUNT, not a duration: "one transcript read per
 * navigation" is a property of the code that does not move with the machine.
 *
 *   - the store reads the transcript exactly once per `setActiveThread`,
 *   - the chat view reads the session ROW, not the transcript, when it mounts.
 */
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const mocks = vi.hoisted(() => ({
  getThreadIPC: vi.fn(async () => null as unknown),
  listThreadsIPC: vi.fn(async () => [] as unknown[]),
}));

vi.mock('@/lib/ipc-client', () => ({
  listThreadsIPC: mocks.listThreadsIPC,
  getThreadIPC: mocks.getThreadIPC,
  createThreadIPC: vi.fn(async () => ({ id: 'created' })),
  deleteThreadIPC: vi.fn(async () => true),
  archiveThreadIPC: vi.fn(),
  unarchiveThreadIPC: vi.fn(),
  listArchivedThreadsIPC: vi.fn(async () => []),
  getProjectGroupsIPC: vi.fn(async () => []),
  getNoProjectWorkspaceIPC: vi.fn(async () => '/tmp/duya-workspace'),
  addRecentFolderIPC: vi.fn(),
  addMessageIPC: vi.fn(),
  getActiveProviderIPC: vi.fn(async () => null),
  getAllSettingsIPC: vi.fn(async () => ({})),
  listProvidersIPC: vi.fn(async () => []),
  updateThreadIPC: vi.fn(),
  truncateMessagesAfterIPC: vi.fn(),
  truncateMessagesFromInclusiveIPC: vi.fn(),
}));

vi.mock('@/lib/agent-http-client', () => ({
  getAgentServerClient: vi.fn(() => ({
    getSessionStatus: vi.fn(async () => ({ status: 'IDLE' })),
  })),
}));

import { useConversationStore } from '../conversation-store';

const SESSION = 'session-b';

function threadRow(id: string) {
  return {
    id,
    title: id,
    workingDirectory: '/tmp/duya-workspace',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  };
}

describe('conversation store — a session switch reads the transcript once', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getThreadIPC.mockImplementation(async (id: string) => ({
      thread: threadRow(id),
      messages: [{ id: 'm1', role: 'assistant', content: 'hi', timestamp: 1 }],
    }));
    mocks.listThreadsIPC.mockImplementation(async () => [threadRow(SESSION)]);
    useConversationStore.setState({
      threads: [threadRow(SESSION)],
      archivedThreads: [],
      activeThreadId: null,
      messages: {},
      lastSyncAt: 0,
      isHydrated: true,
    });
  });

  it('reads the transcript exactly once when the session is switched to', async () => {
    await useConversationStore.getState().setActiveThread(SESSION);

    expect(mocks.getThreadIPC).toHaveBeenCalledTimes(1);
    expect(mocks.getThreadIPC).toHaveBeenCalledWith(SESSION);
  });

  it('lands the transcript in the store after the switch', async () => {
    await useConversationStore.getState().setActiveThread(SESSION);

    const messages = useConversationStore.getState().messages[SESSION];
    expect(messages).toBeDefined();
    expect(messages).toHaveLength(1);
    expect(useConversationStore.getState().activeThreadId).toBe(SESSION);
  });

  it('does not read the transcript again when the metadata refresh runs on its own', async () => {
    await useConversationStore.getState().setActiveThread(SESSION);
    mocks.getThreadIPC.mockClear();

    // The sidebar refresh path: the active session's transcript is already
    // in the store, so the refresh must not read it again.
    await useConversationStore.getState().loadFromDatabase();

    expect(mocks.getThreadIPC).not.toHaveBeenCalled();
  });
});

describe('chat view — mounting reads the session row, not the transcript', () => {
  it('does not read the transcript', () => {
    const source = readFileSync(findRepoFile('packages/ui/src/components/chat/ChatView.tsx'), 'utf8');
    const transcriptImport = /import[^;]*\bgetThreadIPC\b[^;]*from\s*'@\/lib\/ipc-client'/.test(source);
    expect(transcriptImport).toBe(false);
    expect(source).toContain('getThreadMetadataIPC');
  });
});

/**
 * The path of a file in the repository, found from wherever the runner was
 * started: the test walks up until the file is there.
 */
function findRepoFile(relativePath: string): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, relativePath);
    if (readFileSyncSafe(candidate) !== null) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`could not find ${relativePath} above ${process.cwd()}`);
}

function readFileSyncSafe(file: string): string | null {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
}
