/**
 * Does a turn have to build a new agent to ask the same question again?
 *
 * ## The defect this file exists for
 *
 * The Desktop agent server sends an `init` to the worker on EVERY turn
 * (`apps/desktop/src/main/agents/server/router.ts` sends it unconditionally on
 * every `POST /sessions/:id/chat`). The worker answered that by destroying
 * the agent it was already running in and building a new one:
 *
 *   - the tool catalog was rebuilt,
 *   - every skill directory was re-scanned and re-security-scanned,
 *   - the WHOLE transcript was read back out of the database and parsed,
 *   - the MCP servers were torn down and handshaked again.
 *
 * And the handshake is where the turn's latency went. `handleChatStart`
 * waits for MCP to be ready before it may ask the model anything, and the
 * handshake used to start AFTER that wait -- so the wait had nothing to wait
 * for, sat out its whole timeout, and the turn began without MCP tools. The
 * worker's own log said it on every single turn:
 *
 *   [Agent] MCP ready timeout after 3000ms; proceeding without MCP tools
 *
 * Measured on the product's own path (real Electron, production build, the
 * loopback Anthropic endpoint), a turn spent **3.5-4.1 s** between the
 * submission and the provider receiving the request.
 *
 * ## What is asserted here
 *
 * Two things, both about COUNTS and ORDERS rather than milliseconds, so they
 * are exact on any machine:
 *
 *   1. An init payload that asks for the agent the worker already has is
 *      recognised as such -- and a payload that asks for a DIFFERENT agent is
 *      not.
 *   2. The MCP handshake is started BEFORE the queued chat start is drained,
 *      and the reuse guard is decided BEFORE the agent is destroyed. Both
 *      orders are what the fix rests on, and both are the kind of thing a
 *      later edit silently puts back.
 *
 * ## What this file does NOT prove
 *
 * It does not drive a real worker process, and it does not prove the
 * end-to-end latency. The latency claim comes from the shared harness
 * (`e2e/perf/scenarios/send-to-first-output.mjs`), which measures the real
 * product path; this file is the regression gate that keeps the shape of the
 * fix from being undone.
 */
import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  canReuseAgentForInit,
  workerInitFingerprint,
  type WorkerInitShape,
} from '../src/worker-init-fingerprint.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKER_ENTRY = path.join(HERE, '..', 'src', 'worker-process-entry.ts');

/** An init payload as the agent server sends one. */
function initPayload(overrides: Partial<WorkerInitShape> = {}): WorkerInitShape {
  return {
    providerConfig: {
      apiKey: 'test-key',
      baseURL: 'https://provider.invalid',
      model: 'claude-test',
      provider: 'anthropic',
      authStyle: 'api_key',
    },
    workingDirectory: 'C:\\work\\project',
    defaultWorkspaceDirectory: 'C:\\work\\project',
    systemPrompt: 'you are duya',
    language: 'zh',
    communicationPlatform: 'duya-app',
    permissionRules: { alwaysAllow: ['Read'], alwaysAsk: [] },
    currentProjectId: 'project-1',
    projectHome: 'C:\\work\\project\\.duya',
    skillPaths: ['C:\\work\\project\\.claude\\skills'],
    sandboxEnabled: true,
    securityScanEnabled: true,
    referencesEnabled: true,
    ...overrides,
  };
}

describe('the worker recognises the agent it is already running in', () => {
  it('recognises the same payload as the same agent', () => {
    const first = initPayload();
    const second = initPayload();
    expect(workerInitFingerprint(first)).toBe(workerInitFingerprint(second));
    expect(canReuseAgentForInit(first, second)).toBe(true);
  });

  it('does not care about the order the keys arrive in', () => {
    const first = initPayload();
    const second = initPayload({
      permissionRules: { alwaysAsk: [], alwaysAllow: ['Read'] },
    });
    expect(workerInitFingerprint(first)).toBe(workerInitFingerprint(second));
    expect(canReuseAgentForInit(first, second)).toBe(true);
  });

  it('never reuses an agent when there is no agent yet', () => {
    expect(canReuseAgentForInit(null, initPayload())).toBe(false);
  });

  // Each of these is a field the agent is BUILT from. A change to any of
  // them means a different agent, and the worker has to build it.
  const changes: Array<[string, Partial<WorkerInitShape>]> = [
    ['the model', { providerConfig: { apiKey: 'test-key', model: 'another-model', provider: 'anthropic' } }],
    ['the provider', { providerConfig: { apiKey: 'test-key', model: 'claude-test', provider: 'openai' } }],
    ['the api key', { providerConfig: { apiKey: 'another-key', model: 'claude-test', provider: 'anthropic' } }],
    ['the base url', { providerConfig: { apiKey: 'test-key', baseURL: 'https://other.invalid', model: 'claude-test', provider: 'anthropic' } }],
    ['the working directory', { workingDirectory: 'C:\\work\\other' }],
    ['the default workspace directory', { defaultWorkspaceDirectory: 'C:\\work\\other' }],
    ['the system prompt', { systemPrompt: 'you are something else' }],
    ['the language', { language: 'en' }],
    ['the communication platform', { communicationPlatform: 'cli' }],
    ['the permission rules', { permissionRules: { alwaysAllow: ['Write'] } }],
    ['the project', { currentProjectId: 'project-2' }],
    ['the project home', { projectHome: 'C:\\work\\other\\.duya' }],
    ['the skill paths', { skillPaths: ['C:\\work\\project\\.claude\\skills', 'C:\\extra\\skills'] }],
    ['the sandbox flag', { sandboxEnabled: false }],
    ['the security scan flag', { securityScanEnabled: false }],
    ['the references flag', { referencesEnabled: false }],
  ];

  for (const [what, change] of changes) {
    it(`builds a new agent when ${what} changed`, () => {
      expect(canReuseAgentForInit(initPayload(), initPayload(change))).toBe(false);
    });
  }

  it('does not treat an absent field as a changed one', () => {
    // The agent server omits optional fields it has nothing to say about.
    // An omitted field and an empty one describe the same agent.
    const withEmpty = initPayload({ skillPaths: [], permissionRules: undefined });
    const without = initPayload({ skillPaths: [], permissionRules: undefined });
    expect(canReuseAgentForInit(withEmpty, without)).toBe(true);
  });
});

describe('the order the worker does its init work in', () => {
  // The gate reads the source, so it must not depend on how the checkout
  // happens to spell a line ending.
  const source = fs.readFileSync(WORKER_ENTRY, 'utf8').replace(/\r\n/g, '\n');

  it('starts the MCP handshake BEFORE it drains the queued chat start', () => {
    // `handleChatStart` waits for MCP to be ready before it may ask the
    // model anything. A handshake that starts after that wait is a wait with
    // nothing to wait for: the turn sits out the whole timeout and begins
    // without MCP tools. This is the order that makes the wait mean
    // something, and it is the thing a later edit silently puts back.
    const start = source.indexOf('startMcpInitialization();\n                await drainQueuedChatStart();');
    expect(
      start,
      'the MCP handshake must start before the queued chat start is drained',
    ).toBeGreaterThan(-1);

    // The handshake must not ALSO be started from the old place, after the
    // drain: two handshakes would tear down the first one's connections.
    const occurrences = source.match(/startMcpInitialization\(\);/g) ?? [];
    expect(occurrences, 'the MCP handshake is started more than once').toHaveLength(1);
  });

  it('decides whether to reuse the agent BEFORE it destroys it', () => {
    const guard = source.indexOf('canReuseAgentForInit(currentInitShape, initMsg)');
    const destroy = source.indexOf("Re-init: destroying existing agent and creating new one");
    expect(guard, 'the reuse guard is missing from the init handler').toBeGreaterThan(-1);
    expect(destroy, 'the agent destruction is missing from the init handler').toBeGreaterThan(-1);
    expect(
      guard,
      'the reuse guard must be decided before the agent is destroyed',
    ).toBeLessThan(destroy);
  });

  it('only records the init shape after the history restore succeeded', () => {
    // A failed history/tool/skill restore must never leave the agent
    // reusable: the next turn has to rebuild, because a rebuild is how it
    // recovers. Recording the shape unconditionally would make the next init
    // keep an agent with no history and no tools.
    expect(
      source,
      'the init shape must be recorded only after the restore succeeded',
    ).toMatch(/if \(restoreOk\) currentInitShape = initMsg;/);
    expect(source).toContain('restoreOk = true;');
  });

  it('does not reuse an agent whose MCP handshake failed', () => {
    // The reuse path skips the handshake, so a failed one would leave the
    // session without MCP tools for its whole lifetime.
    expect(
      source,
      'the reuse guard must require a successful MCP handshake',
    ).toMatch(/!mcpHandshakeFailed\s*\n\s*&& canReuseAgentForInit/);
  });
});
