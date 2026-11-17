/** Real bundled Workers, local scripted provider, HTTP control plane and durable Task settlement. */
import * as http from 'node:http';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, it, vi } from 'vitest';
import pty, { type IPty } from 'node-pty';
import type { SessionId } from '@duya/agent-protocol';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { HostSessionHttpClient } from '../src/http-client.js';

function latestPrompt(messages: unknown[]): string {
  for (const message of [...messages].reverse()) {
    if (typeof message !== 'object' || message === null || !('role' in message) || message.role !== 'user' || !('content' in message)) continue;
    if (typeof message.content === 'string') return message.content;
    if (!Array.isArray(message.content)) continue;
    const parts = message.content.flatMap((block: unknown) => typeof block === 'object' && block !== null &&
      'type' in block && block.type === 'text' && 'text' in block && typeof block.text === 'string' ? [block.text] : []);
    if (parts.length) return parts.join('\n');
  }
  return '';
}

function stream(content: Record<string, unknown>, id: string): string {
  const isTool = content.type === 'tool_use';
  const events = [
    { type: 'message_start', message: { id: `msg-${id}`, type: 'message', role: 'assistant', content: [], model: 'test-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } },
    { type: 'content_block_start', index: 0, content_block: isTool ? content : { type: 'text', text: '' } },
    ...(isTool ? [] : [{ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } }]),
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: isTool ? 'tool_use' : 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
    { type: 'message_stop' },
  ];
  return events.map((data) => `event: ${data.type}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}
function tool(name: string, id: string, input: Record<string, unknown>): string {
  return stream({ type: 'tool_use', id, name, input }, id);
}
function text(value: string): string {
  return stream({ type: 'text', text: value }, value);
}
async function waitFor(check: () => Promise<boolean>, diagnostic: () => string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await delay(25);
  }
  throw new Error(`Project Worker acceptance timed out: ${diagnostic()}`);
}

it('creates and updates a Task through a real Coordinator Worker, delegates it, and requires human acceptance', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-project-task-worker-'));
  const workspace = path.join(root, 'workspace');
  await fs.mkdir(workspace);
  let host: LocalHostHandle | undefined;
  let terminal: IPty | undefined;
  let client: HostSessionHttpClient | undefined;
  let projectId = '';
  const requests: string[] = [];
  const errors: string[] = [];
  const server = http.createServer((request, response) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { messages?: unknown[]; tools?: { name: string }[] };
      const transcript = JSON.stringify(body.messages ?? []);
      requests.push(transcript);
      let result: string;
      if (!body.tools?.length) {
        result = text('OK');
      } else if (latestPrompt(body.messages ?? []).includes('PROJECT_TASK_CHILD:')) {
        result = text('PROJECT_TASK_CHILD_DONE');
      } else if (!transcript.includes('coordinator-create-task')) {
        expect(body.tools?.map((item) => item.name)).toEqual(expect.arrayContaining(['project', 'session']));
        expect(body.tools?.some((item) => ['bash', 'read', 'write'].includes(item.name))).toBe(false);
        result = tool('project', 'coordinator-create-task', { action: 'create_task', requestId: 'worker-task', subject: 'Worker proof', description: 'Return the deterministic completion marker' });
      } else if (!transcript.includes('coordinator-update-task')) {
        const row = (await client!.getProjectContinuity(projectId))!.tasks[0]!;
        result = tool('project', 'coordinator-update-task', { action: 'update_task', taskId: row.link.taskId, expectedRevision: row.link.revision, description: 'Return PROJECT_TASK_CHILD_DONE as the execution evidence' });
      } else if (!transcript.includes('coordinator-spawn-task')) {
        const row = (await client!.getProjectContinuity(projectId))!.tasks[0]!;
        result = tool('session', 'coordinator-spawn-task', { action: 'spawn', workingDirectory: workspace, use_worktree: false,
          projectTask: { taskId: row.link.taskId, expectedRevision: row.link.revision }, prompt: 'PROJECT_TASK_CHILD: return the completion marker' });
      } else {
        result = text('PROJECT_COORDINATOR_DISPATCHED');
      }
      response.writeHead(200, { 'Content-Type': 'text/event-stream' });
      response.end(result);
    })().catch((error: unknown) => {
      errors.push(error instanceof Error ? error.message : String(error));
      response.writeHead(500);
      response.end('scripted provider failed');
    });
  });
  try {
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve); });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Provider did not bind');
    vi.stubEnv('DUYA_DATA_ROOT', root);
    vi.stubEnv('DUYA_TEST', '');
    await fs.writeFile(path.join(root, 'config.toml'),
      `[model]\nprovider = "local-test"\ndefault = "test-model"\n\n` +
      `[providers.local-test]\nproviderType = "anthropic"\nbaseUrl = "http://127.0.0.1:${address.port}"\n\n` +
      `[providers.local-test.options]\ndefaultModel = "test-model"\n\n[tools]\nexposure = "full"\n`);
    await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ 'providers.local-test.apiKey': 'local-fixture-not-a-secret' }));
    const workerPath = path.join(root, 'worker.cjs');
    await fs.writeFile(workerPath, `delete process.env.VITEST;\nrequire(${JSON.stringify(path.resolve('packages/host/bundle/worker-entry.js'))});\n`);
    host = await startLocalHost({ dataRoot: root, rolloutRoot: path.join(root, 'sessions'), attachmentsRoot: path.join(root, 'attachments'),
      runtimeFilePath: path.join(root, 'runtime', 'host-api.json'), port: 0, token: 'project-task-fixture-token', workerPath,
      betterSqlite3Path: path.resolve('node_modules/better-sqlite3'), ephemeral: true });
    client = new HostSessionHttpClient(host.origin, 'project-task-fixture-token');
    const project = await client.createProject({ name: 'Worker proof', paths: [{ path: workspace, description: null }] });
    projectId = project.project_id;
    const binding = await client.registerLocalDirectory(workspace);
    const coordinator = await client.create({ workspaceId: binding.workspaceId, workspaceRootId: binding.rootId,
      workspaceRelativePath: binding.relativePath, title: 'Coordinator proof', status: 'active', model: 'test-model', providerId: 'local-test',
      permissionMode: 'auto', agentProfileId: 'project-coordinator' });
    await client.bindCoordinatorSession(projectId, coordinator.id);
    const started = await client.startAgentRun({ sessionId: coordinator.id, prompt: 'PROJECT_TASK_COORDINATOR: create, update and delegate one Task',
      model: 'test-model', providerId: 'local-test', apiFormat: 'anthropic', options: { maxTurns: 8 } });
    expect(started.accepted).toBe(true);
    if (!started.accepted) throw new Error(JSON.stringify(started));
    const diagnostic = () => JSON.stringify({ errors, requests: requests.map((value) => value.slice(-1500)) });
    await waitFor(async () => {
      const parent = await client!.getAgentRun(started.runId);
      if (parent?.status === 'running') return false;
      expect(parent?.status, diagnostic()).toBe('completed');
      const rows = (await client!.getProjectContinuity(projectId))!.tasks;
      return rows.length === 1 && rows[0]?.task?.status === 'completed';
    }, diagnostic);
    expect(errors).toEqual([]);
    const snapshot = (await client.getProjectContinuity(projectId))!;
    expect(snapshot.tasks).toHaveLength(1);
    const row = snapshot.tasks[0]!;
    expect(row).toMatchObject({ task: { subject: 'Worker proof', description: 'Return PROJECT_TASK_CHILD_DONE as the execution evidence', status: 'completed' },
      link: { acceptanceStatus: 'pending' }, attempts: [{ status: 'completed' }] });
    expect(row.attempts).toHaveLength(1);
    const child = await client.get(row.link.workSessionId as SessionId, { includeAllSessions: true });
    expect(child?.agentProfileId).toBe('code-expert');
    const childRun = await client.getAgentRun(row.attempts![0]!.runId!);
    expect(childRun).toMatchObject({ status: 'completed', sessionId: row.link.workSessionId, parentRunId: started.runId });
    const events = await client.readAgentRunEvents(childRun!.runId, { afterSeq: 0 });
    expect(events.some((event) => event.payload.type === 'assistant.text_block' && event.payload.text.includes('PROJECT_TASK_CHILD_DONE'))).toBe(true);
    let raw = '';
    const screen = () => raw.replace(/\u001b\[(\d*)C/g, (_match, count: string) => ' '.repeat(Number(count || 1)))
      .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '').replace(/\s+/g, ' ');
    terminal = pty.spawn(process.execPath, [path.resolve('packages/cli/bundle/cli.cjs'), 'project', '--project', projectId], {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: workspace,
      env: { ...process.env, DUYA_TUI_ATTACH: '1', DUYA_TUI_HOST_ORIGIN: host.origin, DUYA_TUI_HOST_TOKEN: 'project-task-fixture-token',
        DUYA_TUI_INLINE: '', DUYA_CLI_TUI: '1', CI: '', TERM: 'xterm-256color' },
    });
    terminal.onData((chunk) => { raw += chunk; });
    await waitFor(async () => screen().includes('duya tui') && screen().includes('PROJECT_COORDINATOR_DISPATCHED'), screen);
    await delay(300);
    terminal.write(`/project-task ${row.link.taskId} accept Worker evidence verified`);
    await delay(300);
    terminal.write('\r');
    await waitFor(async () => screen().includes('Accept Task'), screen);
    expect((await client.getProjectContinuity(projectId))!.tasks[0]!.link.acceptanceStatus).toBe('pending');
    terminal.write('\r');
    await waitFor(async () => (await client!.getProjectContinuity(projectId))!.tasks[0]!.link.acceptanceStatus === 'accepted', screen);
    const reviewed = (await client.getProjectContinuity(projectId))!;
    expect(reviewed.activity.filter((item) => item.type === 'task.accepted')).toHaveLength(1);
    expect(reviewed.activity.find((item) => item.type === 'task.accepted')?.source.type).toBe('user_action');
  } finally {
    try { terminal?.kill(); } catch { /* The terminal may have exited already. */ }
    await host?.close();
    server.closeAllConnections();
    await new Promise<void>((resolve) => { server.close(() => resolve()); });
    vi.unstubAllEnvs();
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 60_000);
