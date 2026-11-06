/** Inspect actual provider requests across tool turns and Session restart. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, SSEEvent, Tool } from '@duya/host/worker-run-contracts';
import { ProjectTool } from '@duya/capabilities/project';
import { projectDb } from '@duya/host/worker-db-client';
import { makeWorkerSession, driveTurn, cleanupEngineTurnDirs } from './engine-turn-harness.js';

vi.mock('@duya/host/worker-db-client', async (original) => {
  const actual = await original<Record<string, Record<string, unknown>>>();
  return { ...actual,
    modeStateDb: { ...actual.modeStateDb, get: async () => null },
    mailboxDb: { ...actual.mailboxDb, claimBatch: async () => ({ rows: [], claimTokens: [] }) },
    messageDb: { ...actual.messageDb, append: async () => ({ success: true }) },
  };
});
const seen: Array<{ messages: Message[]; tools: string[]; system: string }> = [];
let state = 'INITIAL-PROJECT-MARKER';
let readsFail = false;
let scripts: SSEEvent[][] = [];
const done: SSEEvent = { type: 'done', reason: 'end_turn' };
vi.mock('@duya/ai', async (original) => {
  const actual = await original<Record<string, unknown>>();
  const client = { streamChat(messages: Message[], options?: { tools?: Tool[]; systemPrompt?: string }) {
    const index = seen.length;
    seen.push({ system: options?.systemPrompt ?? '', messages: structuredClone(messages), tools: (options?.tools ?? []).map((tool) => tool.name) });
    return (async function* () { for (const event of scripts[index] ?? [{ type: 'text', data: 'done' }, done]) yield event; })();
  } };
  return { ...actual, createAIClient: () => client, createAIClientWithRetry: () => client };
});

beforeEach(async () => {
  vi.stubEnv('DUYA_TEST', '1');
  vi.stubEnv('DUYA_TEST_NAMESPACE', 'project-prompt-context-proof');
  vi.stubEnv('DUYA_MEMORY_ENABLED', '0');
  vi.stubEnv('DUYA_E2E_DISABLE_LLM', '1');
  seen.length = 0;
  state = 'INITIAL-PROJECT-MARKER'; readsFail = false; scripts = [];
  vi.spyOn(projectDb, 'sessionContext').mockImplementation(async () => {
    if (readsFail) throw new Error('private read failure');
    return { projectId: 'bound-project', role: 'coordinator', taskId: null, text: state, sourceRefs: [] };
  });
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); cleanupEngineTurnDirs();
});
function agent() {
  const worker = makeWorkerSession({ apiKey: 'scripted', model: 'test-model', provider: 'anthropic',
    sessionId: 'coordinator-proof', workingDirectory: process.cwd(), permissionMode: 'bypassPermissions' });
  const project = new ProjectTool({ dispatch: async () => ({ ok: true }) });
  worker.activeMCPRegistry.register(project.toTool(), project);
  return worker;
}
function text(request: { messages: Message[] }): string { return JSON.stringify(request.messages); }
function snapshotText(request: { messages: Message[] }): string {
  return JSON.stringify(request.messages.filter((row) => JSON.stringify(row.content).includes('Host binding:')));
}

describe('Project prompt at the model boundary', () => {
  it('refreshes evidence inside a tool loop while retaining the stable prefix and narrow tool surface', async () => {
    const worker = agent();
    const registry = worker.activeMCPRegistry;
    const project = new ProjectTool({ dispatch: async () => {
      state = 'UPDATED-PROJECT-MARKER';
      return { ok: true, state: { revision: 2, currentState: state, nextStep: 'review', source: { type: 'session', id: 'coordinator-proof' }, updatedAt: 2 } };
    } });
    registry.register(project.toTool(), project);
    for (const name of ['todo', 'read', 'bash']) registry.register({ name, description: 'Excluded execution capability', input_schema: { type: 'object' } }, { execute: async () => { throw new Error('Excluded tool executed'); } });
    scripts = [[{ type: 'tool_use', data: { id: 'update', name: 'project', input: { action: 'update_state', expectedRevision: 1, currentState: 'updated', nextStep: 'review' } } }, done], [{ type: 'text', data: 'ready' }, done]];
    await driveTurn(worker, 'Continue the authorized project work', { options: { agentProfileId: 'project-coordinator', toolRegistry: registry }, maxTurns: 3 });
    expect(seen).toHaveLength(2);
    expect(snapshotText(seen[0])).toContain('INITIAL-PROJECT-MARKER');
    expect(snapshotText(seen[1])).toContain('UPDATED-PROJECT-MARKER');
    expect(snapshotText(seen[1])).not.toContain('INITIAL-PROJECT-MARKER');
    expect(seen[0].system).toBe(seen[1].system);
    expect(seen[0].system).toContain('Read context according to its source');
    expect(seen[0].tools).toContain('project');
    expect(seen[0].tools).not.toContain('todo');
    expect(seen[0].tools).not.toContain('tool_invoke');
    expect(JSON.stringify(worker.getMessages())).not.toContain('Host binding:');
  });

  it('rebuilds project context for resumed history and replaces failed reads with an explicit gap', async () => {
    const original = agent();
    await driveTurn(original, 'Status?', { options: { agentProfileId: 'project-coordinator' } });
    const history = original.getMessages();
    state = 'RESUMED-CURRENT-MARKER';
    const resumed = agent();
    resumed.setMessages(history);
    await driveTurn(resumed, 'Status now?', { options: { agentProfileId: 'project-coordinator' } });
    expect(snapshotText(seen[1])).toContain('RESUMED-CURRENT-MARKER');
    expect(snapshotText(seen[1])).not.toContain('INITIAL-PROJECT-MARKER');
    readsFail = true;
    await driveTurn(resumed, 'Read again', { options: { agentProfileId: 'project-coordinator' } });
    expect(text(seen[2])).toContain('Project context is unavailable');
    expect(text(seen[2])).not.toContain('RESUMED-CURRENT-MARKER');
    expect(text(seen[2])).not.toContain('private read failure');
  });
});
