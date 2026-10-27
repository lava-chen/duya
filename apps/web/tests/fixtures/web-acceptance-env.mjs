/**
 * apps/web/tests/fixtures/web-acceptance-env.mjs — the Web acceptance
 * environment.
 *
 * Brings up, in one process:
 *   - a loopback Anthropic provider (the scripted MODEL);
 *   - a real standalone Host with the PRODUCTION worker bundle;
 *   - the Web BFF, started the way the PRODUCT starts it.
 *
 * ## Why this fixture lives HERE and not in `e2e/`
 *
 * It composes a Host, so it imports `@duya/host`. `architecture-policy.yaml`
 * declares `apps/web/tests/fixtures` as a root of the `web-server` module,
 * whose `requires` include `duya-host` — that is the declared home for a
 * Node-backed web fixture that reaches the Host, and `browser-host.mjs`
 * next door has the same shape.
 *
 * The `e2e/` tree is not inside any declared module, so a Host import there
 * is a boundary violation, not a test. The Playwright spec and its config
 * live in `e2e/web/` (they touch nothing but the browser and the BFF); the
 * environment that composes the Host lives here.
 *
 * ## The BFF is started WITHOUT a resolver shim, on purpose
 *
 * `register-dist-resolver.mjs` (next door) exists because the
 * `tsc`-emitted server used to import the Host's dist chain, which reaches
 * `@duya/plugin-core` — whose `moduleResolution: bundler` emit plain Node
 * cannot resolve. The PRODUCT entry never loaded that shim, so
 * `npm run web-app` crashed and only the test fixture worked.
 *
 * The server is now bundled (see `scripts/build-web-server-bundle.mjs`) and
 * reads the runtime descriptor through `@duya/host/host-runtime`, so it needs
 * no shim at all. This fixture therefore starts it EXACTLY as the docs tell a
 * user to — `node apps/web/dist/server/main.js`, no `--import` — because a
 * Web acceptance that mounted the shim would pass while the documented
 * command stayed broken.
 *
 * ## What is real here, and what is not
 *
 * Real: the Host, the worker bundle the Host forks, the run ledger, the
 * permission-request ledger, the SSE envelopes, the BFF, the shared renderer,
 * and the browser that drives them.
 *
 * Scripted: the MODEL. The provider decides the BYTES for one HTTP request
 * and nothing else — it cannot create a run, settle a run, or emit a
 * protocol event. The executor decides what a turn does. See
 * `browser-host.mjs` for the same shape in the Web package's own tree.
 */

import http from 'node:http';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));

/**
 * THIS PROCESS loads the Host's dist chain, which reaches `@duya/plugin-core`
 * — whose `moduleResolution: bundler` emit plain Node cannot resolve. The
 * resolver hook below supplies the fallback.
 *
 * Note the asymmetry, which is the point: the shim is needed HERE because
 * this process composes a Host. The BFF it spawns does NOT get the shim —
 * it is started as the product starts it, and it needs none.
 */
await import(pathToFileURL(path.join(repo, 'apps/web/tests/fixtures/register-dist-resolver.mjs')).href);

const PORT = Number(process.env.DUYA_E2E_WEB_PORT ?? '5199');

/**
 * The phrase that makes the scripted model reach for a tool, and the
 * phrase that makes it reach for one the gate will ASK about.
 */
const TOOL_REQUEST_MARKER = '读取受控验收文件';
const APPROVAL_REQUEST_MARKER = '并等待我的批准';

/**
 * The scripted model.
 *
 * It answers by WHAT THE PROMPT ASKS FOR, so one environment can serve
 * several acceptance scenarios:
 *
 *   - a plain prompt      → a text answer (the send path);
 *   - a tool request      → one `bash` call, then a text answer that quotes
 *                            the tool result (the tool-stream path);
 *   - a permission prompt → a `bash` call whose command trips the
 *                            command-safety warning, so the worker raises a
 *                            permission request (the approval path);
 *   - `取消验收`          → a response that never ends, so a run stays open
 *                            long enough to be cancelled (the cancel path).
 *
 * ## Which request is the TURN
 *
 * The worker makes more than one provider call per turn, and they do not
 * look alike:
 *
 *   - the TURN advertises the tool list (21 tools here) and carries the
 *     user's request as the LAST text part of the last user message —
 *     behind four `<system-reminder>` parts (environment, skills, session
 *     guidance, vision capability);
 *   - a SIDE CALL (the session-title generator) advertises NO tools and
 *     wraps the same request in `<request>…</request>`.
 *
 * So "advertises tools" identifies the turn, and `<request>` identifies the
 * side call. A fixture that keys on the wrong one answers the wrong
 * request — the turn then never gets its tool call and the scenario hangs.
 */
function answerFor(promptText, hasTools, toolResults) {
  // The turn's follow-up request carries the tool result back to the model.
  if (toolResults.length > 0) {
    return { type: 'text', text: `工具已返回：${JSON.stringify(toolResults.map((r) => r.content))}` };
  }
  // A side call (the session title) is not the turn: answer it briefly and
  // never hold it open, or the title request would hang the whole run.
  if (!hasTools) {
    return { type: 'text', text: '受控浏览器验收' };
  }
  // The turn: the request decides what it does.
  if (!promptText.includes(TOOL_REQUEST_MARKER)) {
    return { type: 'text', text: '受控浏览器验收' };
  }
  return {
    type: 'tool_use',
    id: `web-tool-${Date.now()}`,
    name: 'bash',
    input: {
      // The tool scenario runs a CLEAN command, and the approval scenario
      // runs one that trips a command-safety warning.
      //
      // This split is duya's own behaviour, measured: the gate
      // auto-allows a workspace-confined command even under the `default`
      // profile (`isToolWithinWorkspace`), so a clean command never raises
      // a permission request and there would be nothing for the approval
      // scenario to approve. What DOES raise one is a command the safety
      // analysis flags — `node -e "…"` is "Script execution via -e/-c
      // flag".
      //
      // Both commands run the SAME proof script, so both produce the same
      // proof that the worker really executed a tool.
      command: promptText.includes(APPROVAL_REQUEST_MARKER)
        ? `node -e "require('${proofScriptPath.replace(/\\/g, '/')}')"`
        : `node "${proofScriptPath.replace(/\\/g, '/')}"`,
      description: '读取受控验收文件，并记录一次执行',
    },
  };
}

const heldResponses = new Set();

/**
 * The Anthropic Messages streaming frames for one assistant message.
 *
 * The shape is the wire's, not a convenience: a `tool_use` block arrives as
 * `content_block_start` with an EMPTY input followed by `input_json_delta`
 * fragments. A provider that puts the whole input in `content_block_start`
 * and sends no delta is accepted by the wire client (Plan 418 L1 preserves
 * it) but the executor never dispatches the call — the turn ends with
 * `stopReason: tool_use` and no tool ever runs. See
 * `apps/desktop/src/main/__tests__/eval-offline-provider.ts`, which scripts
 * the same shape.
 */
function jsonFragments(value) {
  const raw = JSON.stringify(value);
  const cut = Math.max(1, Math.ceil(raw.length / 2));
  return [raw.slice(0, cut), raw.slice(cut)];
}

function sseFrames(content) {
  const frames = [];
  const push = (event, data) => frames.push(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  push('message_start', {
    type: 'message_start',
    message: {
      id: `web-proof-${Date.now()}`,
      type: 'message',
      role: 'assistant',
      content: [],
      model: 'proof-model',
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  if (content.type === 'text') {
    push('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } });
    push('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: content.text } });
    push('content_block_stop', { type: 'content_block_stop', index: 0 });
  } else {
    push('content_block_start', {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: content.id, name: content.name, input: {} },
    });
    for (const fragment of jsonFragments(content.input)) {
      push('content_block_delta', {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: fragment },
      });
    }
    push('content_block_stop', { type: 'content_block_stop', index: 0 });
  }
  push('message_delta', {
    type: 'message_delta',
    delta: { stop_reason: content.type === 'text' ? 'end_turn' : 'tool_use', stop_sequence: null },
    usage: { output_tokens: 1 },
  });
  push('message_stop', { type: 'message_stop' });
  return frames.join('');
}

// A fresh data root: a fresh SQLite database, a fresh runtime descriptor,
// and a config that points the worker at the loopback provider.
//
// `DUYA_DATA_ROOT` is set in THIS process's environment because the WORKER
// is a separate process that resolves its provider configuration from the
// data root, not from the Host's options. Without it the worker reads the
// developer's own `~/.duya/config.toml`, names a provider this environment
// never defined, and every run fails at self-init with
// "worker self-init could not resolve a provider".
const root = await fs.mkdtemp(path.join(os.tmpdir(), 'duya-web-acceptance-'));
process.env.DUYA_DATA_ROOT = root;
delete process.env.DUYA_TEST;

/** What the worker actually advertised to the model, per request. */
const providerRequests = [];

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
    const partsOf = (message) => (Array.isArray(message.content)
      ? message.content
      : [{ type: 'text', text: String(message.content ?? '') }]);
    // The request the user typed is the LAST text part of the last user
    // message that is not one of the `<system-reminder>` attachments the
    // worker prepends (environment, skills, session guidance, vision).
    // The reminders are attached to the SAME message as the request, and
    // they are long — reading "the last user message" and taking its head
    // finds the environment, not the question.
    const requestText = (() => {
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message.role !== 'user') continue;
        const candidates = partsOf(message)
          .filter((part) => part.type === 'text')
          .map((part) => String(part.text ?? ''))
          .filter((text) => text.trim().length > 0)
          .filter((text) => !text.includes('This context was attached automatically by the system'));
        if (candidates.length > 0) return candidates[candidates.length - 1];
      }
      return '';
    })();
    const results = messages
      .flatMap((message) => partsOf(message)
        .filter((part) => part.type === 'tool_result'));

    // Record what the worker actually ADVERTISED and what it actually
    // asked. A tool call needs a tool in that list; if the list is empty
    // the worker has no tools to offer and the model cannot ask for one.
    //
    // The evidence is what makes a fixture bug visible: which call carried
    // the request, whether the tools were advertised, and whether a tool
    // result came back.
    const advertised = (body.tools ?? []).map((tool) => tool.name);
    providerRequests.push({
      requestText,
      advertisedTools: advertised.length,
      advertised,
      toolResults: results.length,
      isTurn: advertised.length > 0,
    });
    await fs.writeFile(path.join(root, 'provider-evidence.json'), JSON.stringify(providerRequests, null, 2));

    response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-cache-control': 'no-cache', 'cache-control': 'no-cache' });

    const hasTools = (body.tools ?? []).length > 0;

    // A turn that asks for cancellation gets a response that never ends, so
    // the run stays open and the Stop button has something to stop. Only
    // the TURN is held: a side call held open would hang the whole run.
    if (hasTools && requestText.includes('取消验收')) {
      response.flushHeaders();
      heldResponses.add(response);
      response.once('close', () => heldResponses.delete(response));
      return;
    }

    const content = answerFor(requestText, hasTools, results);
    response.end(sseFrames(content));
  } catch (error) {
    response.destroy(error);
  }
});

await new Promise((resolve) => provider.listen(0, '127.0.0.1', resolve));
const providerOrigin = `http://127.0.0.1:${provider.address().port}`;

const workspace = path.join(root, 'workspace');
await fs.mkdir(workspace);
await fs.writeFile(path.join(workspace, 'input.txt'), 'WEB_WORKER_READ_CONFIRMED');

/**
 * The file the tool WRITES when it really ran.
 *
 * The path is absolute because the approval scenario's command runs the
 * script through `node -e`: a relative path would depend on the working
 * directory the shell happens to start in.
 */
const executionsFile = path.join(workspace, 'executions.txt');

const proofScriptPath = path.join(workspace, 'proof.cjs');
await fs.writeFile(proofScriptPath, [
  "const fs = require('node:fs');",
  `fs.appendFileSync(${JSON.stringify(executionsFile)}, 'executed\\n');`,
  `process.stdout.write(fs.readFileSync(${JSON.stringify(path.join(workspace, 'input.txt'))}, 'utf8'));`,
].join('\n'));

await fs.writeFile(
  path.join(root, 'config.toml'),
  `[model]\nprovider = "web-proof"\ndefault = "proof-model"\n\n[providers.web-proof]\nproviderType = "anthropic"\nbaseUrl = "${providerOrigin}"\n\n[providers.web-proof.options]\ndefaultModel = "proof-model"\n`,
);
await fs.writeFile(
  path.join(root, 'secrets.json'),
  JSON.stringify({ 'providers.web-proof.apiKey': 'fixture-key-no-account' }),
);

// The Host is started in-process, like `browser-host.mjs` does, so the
// acceptance owns its lifetime and its data root.
const { startLocalHost } = await import('@duya/host/local-host');
const token = randomBytes(32).toString('hex');
const host = await startLocalHost({
  dataRoot: root,
  databasePath: path.join(root, 'duya-main.db'),
  rolloutRoot: path.join(root, 'sessions'),
  attachmentsRoot: path.join(root, 'attachments'),
  token,
  port: 0,
  ephemeral: true,
  workerPath: path.join(repo, 'packages/host/bundle/worker-entry.js'),
  betterSqlite3Path: path.join(repo, 'node_modules/better-sqlite3'),
});

// One session per acceptance scenario. They share a workspace but NOT a
// transcript: a session's title is derived from its first message, so a
// scenario that ran once would rename its session and break the next
// scenario's lookup. Separate sessions keep each scenario independent —
// which is also the isolation the plan asks a surface to prove.
const { HostSessionHttpClient } = await import('@duya/host/http-client');
const client = new HostSessionHttpClient(host.origin, token);
const binding = await client.registerLocalDirectory(workspace);
const SESSION_IDS = {
  send: 'web-send',
  tool: 'web-tool',
  approval: 'web-approval',
  cancel: 'web-cancel',
  reload: 'web-reload',
  isolation: 'web-isolation',
  isolationOther: 'web-isolation-other',
};

/**
 * The session's PERMISSION PROFILE, per scenario.
 *
 * The profile is the session row's own vocabulary (`default` / `auto` /
 * `full_access`), which the Host bridges into the run's policy mode
 * (`full_access` → `bypassPermissions`).
 *
 * The tool scenario runs under `full_access` — the profile that does not
 * ask — so the tool executes unattended and its RESULT is what the surface
 * shows. The approval scenario runs under `default` — the profile that
 * asks. Both run the same proof script; see `answerFor` for why the two
 * commands differ.
 */
const SESSION_PERMISSION_PROFILES = {
  send: 'default',
  tool: 'full_access',
  approval: 'default',
  cancel: 'default',
  reload: 'default',
  isolation: 'default',
  isolationOther: 'default',
};

for (const [key, id] of Object.entries(SESSION_IDS)) {
  await client.create({
    id,
    workspaceId: binding.workspaceId,
    workspaceRootId: binding.rootId,
    workspaceRelativePath: binding.relativePath,
    title: `Web 验收 · ${key}`,
    projectName: '架构验收',
    status: 'active',
    model: 'proof-model',
    providerId: 'web-proof',
    permissionMode: SESSION_PERMISSION_PROFILES[key],
  });
}

// The BFF: started as the PRODUCT starts it — no shim, no `--import`.
const bff = spawn(process.execPath, [path.join(repo, 'apps/web/dist/server/main.js')], {
  env: {
    ...process.env,
    DUYA_HOST_ORIGIN: host.origin,
    DUYA_HOST_TOKEN: token,
    DUYA_WEB_PORT: String(PORT),
  },
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

const metadata = {
  origin: bffOrigin,
  dataRoot: root,
  workspace,
  executionsFile,
  sessionIds: SESSION_IDS,
  sessionPermissionProfiles: SESSION_PERMISSION_PROFILES,
  providerOrigin,
};
await fs.writeFile(path.join(root, 'web-acceptance.json'), JSON.stringify(metadata, null, 2));
process.stdout.write(`${JSON.stringify(metadata)}\n`);

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
