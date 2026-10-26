import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { startLocalHost, type LocalHostHandle } from '../src/local-host.js';
import { HostSessionHttpClient } from '../src/http-client.js';

// A real child process exercises production dispatch and terminal persistence.
// The marker controls when it finishes, independently of client presence.
const WORKER = `
const fs = require('node:fs');
let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => {
  buffer += chunk;
  let i;
  while ((i = buffer.indexOf('\\n')) >= 0) {
    const line = buffer.slice(0, i); buffer = buffer.slice(i + 1);
    if (!line.trim()) continue;
    const command = JSON.parse(line);
    if (command.type !== 'chat:start') continue;
    fs.appendFileSync(__filename + '.starts', command.runId + '\\n');
    let seq = 0;
    const emit = payload => process.send({ type: 'run:event', epoch: command.options.attemptEpoch,
      envelope: { runId: command.runId, sessionId: command.sessionId, seq: ++seq,
        timestamp: Date.now(), traceId: 'bot-test', payload } });
    emit({ type: 'run.started', manifestHash: command.manifestHash,
      protocol: { major: 1, minor: 0 }, runtime: { name: 'bot-test', version: '1' } });
    const timer = setInterval(() => {
      if (!fs.existsSync(command.prompt)) return;
      clearInterval(timer);
      emit({ type: 'assistant.text_block', messageId: 'reply', index: 0, text: 'durable channel answer' });
      emit({ type: 'run.completed', status: 'completed', stopReason: 'end_turn' });
      process.send({ type: 'chat:done', sessionId: command.sessionId });
    }, 20);
  }
});
process.on('disconnect', () => process.exit(0));
`;

async function until(check: () => boolean | Promise<boolean>, timeout = 15_000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error('Timed out waiting for Bot runtime state');
}

async function setup() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-bot-resident-'));
  const dataRoot = path.join(root, 'data');
  const workerPath = path.join(root, 'worker.cjs');
  await fs.mkdir(dataRoot);
  await fs.writeFile(workerPath, WORKER);
  await fs.writeFile(path.join(dataRoot, 'config.toml'), '[agents.helper]\nname = "Helper"\n');
  const marker = path.join(root, 'finish');
  const options = {
    dataRoot, workerPath, token: 'bot-resident-test',
    runtimeFilePath: path.join(dataRoot, 'runtime', 'host-api.json'),
    diagnostics: 'file' as const,
    botRuntime: { ownerId: 'local-test-owner', pollIntervalMs: 20 },
  };
  const command = {
    ownerId: 'local-test-owner', botId: 'helper', source: 'test', sourceEventId: 'event',
    payloadJson: JSON.stringify({ prompt: marker }),
  };
  return { root, workerPath, marker, options, command };
}

describe('headless Bot resident', () => {
  it('delivers a channel reply from a real child terminal and replays it after Host restart without resending', async () => {
    const h = await setup();
    await fs.writeFile(h.workerPath, WORKER.replace('if (!fs.existsSync(command.prompt)) return;',
      `if (!fs.existsSync(${JSON.stringify(h.marker)})) return;`));
    const target = { ownerId: 'local-test-owner', botId: 'helper', platform: 'telegram', chatId: '123', bindingId: 'binding' };
    let sends = 0;
    const channels = {
      resolveTarget: () => target,
      adapters: [{ platform: 'telegram', async send() {
        sends += 1;
        return { state: 'delivered' as const, remoteMessageId: 'remote-55' };
      } }],
    };
    const options = { ...h.options, botRuntime: { ...h.options.botRuntime, channels } };
    const envelope = { sourceEventId: 'event-12', address: { platform: 'telegram', chat: '123' },
      sender: 'external', text: 'hello', reaction: null };
    let host: LocalHostHandle | undefined;
    try {
      host = await startLocalHost(options);
      const accepted = await host.botChannels!.acceptInbound('helper', envelope);
      await fs.writeFile(h.marker, 'finish');
      await until(() => host!.botChannels!.list('helper')[0]?.status === 'delivered');
      expect(host.botInputs!.get(accepted.entry.id)?.status).toBe('settled');
      expect(host.botChannels!.list('helper')[0]?.outbound.content).toBe('durable channel answer');
      await host.close();
      host = await startLocalHost(options);
      expect((await host.botChannels!.acceptInbound('helper', envelope)).entry.id).toBe(accepted.entry.id);
      await host.botInputs!.tick();
      expect(sends).toBe(1);
      expect((await fs.readFile(`${h.workerPath}.starts`, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await host?.close();
      await fs.rm(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('finishes a real child run after the last client leaves, then releases the Host', async () => {
    const h = await setup();
    let host: LocalHostHandle | undefined;
    try {
      host = await startLocalHost({ ...h.options, clientScoped: true, clientLeaseIdleTimeoutMs: 100 });
      const client = new HostSessionHttpClient(host.origin, h.options.token);
      const lease = await client.openClientLease();
      const accepted = await host.botInputs!.accept(h.command);
      await until(() => host!.botInputs!.get(accepted.entry.id)?.status === 'dispatched');
      lease!.close();
      // Cross the real server's one-second idle poll with zero attached clients.
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(await client.getHealth()).toMatchObject({ ok: true });
      expect(host.botInputs!.get(accepted.entry.id)?.status).toBe('dispatched');
      await fs.writeFile(h.marker, 'finish');
      await until(() => host!.botInputs!.get(accepted.entry.id)?.status === 'settled');
      await until(async () => { try { await fs.access(h.options.runtimeFilePath); return false; } catch { return true; } });
      expect((await fs.readFile(`${h.workerPath}.starts`, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await host?.close();
      await fs.rm(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('recovers an input committed before shutdown without any UI or client lease', async () => {
    const h = await setup();
    let host: LocalHostHandle | undefined;
    try {
      host = await startLocalHost({ ...h.options, botRuntime: { ...h.options.botRuntime, pollIntervalMs: 60_000 } });
      const accepted = await host.botInputs!.accept(h.command);
      expect(accepted.entry.status).toBe('pending');
      await host.close();
      host = await startLocalHost(h.options);
      await fs.writeFile(h.marker, 'finish');
      await until(() => host!.botInputs!.get(accepted.entry.id)?.status === 'settled');
      expect((await host.botInputs!.accept(h.command)).entry.id).toBe(accepted.entry.id);
      expect((await fs.readFile(`${h.workerPath}.starts`, 'utf8')).trim().split('\n')).toHaveLength(1);
    } finally {
      await host?.close();
      await fs.rm(h.root, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps legacy scheduling as the default and refuses an enabled runtime without execution', async () => {
    const h = await setup();
    let host: LocalHostHandle | undefined;
    try {
      host = await startLocalHost({ ...h.options, botRuntime: undefined });
      expect(host.botInputs).toBeUndefined();
      await host.close();
      host = undefined;
      await expect(startLocalHost({ ...h.options, workerPath: undefined })).rejects.toThrow('requires a worker');
    } finally {
      await host?.close();
      await fs.rm(h.root, { recursive: true, force: true });
    }
  }, 30_000);
});
