/**
 * End-to-end acceptance for the Web surface's agent loop.
 *
 * ## What this proves
 *
 * The Web client reaches the Host through a same-origin BFF, and the BFF
 * reaches a REAL Host with a REAL execution controller. This script drives
 * the browser's own routes — not the Host's — and checks that a turn started
 * from the browser produces durable events and a real answer.
 *
 * It runs against a Host that has a worker entry, because a Host without one
 * is a ledger-only composition: it would accept a run and never execute it,
 * and a test that accepted that would be testing the wrong thing.
 *
 * ## How to run it
 *
 * ```sh
 * npm run build:cli-dev          # the worker bundle the Host executes
 * node scripts/acceptance/web-agent-loop.mjs
 * ```
 *
 * The script starts its own Host and its own BFF, so it never touches a
 * running Desktop or a real data root.
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtemp, rm, mkdir } from 'node:fs/promises';
import { readFile, writeFile } from 'node:fs/promises';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const dataRoot = await mkdtemp(path.join(tmpdir(), 'duya-web-acceptance-'));
const workspace = path.join(dataRoot, 'workspace');
await mkdir(workspace, { recursive: true });

/**
 * The word the agent must answer with.
 *
 * It is short on purpose: the answer has to be findable in BOTH the streamed
 * text and the durable history, so a check can prove the two agree.
 */
const EXPECTED_ANSWER = 'PONG';

/**
 * The provider configuration the acceptance Host runs on.
 *
 * It is the DEVELOPER'S OWN configuration, read from the real data root: the
 * acceptance must exercise a REAL provider, because a stub would prove only
 * that the plumbing carries a request — not that an agent answered. The files
 * are COPIED into the temporary root so the Host's own resolution finds them
 * without the acceptance ever writing to the real data root.
 *
 * Nothing here is printed, and the temporary root is removed on the way out.
 */
const realDataRoot = process.env.DUYA_ACCEPTANCE_DATA_ROOT ?? path.join(homedir(), '.duya');
for (const fileName of ['config.toml', 'secrets.json']) {
  try {
    const content = await readFile(path.join(realDataRoot, fileName), 'utf8');
    await writeFile(path.join(dataRoot, fileName), content, 'utf8');
  } catch (error) {
    process.stderr.write(
      `This acceptance needs the real provider configuration (${fileName}) in ${realDataRoot}.\n` +
      `Point DUYA_ACCEPTANCE_DATA_ROOT at a data root that has one, or run it on a machine with a configured provider.\n` +
      `Underlying error: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exit(2);
  }
}

/**
 * The acceptance's own database.
 *
 * The real configuration may point its database at the ELECTRON default
 * (`%APPDATA%/DUYA/databases/duya-main.db`), which a running Desktop owns —
 * and a second owner is refused. So the acceptance pins the database into
 * its temporary root: it must not touch the developer's sessions, and it must
 * not fight the Desktop for the same file.
 */
const configPath = path.join(dataRoot, 'config.toml');
const configText = await readFile(configPath, 'utf8');
const databaseLine = `database_path = "${path.join(dataRoot, 'duya-main.db').replace(/\\/g, '\\\\')}"`;

/**
 * Point the `[storage]` section at the acceptance's own database.
 *
 * The section is rewritten LINE BY LINE rather than by a regular expression:
 * a pattern like `/^\[storage\][\s\S]*?(?=\n\[|$)/m` stops at the first line
 * END (because `$` is line-anchored under the `m` flag), so it replaces only
 * the section header and leaves the original `database_path` in place. The
 * result is a duplicate TOML key, and the worker then refuses to start with
 * "Can't redefine existing key" — a broken configuration that looks like a
 * transport failure.
 */
function pinDatabasePath(text) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => /^\s*\[storage\]\s*$/.test(line));
  if (start === -1) {
    return `[storage]\n${databaseLine}\n\n${text}`;
  }
  let end = start + 1;
  while (end < lines.length && !/^\s*\[/.test(lines[end])) end += 1;
  const existing = lines.findIndex(
    (line, index) => index > start && index < end && /^\s*database_path\s*=/.test(line),
  );
  if (existing !== -1) lines[existing] = databaseLine;
  else lines.splice(end, 0, databaseLine);
  return lines.join('\n');
}

await writeFile(configPath, pinDatabasePath(configText), 'utf8');

const children = [];

/**
 * Progress, stamped.
 *
 * The acceptance can sit for minutes waiting on a real provider, and a
 * silent run is indistinguishable from a hung one — so every step says where
 * it is and when it happened.
 */
const startedAt = Date.now();
function step(message) {
  process.stdout.write(`[+${((Date.now() - startedAt) / 1000).toFixed(1)}s] ${message}\n`);
}

function start(label, args, env, cwd = repoRoot) {
  const child = spawn(process.execPath, args, {
    cwd,
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const output = [];
  child.stdout.on('data', (chunk) => output.push(String(chunk)));
  child.stderr.on('data', (chunk) => output.push(String(chunk)));
  children.push({ label, child, output });
  return { child, output };
}

/**
 * Kill a child AND everything it spawned.
 *
 * The Host starts a worker process of its own. Killing only the Host leaves
 * that worker alive, and the worker inherits the Host's stdout pipe — so the
 * parent's pipe never reaches EOF and Node's event loop never drains. The
 * script then hangs AFTER printing its verdict, which reads exactly like a
 * failed acceptance. `taskkill /T` takes the tree.
 */
function killTree(child) {
  if (child.pid === undefined || child.exitCode !== null) return;
  try {
    execFileSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // The process is already gone.
    }
  }
}

async function waitFor(label, predicate, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const entry = children.find((item) => item.label === label);
    if (entry && predicate(entry.output.join(''))) return;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  const entry = children.find((item) => item.label === label);
  throw new Error(`${label} never reached the expected state. Output:\n${entry?.output.join('') ?? '(none)'}`);
}

function fail(message) {
  throw new Error(message);
}

/**
 * The repository's MAIN checkout.
 *
 * A worktree's `node_modules` and build outputs are not the main checkout's,
 * so an artifact built there is only visible here. `git rev-parse` names it
 * without guessing at a path.
 */
function mainCheckoutRoot() {
  try {
    const output = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
      cwd: repoRoot,
      encoding: 'utf8',
    }).trim();
    return path.dirname(output);
  } catch {
    return repoRoot;
  }
}

/** The first of the candidate paths that exists, or `null`. */
async function findBuildArtifact(candidates) {
  for (const candidate of candidates) {
    try {
      await readFile(candidate);
      return candidate;
    } catch {
      // Try the next one.
    }
  }
  return null;
}

let bffOrigin = '';

try {
  // 1. A REAL Host, with a worker entry, so a run actually executes.
  //
  // The CLI bundle and the worker bundle are BUILD OUTPUTS, so a worktree
  // that has not been built does not have them. The acceptance looks for them
  // in the checkout it was launched from first, then in the repository's main
  // checkout, and says so plainly when neither has one — a ledger-only Host
  // would accept the run and never execute it.
  const cliBundle = await findBuildArtifact([
    path.join(repoRoot, 'packages', 'cli', 'bundle', 'cli.cjs'),
    path.join(mainCheckoutRoot(), 'packages', 'cli', 'bundle', 'cli.cjs'),
  ]);
  if (cliBundle === null) {
    fail('The CLI bundle is missing. Run `npm run build:cli-dev` in the checkout you want to accept.');
  }
  start('host', [cliBundle, 'serve', '--port', '0'], {
    DUYA_DATA_ROOT: dataRoot,
    // The Host resolves its worker entry RELATIVE to its working directory
    // (`packages/host/bundle/worker-entry.js`), so the Host must start from
    // the checkout that holds the bundle it was given.
    DUYA_HOST_WORKER_PATH: await findBuildArtifact([
      path.join(repoRoot, 'packages', 'host', 'bundle', 'worker-entry.js'),
      path.join(mainCheckoutRoot(), 'packages', 'host', 'bundle', 'worker-entry.js'),
    ]) ?? '',
  }, path.dirname(path.dirname(path.dirname(cliBundle))));
  await waitFor('host', (text) => text.includes('Duya Host listening at'));
  step('host is listening');
  const hostOutput = children.find((item) => item.label === 'host').output.join('');
  if (!hostOutput.includes('Execution: enabled')) {
    fail(`The acceptance Host is ledger-only. Build the worker bundle first (npm run build:cli-dev).\n${hostOutput}`);
  }
  const hostOrigin = /Duya Host listening at (http:\/\/[^\s]+)/.exec(hostOutput)?.[1];
  if (!hostOrigin) fail('Could not read the Host origin from its output.');

  // 2. The BFF, pointed at that Host — exactly how the Web client is started.
  const { createWebBff } = await import(
    pathToFileURL(path.join(repoRoot, 'apps/web/dist/server/web-bff.js')).href
  );
  const runtime = JSON.parse(
    await (await import('node:fs/promises')).readFile(path.join(dataRoot, 'runtime', 'host-api.json'), 'utf8'),
  );
  const bff = await createWebBff({ hostOrigin, hostToken: runtime.token });
  bffOrigin = bff.origin;

  const bootstrap = await (await fetch(`${bffOrigin}/api/bootstrap`)).json();
  const csrf = bootstrap.csrfToken;
  const mutationHeaders = { origin: bffOrigin, 'content-type': 'application/json', 'x-duya-csrf': csrf };

  // 3. Register a workspace through the BROWSER's route. The browser names a
  //    directory; the Host resolves it into a binding.
  const registerResponse = await fetch(`${bffOrigin}/api/workspaces/local-directories`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({ directory: workspace }),
  });
  if (registerResponse.status !== 201) {
    fail(`Workspace registration failed: ${registerResponse.status} ${await registerResponse.text()}`);
  }
  const { workspace: binding } = await registerResponse.json();
  if (binding.state !== 'bound') fail(`The workspace is not bound: ${JSON.stringify(binding)}`);

  // The Host's own log is the fastest way to see WHY a run did not produce
  // events, so it is captured from the start rather than dumped at the end.
  const hostLog = () => children.find((item) => item.label === 'host').output.join('');

  // 4. Create a session that carries the binding.
  const sessionResponse = await fetch(`${bffOrigin}/api/sessions`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({
      workspaceId: binding.workspaceId,
      workspaceRootId: binding.rootId,
      workspaceRelativePath: binding.relativePath,
      title: 'web acceptance',
    }),
  });
  if (sessionResponse.status !== 201) {
    fail(`Session creation failed: ${sessionResponse.status} ${await sessionResponse.text()}`);
  }
  const { session } = await sessionResponse.json();

  // 5. Start a run through the browser's route, naming the turn's
  //    configuration the way the shared renderer does.
  const startResponse = await fetch(`${bffOrigin}/api/runs/start`, {
    method: 'POST',
    headers: mutationHeaders,
    body: JSON.stringify({
      sessionId: session.id,
      prompt: `Reply with exactly the word ${EXPECTED_ANSWER} and nothing else.`,
      effort: 'low',
      permissionMode: 'default',
    }),
  });
  if (startResponse.status !== 202) {
    fail(`Run start failed: ${startResponse.status} ${await startResponse.text()}`);
  }
  const run = await startResponse.json();
  step('run accepted');
  if (run.accepted !== true) fail(`The Host refused the run: ${JSON.stringify(run)}`);

  // 6. Read the run's events from the browser's SSE route, and wait for the
  //    terminal event. The answer's TEXT is what proves an agent ran.
  const streamResponse = await fetch(`${bffOrigin}/api/runs/${run.runId}/events?afterSeq=0`, {
    headers: { accept: 'text/event-stream' },
  });
  if (!streamResponse.ok) fail(`The event stream failed: ${streamResponse.status} ${await streamResponse.text()}`);
  const reader = streamResponse.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events = [];
  let answer = '';
  const rawFrames = [];
  const deadline = Date.now() + 120_000;
  while (Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary !== -1) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      const dataLine = block.split('\n').find((line) => line.startsWith('data: '));
      if (dataLine) {
        try {
          const envelope = JSON.parse(dataLine.slice(6));
          events.push(envelope);
          step(`event ${String(envelope.payload?.type ?? '?')}`);
          if (envelope.payload?.type === 'assistant.text_block') {
            answer += typeof envelope.payload.text === 'string'
              ? envelope.payload.text
              : (envelope.payload.content ?? '');
          }
        } catch (error) {
          rawFrames.push(`UNPARSEABLE: ${dataLine.slice(0, 200)}`);
        }
      } else {
        rawFrames.push(`NO DATA LINE: ${block.slice(0, 200)}`);
      }
      boundary = buffer.indexOf('\n\n');
    }
    if (events.some((event) => event.payload?.type === 'run.completed' || event.payload?.type === 'run.failed')) break;
  }
  await reader.cancel().catch(() => undefined);
  step('event stream closed');

  const types = events.map((event) => event.payload?.type);
  if (types.length === 0) {
    // An empty body has three possible causes that look identical from the
    // outside: the BFF dropped the frames, the HOST has no events for this
    // run, or the run never produced a durable event at all. The Host's own
    // ledger and log separate them.
    const ledger = await fetch(`${bffOrigin}/api/sessions/${session.id}/runs?limit=10`, {
      headers: { origin: bffOrigin },
    }).then((response) => response.text()).catch((error) => `unreachable: ${String(error)}`);
    const hostEvents = await fetch(
      `${hostOrigin}/v1/agent-runs/${encodeURIComponent(run.runId)}/events?afterSeq=0&limit=50`,
      { headers: { authorization: `Bearer ${runtime.token}` } },
    ).then((response) => response.text()).catch((error) => `unreachable: ${String(error)}`);
    fail([
      'The event stream produced no envelopes.',
      `raw frames:\n${rawFrames.join('\n') || '(the body was empty)'}`,
      `host ledger:\n${hostEvents.slice(0, 3_000)}`,
      `bff ledger:\n${ledger.slice(0, 2_000)}`,
      `host log:\n${hostLog().slice(-6_000)}`,
    ].join('\n'));
  }
  if (!types.includes('run.started')) fail(`The run never started. Events: ${types.join(', ')}`);
  if (!types.includes('turn.started')) fail(`The turn never started. Events: ${types.join(', ')}`);

  const terminal = events.find((event) => event.payload?.type === 'run.completed' || event.payload?.type === 'run.failed');
  if (!terminal) fail(`The run never reached a terminal event. Events: ${types.join(', ')}`);
  if (terminal.payload.type === 'run.failed') {
    fail(`The run failed: ${JSON.stringify(terminal.payload)}`);
  }
  if (!answer.includes(EXPECTED_ANSWER)) {
    fail(`The streamed answer does not carry the expected word.\nexpected ${JSON.stringify(EXPECTED_ANSWER)}\ngot: ${JSON.stringify(answer.slice(0, 400))}`);
  }

  // 7. The durable ledger must agree with the stream: the terminal state
  //    comes from the ledger, never from a quiet socket.
  const runs = await (await fetch(`${bffOrigin}/api/sessions/${session.id}/runs?limit=50`, {
    headers: { origin: bffOrigin },
  })).json();
  const recorded = runs.runs?.find((candidate) => candidate.runId === run.runId);
  if (!recorded) fail('The run is not in the durable ledger.');
  if (recorded.status !== 'completed') fail(`The ledger says the run is ${recorded.status}, not completed.`);

  // 8. The message history must carry the answer — and this is an ASSERTION,
  //    not a print. The page is `{ sessionId, messages, nextCursor }`, and a
  //    row is a durable timeline entry whose `message` holds the role and the
  //    content. Reading the wrong key once reported an empty transcript for a
  //    run that had answered, which is exactly the kind of silent hole an
  //    acceptance exists to close.
  const page = await (await fetch(`${bffOrigin}/api/sessions/${session.id}/messages?limit=100`, {
    headers: { origin: bffOrigin },
  })).json();
  const assistantText = (page.messages ?? [])
    .filter((item) => item.entry?.type === 'message' && item.entry.message?.role === 'assistant')
    .map((item) => {
      const content = item.entry.message.content;
      return typeof content === 'string' ? content : JSON.stringify(content);
    })
    .join('\n');
  if (!assistantText.includes(EXPECTED_ANSWER)) {
    fail(`The durable history does not carry the answer.\nexpected to find ${JSON.stringify(EXPECTED_ANSWER)}\ngot: ${JSON.stringify(assistantText.slice(0, 400))}`);
  }

  process.stdout.write(`\n=== WEB AGENT LOOP ACCEPTANCE ===\n`);
  process.stdout.write(`host origin      : ${hostOrigin}\n`);
  process.stdout.write(`bff origin       : ${bffOrigin}\n`);
  process.stdout.write(`workspace binding: ${binding.workspaceId}\n`);
  process.stdout.write(`session          : ${session.id}\n`);
  process.stdout.write(`run              : ${run.runId} (${recorded.status})\n`);
  process.stdout.write(`events           : ${types.join(' -> ')}\n`);
  process.stdout.write(`streamed answer  : ${JSON.stringify(answer.slice(0, 120))}\n`);
  process.stdout.write(`history answer   : ${JSON.stringify(assistantText.slice(0, 120))}\n`);
  process.stdout.write(`=== PASS ===\n`);
} finally {
  step('cleaning up');
  for (const { child } of children) {
    killTree(child);
  }
  // The Host may still be releasing its SQLite handles, so the temporary root
  // is removed on a short retry. A leftover directory in the OS temp folder is
  // not worth failing an acceptance over.
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      await rm(dataRoot, { recursive: true, force: true });
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  // A killed tree can still hold the pipes open for a moment. Exiting
  // explicitly keeps "the acceptance printed its verdict" separate from "the
  // process was still standing there holding a handle".
  await new Promise((resolve) => setTimeout(resolve, 250));
  process.exit(process.exitCode ?? 0);
}
