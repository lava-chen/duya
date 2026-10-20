// Manual acceptance fixture: real Host and production worker, scripted HTTP provider.
// Run after building @duya/host and @duya/web. All data stays in a fresh temp root.
import http from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';

await import('./register-dist-resolver.mjs');
const { startLocalHost } = await import('@duya/host/local-host');
const { HostSessionHttpClient } = await import('@duya/host/http-client');

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-worker-proof-'));
const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, 'input.txt'), 'WEB_WORKER_READ_CONFIRMED');
await fs.writeFile(path.join(workspace, 'proof.cjs'), [
  "const fs = require('node:fs');",
  "fs.appendFileSync('executions.txt', 'executed\\n');",
  "process.stdout.write(fs.readFileSync('input.txt', 'utf8'));",
].join('\n'));
const requests = [];
const heldResponses = new Set();
const provider = http.createServer(async (request, response) => {
  if (request.method !== 'POST' || request.url !== '/v1/messages') {
    response.writeHead(404).end();
    return;
  }
  try {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    const messages = body.messages ?? [];
    const textOf = (message) => typeof message.content === 'string' ? message.content :
      (message.content ?? []).filter((part) => part.type === 'text').map((part) => part.text).join('\n');
    const promptIndex = messages.findLastIndex((message) => message.role === 'user' && textOf(message).trim() &&
      !(Array.isArray(message.content) && message.content.some((part) => part.type === 'tool_result')));
    const prompt = messages[promptIndex];
    const results = messages.slice(promptIndex + 1).flatMap((message) =>
      Array.isArray(message.content) ? message.content.filter((part) => part.type === 'tool_result') : []);
    requests.push({ tools: (body.tools ?? []).map((tool) => tool.name), toolResults: results });
    await fs.writeFile(path.join(root, 'provider-evidence.json'), JSON.stringify(requests, null, 2));
    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    if (textOf(prompt ?? { content: '' }).includes('取消验收')) {
      response.flushHeaders();
      heldResponses.add(response);
      response.once('close', () => heldResponses.delete(response));
      return;
    }
    const content = (body.tools ?? []).length === 0 ? { type: 'text', text: '受控浏览器验收' } : results.length > 0
      ? { type: 'text', text: `工具已返回：${JSON.stringify(results.map((result) => result.content))}` }
      : { type: 'tool_use', id: `browser-read-${requests.length}`, name: 'bash', input: {
        command: 'node -e "require(\'./proof.cjs\')"', description: '读取受控验收文件，并记录一次执行',
      } };
    const events = [
      ['message_start', { type: 'message_start', message: { id: `proof-${requests.length}`, type: 'message', role: 'assistant', content: [], model: 'proof-model', stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }],
      ['content_block_start', { type: 'content_block_start', index: 0, content_block: content.type === 'text' ? { type: 'text', text: '' } : content }],
      ...(content.type === 'text' ? [['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } }]] : []),
      ['content_block_stop', { type: 'content_block_stop', index: 0 }],
      ['message_delta', { type: 'message_delta', delta: { stop_reason: content.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null }, usage: { output_tokens: 1 } }],
      ['message_stop', { type: 'message_stop' }],
    ];
    response.end(events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
  } catch (error) {
    response.destroy(error);
  }
});
await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerOrigin = `http://127.0.0.1:${provider.address().port}`;
process.env.DUYA_DATA_ROOT = root;
delete process.env.DUYA_TEST;
await fs.writeFile(path.join(root, 'config.toml'), `[model]\nprovider = "browser-proof"\ndefault = "proof-model"\n\n[providers.browser-proof]\nproviderType = "anthropic"\nbaseUrl = "${providerOrigin}"\n\n[providers.browser-proof.options]\ndefaultModel = "proof-model"\n`);
await fs.writeFile(path.join(root, 'secrets.json'), JSON.stringify({ 'providers.browser-proof.apiKey': 'fixture-key-no-account' }));
const token = randomBytes(32).toString('hex');
const host = await startLocalHost({
  dataRoot: root, databasePath: path.join(root, 'duya-main.db'),
  rolloutRoot: path.join(root, 'sessions'), attachmentsRoot: path.join(root, 'attachments'),
  token, port: 0, ephemeral: true,
  workerPath: path.join(repo, 'packages/host/bundle/worker-entry.js'),
  betterSqlite3Path: path.join(repo, 'node_modules/better-sqlite3'),
});
const client = new HostSessionHttpClient(host.origin, token);
const binding = await client.registerLocalDirectory(workspace);
for (const [id, title] of [['browser-proof', '浏览器验收 · 受控模型'], ['browser-proof-other', '另一个隔离会话']]) {
  await client.create({ id, workspaceId: binding.workspaceId, workspaceRootId: binding.rootId,
    workspaceRelativePath: binding.relativePath, title, projectName: '架构验收', status: 'active',
    model: 'proof-model', providerId: 'browser-proof', permissionMode: 'default' });
}
// Start the app the way `npm start` does: the built BFF entry owns the
// internal web-bff module, and this fixture only consumes its public origin.
const bff = spawn(process.execPath, [
  '--import', pathToFileURL(path.join(repo, 'apps/web/tests/fixtures/register-dist-resolver.mjs')).href,
  path.join(repo, 'apps/web/dist/server/main.js'),
], {
  env: { ...process.env, DUYA_HOST_ORIGIN: host.origin, DUYA_HOST_TOKEN: token, DUYA_WEB_PORT: '0' },
  stdio: ['ignore', 'pipe', 'inherit'],
});
const bffOrigin = await new Promise((resolve, reject) => {
  let output = '';
  bff.stdout.on('data', (chunk) => {
    output += chunk;
    const match = /Duya web BFF listening at (http:\/\/\S+)/.exec(output);
    if (match) resolve(match[1]);
  });
  bff.once('exit', (code) => reject(new Error(`web BFF exited before listening (code ${code})`)));
});
const metadata = { origin: bffOrigin, dataRoot: root, sessionId: 'browser-proof' };
await fs.writeFile(path.join(root, 'browser-proof.json'), JSON.stringify(metadata, null, 2));
process.stdout.write(JSON.stringify(metadata) + '\n');
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  for (const response of heldResponses) response.destroy();
  bff.kill('SIGTERM');
  await new Promise((resolve) => bff.once('exit', resolve));
  await host.close();
  provider.closeAllConnections();
  await new Promise((resolve) => provider.close(resolve));
  process.exit(0);
}
process.once('SIGINT', () => { void close(); });
process.once('SIGTERM', () => { void close(); });
