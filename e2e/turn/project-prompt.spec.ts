/** Real Desktop -> worker -> Host DB -> loopback provider prompt contract. */
import { test, expect } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { launchDuya, closeDuya, invokeApi, userDataRootFor, type DuyaApp } from '../helpers';
import { startLoopbackAnthropic, type LoopbackAnthropic } from './loopback-anthropic';

let app: DuyaApp | null = null;
let provider: LoopbackAnthropic | null = null;
test.afterEach(async () => { if (app) await closeDuya(app.app); app = null; await provider?.close(); provider = null; });

test('Coordinator prompts and fresh Session-bound state reach the packaged worker provider', async () => {
  const namespace = `project-prompt-${Date.now()}`;
  const workspace = join(userDataRootFor(namespace), 'workspace');
  mkdirSync(workspace, { recursive: true });
  provider = await startLoopbackAnthropic({ text: 'Project state is ready for review.', model: 'claude-test',
    toolCalls: [{ nameIncludes: 'project', input: { action: 'update_state', expectedRevision: 0,
      currentState: 'E2E-PROJECT-STATE-UPDATED', nextStep: 'Review the result' } }] });
  app = await launchDuya({ namespace, previewMode: true });
  await expect.poll(() => invokeApi<string | null>(app!.page, 'agentServer.getUrl'), { timeout: 30000 }).toMatch(/^http:\/\/127\.0\.0\.1:/);
  const url = (await invokeApi<string>(app.page, 'agentServer.getUrl'))!;
  const project = await invokeApi<{ success: boolean; projectId: string }>(app.page, 'projects.register', { name: 'Prompt boundary probe', paths: [{ path: workspace }] });
  expect(project.success).toBe(true);
  const coordinator = await invokeApi<{ success: boolean; sessionId: string }>(app.page, 'projectWorkspace.ensureCoordinator', project.projectId);
  expect(coordinator.success).toBe(true);
  const result = await app.page.evaluate(async (input) => {
    const response = await fetch(`${input.url}/sessions/${encodeURIComponent(input.sessionId)}/chat`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      signal: AbortSignal.timeout(60000),
      body: JSON.stringify({ prompt: 'Record the authorized project progress and report it.',
        providerConfig: { apiKey: 'loopback-test-only', baseURL: input.provider, model: 'claude-test', provider: 'anthropic', authStyle: 'api_key' },
        workingDirectory: input.workspace, defaultWorkspaceDirectory: input.workspace,
        options: { runOrigin: 'user', agentProfileId: 'project-coordinator' } }),
    });
    return { status: response.status, body: await response.text() };
  }, { url, sessionId: coordinator.sessionId, provider: provider.baseUrl, workspace });
  expect(result.status).toBe(200);
  expect(result.body).toContain('done');
  const calls = provider.requests.filter((request) => request.toolNames.includes('project'));
  expect(calls.length).toBeGreaterThanOrEqual(2);
  expect(JSON.stringify(calls[0].system)).toContain('Read context according to its source');
  expect(JSON.stringify(calls[0].system)).not.toContain('Durable Project Context');
  expect(JSON.stringify(calls[0].messages)).toContain(project.projectId);
  expect(JSON.stringify(calls[0].messages)).toContain('state: not recorded');
  expect(JSON.stringify(calls[1].messages)).toContain('E2E-PROJECT-STATE-UPDATED');
  expect(JSON.stringify(calls[1].messages)).toContain('revision 1');
  expect(calls[0].system).toEqual(calls[1].system);
  expect(calls[0].toolNames).toEqual(expect.arrayContaining(['project', 'session']));
  for (const name of ['todo', 'tool_catalog', 'tool_invoke', 'bash', 'read']) expect(calls[0].toolNames).not.toContain(name);
});
