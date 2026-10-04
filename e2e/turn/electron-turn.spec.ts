/**
 * turn/electron-turn.spec.ts — plan 587 E4.4, bullet 1: the REAL Electron
 * boundary, proven against a real run rather than a mock of one.
 *
 * The plan's words: an Electron renderer and its real preload, an isolated
 * namespace, a turn issued through the UI or the real HTTP entry, and a
 * `runs` row / event ledger / terminal that agree with what the UI shows.
 *
 * ## What is real here, and what is not
 *
 * Real, and the reason this file exists:
 *   - the Electron main process (`dist-electron/main.js`) under `DUYA_TEST=1`;
 *   - `preload.ts` → `contextBridge` → `ipcMain`, exercised by creating the
 *     session row with the same `thread.create` call the renderer makes;
 *   - the Agent Server child process and its real `POST /sessions/:id/chat`
 *     entry — the renderer's own `AgentServerClient` posts to this exact URL,
 *     so this spec drives the same request the product's chat drives;
 *   - the agent worker subprocess, spawned and `init`ialised with the
 *     provider config this spec handed it;
 *   - the run layer, which froze a manifest and wrote the durable `runs` row.
 *
 * Not real, and named rather than hidden: the MODEL. `startLoopbackAnthropic`
 * is a real HTTP server speaking the real Anthropic SSE wire protocol on
 * 127.0.0.1, which decides BYTES FOR ONE HTTP REQUEST and nothing else. It
 * cannot create a run, settle a run, or emit a protocol event, and it names no
 * tools. The executor, not the fixture, is what makes a turn happen. `baseURL`
 * points at it, so no packet leaves the machine and no provider credential is
 * needed. See `loopback-anthropic.ts` for why it is not E4.1's fixture.
 *
 * ## The split in this file, and why
 *
 * E4.4 asks for one thing: the durable receipt and the UI agreeing. As of
 * `origin/master` 5dc45fcf that is **false in the real Electron path**, and the
 * reason is a product defect, not a missing test. So this file is two tests:
 *
 *  1. `the real boundary opens a durable run bound to this turn` — PASSES.
 *     Everything the boundary really does today, asserted against the
 *     namespace's own SQLite.
 *  2. `E4.4 contract: events, terminal, UI agreement` — `test.fixme`, i.e.
 *     neither passed nor failed. The contract cannot be asserted because the
 *     turn is never dispatched. `test.fixme` rather than a skipped test,
 *     because a skip reads as "no information" and this is a specific,
 *     reproducible failure with a named cause.
 *
 * The cause, verbatim from the namespace's own `app.log` at dispatch time:
 *
 *   [WARN] [agent-server] chat turn dispatched without a durable run
 *     {"stage":"run_not_created","reason":"run:create replied without a boolean ok"}
 *
 * The run row IS written — with a real manifest and input hash — so the Control
 * Plane created it and then failed to acknowledge it in the shape the router
 * reads. `openRun` therefore reports `accepted: false`, and `router.ts:1309`
 * treats that as "nothing was dispatched". The worker is spawned and `init`ed
 * but never receives `chat:start`, so no `chat:*` frame is ever emitted: no
 * text, no terminal, an empty event ledger, and a `runs` row stranded at
 * `status='running'` with `terminal=NULL` forever.
 *
 * The ack shape is C6.1 / F01 in `13-progress-review-2026-10-04.md` ("修 bridge
 * wire/read/write 和未接受 start 的响应"). It is fixed there, not here: this
 * slice is the instrument, and rewriting the run entry is not its job.
 */
import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { launchDuya, closeDuya, invokeApi, userDataRootFor, type DuyaApp } from '../helpers';
import { startLoopbackAnthropic, type LoopbackAnthropic } from './loopback-anthropic';

const NAMESPACE = 'e4-4-electron-turn';
/** Split into two deltas by the fixture, so the renderer's own accumulation is
 *  exercised rather than a single whole-string frame. */
const EXPECTED_TEXT = 'E4.4 real electron turn reached a durable terminal.';
const MODEL = 'claude-offline-e2e';
/** A loopback token, NOT a credential. It exists so the fixture can assert that
 *  the real Anthropic client sent the key we gave it, which is how we know the
 *  `baseURL` was honoured instead of some configured provider being used. */
const LOOPBACK_API_KEY = 'e2e-loopback-not-a-credential';

interface RunRow {
  id: string;
  session_id: string;
  manifest_hash: string;
  manifest_json: string;
  status: string;
  terminal: string | null;
  input_hash: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
}

interface RunEventRow {
  run_id: string;
  seq: number;
  event_type: string;
  envelope_json: string;
}

/** What the renderer saw: the SSE frames off the real chat stream, in order. */
interface RendererTurn {
  httpStatus: number;
  frameTypes: string[];
  text: string;
  done: Record<string, unknown> | null;
  error: Record<string, unknown> | null;
  /** True when the stream stayed open past the read budget without a terminal. */
  streamStalled: boolean;
}

let dua: DuyaApp | undefined;
let provider: LoopbackAnthropic | undefined;

/** What one real turn through the boundary produced. */
interface RealTurn {
  sessionId: string;
  workspace: string;
  turn: RendererTurn;
}

/** Progress markers. A spec that can only report "timed out" is a spec that
 *  cannot say which of five boundaries stopped answering. */
function stage(label: string): void {
  console.log(`[e2e-turn] ${label}`);
}

/**
 * Launch the app, create a session through the real IPC handler, and send one
 * turn from the renderer over the real HTTP entry.
 *
 * Shared by both tests because the contract test must drive a real turn too —
 * a `fixme` body that cannot run is not a contract, it is a comment.
 */
async function runRealTurn(opts: { stopAfter?: string; readBudgetMs: number }): Promise<RealTurn> {
  provider = await startLoopbackAnthropic({
    text: EXPECTED_TEXT,
    model: MODEL,
    inputTokens: 11,
    outputTokens: 7,
  });

  // A workspace of its own, inside the namespace, so a turn that did try to
  // touch a file would touch this spec's directory and nothing else.
  const workspace = path.join(userDataRootFor(NAMESPACE), `workspace-${Date.now()}`);
  fs.mkdirSync(workspace, { recursive: true });

  const sessionId = `e4-4-turn-${Date.now()}`;
  stage('launching electron');
  dua = await launchDuya({ namespace: NAMESPACE });
  stage('electron launched, preload exposed');

  // ── The preload / ipcMain boundary, used the way the renderer uses it ──
  const agentUrl = await waitForAgentServerUrl(dua.page);
  expect(agentUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  stage(`agent server url ${agentUrl}`);

  // The chat route 404s a session with no row, so this call is load-bearing:
  // it proves `db:session:create` reached ipcMain and the core store.
  const created = await invokeApi<{ id: string }>(dua.page, 'thread.create', {
    id: sessionId,
    title: 'E4.4 real turn',
    working_directory: workspace,
  });
  expect(created.id).toBe(sessionId);
  stage(`session created ${sessionId}`);

  // ── The turn, issued BY THE RENDERER over the real HTTP entry ──
  const turn = await postChatFromRenderer(dua.page, {
    baseUrl: agentUrl,
    sessionId,
    workspace,
    providerBaseUrl: provider.baseUrl,
    readBudgetMs: opts.readBudgetMs,
    stopAfter: opts.stopAfter,
  });
  stage(`chat stream: status=${turn.httpStatus} frames=${turn.frameTypes.join(',') || '<none>'}`);
  return { sessionId, workspace, turn };
}

/**
 * The namespace's core database, at the path `launchDuya` configured.
 *
 * `userDataRootFor` is the same helper the launcher uses, so this cannot drift
 * from the directory the app actually booted into. Read back with an INDEPENDENT
 * connection while the app is still running: a row this process can see is a
 * row that was committed, not one the running app is holding in memory and
 * reporting through IPC.
 */
function openCoreDb(): Database.Database {
  const dbPath = path.join(userDataRootFor(NAMESPACE), 'databases', 'duya-core.db');
  if (!fs.existsSync(dbPath)) {
    const dir = path.dirname(dbPath);
    const listing = fs.existsSync(dir) ? fs.readdirSync(dir) : ['<no databases dir>'];
    throw new Error(
      `core database not found at ${dbPath}; ${dir} holds: ${listing.join(', ')}. ` +
        'If boot.json moved, fix the path here rather than re-deriving it.',
    );
  }
  return new Database(dbPath);
}

/** The one run this spec's session produced, or a failure that names the gap. */
function readRun(db: Database.Database, sessionId: string): RunRow {
  const runs = db.prepare('SELECT * FROM runs WHERE session_id = ?').all(sessionId) as RunRow[];
  expect(runs, `no runs row for session ${sessionId}`).toHaveLength(1);
  return runs[0];
}

test.describe('E4.4 — a real Electron turn', () => {
  // Electron boot, worker spawn and one turn. The suite default of 90s is the
  // budget for a spec that only pokes at IPC; this one runs a model loop.
  test.setTimeout(240_000);

  test.afterEach(async () => {
    await provider?.close();
    provider = undefined;
    if (dua) {
      await closeDuya(dua.app);
      dua = undefined;
    }
  });

  test('the real boundary opens a durable run bound to this turn', async () => {
    // Stopped at `ready`: the worker's own readiness frame is the last thing
    // this assertion needs, and waiting for a terminal that the current
    // defect never produces would only burn the budget.
    const { turn, sessionId, workspace } = await runRealTurn({
      stopAfter: 'ready',
      readBudgetMs: 60_000,
    });

    // The route accepted the turn and the real worker came up. `ready` is
    // emitted by the worker's own init handshake over its stdout, so it is
    // evidence the whole chain ran, not a router acknowledgement.
    expect(turn.httpStatus).toBe(200);
    expect(turn.frameTypes).toContain('ready');

    // ── The durable run row, read independently from the namespace's SQLite ──
    stage('reading the namespace core db');
    const db = openCoreDb();
    try {
      const run = readRun(db, sessionId);

      // The row is a real frozen configuration, not a stub: a manifest hash
      // over a manifest that parses, and an input digest.
      expect(run.manifest_hash).not.toBe('');
      expect(run.input_hash).not.toBeNull();
      const manifest = JSON.parse(run.manifest_json) as {
        version: number;
        runId: string;
        cwd: string;
        roots: string[];
        requiredCapabilities?: string[];
        agent?: { model?: unknown };
      };
      expect(manifest.runId).toBe(run.id);
      expect(manifest.cwd).toBe(workspace);
      expect(manifest.roots).toContain(workspace);
      // Binding the model is what distinguishes "the manifest of the turn that
      // just ran" from "some default manifest that was always there".
      expect(manifest.agent?.model).toBe(MODEL);
      // A chat turn declares itself a streaming turn, and the row says so.
      expect(manifest.requiredCapabilities).toContain('streaming');

      // What this test does NOT claim, stated where a reader will see it: the
      // run is not terminal, and its ledger is empty, because the turn was
      // never dispatched. The second test below is the E4.4 contract, and it
      // is `fixme` for exactly that reason.
      stage(`run ${run.id} status=${run.status} terminal=${String(run.terminal)}`);
    } finally {
      db.close();
    }
  });

  /**
   * E4.4's actual claim: the ledger is persisted in order, the run reaches a
   * terminal, and the terminal agrees with what the renderer was shown.
   *
   * `fixme`, because on `origin/master` 5dc45fcf the real Electron chat path
   * does not get that far. The run row is created, then `run:create`'s
   * acknowledgement is not the boolean the router reads, so `openRun` returns
   * `accepted: false` and `router.ts:1309` dispatches nothing: the worker never
   * receives `chat:start`, the stream produces only `ready`, `run_events` stays
   * empty, and the row keeps `status='running'` with `terminal=NULL`.
   *
   * The assertions below are the contract, written out so that fixing the
   * bridge is a matter of deleting `fixme` and running them. They are not
   * written to pass against today's behaviour, and no assertion anywhere in
   * this file pins the broken state as expected.
   */
  test.fixme('E4.4 contract: events, terminal and UI agreement', async () => {
    const { turn, sessionId } = await runRealTurn({ readBudgetMs: 120_000 });
    const db = openCoreDb();
    try {
      // A turn that produced nothing is the defect, stated as an assertion
      // rather than inferred from a timeout.
      expect(turn.streamStalled, `frames: ${turn.frameTypes.join(',') || '<none>'}`).toBe(false);
      expect(turn.error).toBeNull();
      expect(turn.text).toBe(EXPECTED_TEXT);
      expect(turn.frameTypes[turn.frameTypes.length - 1]).toBe('done');
      // The model boundary was really crossed, not simulated around.
      expect(provider?.requests.length ?? 0).toBeGreaterThanOrEqual(1);
      expect(provider?.authHeadersSeen ?? []).toContain(LOOPBACK_API_KEY);

      const run = readRun(db, sessionId);

      // A terminal, not a stuck row. `completeRun` writes status and terminal
      // together under `WHERE status = 'running'`, so they cannot disagree.
      expect(run.status).toBe('completed');
      expect(run.terminal).toBe('completed');
      expect(run.finished_at).not.toBeNull();
      expect(run.finished_at!).toBeGreaterThanOrEqual(run.started_at!);

      // The event ledger: non-empty, monotonic, and terminal-last.
      const events = db
        .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq')
        .all(run.id) as RunEventRow[];
      expect(events.length).toBeGreaterThan(0);
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(events[0].event_type).toBe('run.started');
      const last = events[events.length - 1];
      expect(last.event_type).toBe('run.completed');

      // The durable terminal event and the row agree. A run whose row says
      // `completed` while its own last event says `failed` is exactly the
      // disagreement this slice exists to catch.
      const terminalPayload = (JSON.parse(last.envelope_json) as {
        payload: { type: string; status?: string };
      }).payload;
      expect(terminalPayload.type).toBe('run.completed');
      expect(terminalPayload.status).toBe(run.terminal);

      // `run.started` carries the manifest hash the row recorded, so the two
      // columns are cross-checked rather than merely both present.
      const startedPayload = (JSON.parse(events[0].envelope_json) as {
        payload: { manifestHash?: string };
      }).payload;
      expect(startedPayload.manifestHash).toBe(run.manifest_hash);

      // And the text the UI shows is the durable text. `assistant.message_finalized`
      // is the protocol's DURABLE authoritative message, so this compares the
      // renderer's stream against the ledger in one database. A turn whose
      // stream and ledger disagree is a run nobody can replay.
      const finalized = events.filter((e) => e.event_type === 'assistant.message_finalized');
      expect(finalized.length).toBeGreaterThan(0);
      const durableText = finalized
        .flatMap((e) => {
          const payload = (JSON.parse(e.envelope_json) as {
            payload: { content?: Array<{ type: string; text?: string }> };
          }).payload;
          return (payload.content ?? [])
            .filter((block) => block.type === 'text')
            .map((block) => block.text ?? '');
        })
        .join('');
      expect(durableText).toBe(EXPECTED_TEXT);
      expect(turn.text).toBe(durableText);
    } finally {
      db.close();
    }
  });
});

/** Poll the Agent Server URL the preload exposes, as the renderer's client does. */
async function waitForAgentServerUrl(page: import('@playwright/test').Page): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = await invokeApi<string | null>(page, 'agentServer.getUrl');
    if (url) return url;
    await page.waitForTimeout(500);
  }
  throw new Error('agentServer.getUrl never returned a URL within 30s');
}

/**
 * POST the chat turn FROM THE RENDERER and read the SSE stream.
 *
 * This is the renderer's real request: the same method, URL, headers and body
 * shape `apps/desktop/src/renderer/lib/agent-http-client.ts` uses, issued from
 * the page so the request originates in the real renderer and crosses the real
 * loopback socket into the real Agent Server.
 *
 * `stopAfter` ends the read at the first frame of that type, so a spec that
 * only needs the handshake does not wait for a terminal. Without it the read is
 * bounded by `readBudgetMs` and reports `streamStalled`, because a stream that
 * opens and then says nothing is a result, not a hang.
 */
async function postChatFromRenderer(
  page: import('@playwright/test').Page,
  args: {
    baseUrl: string;
    sessionId: string;
    workspace: string;
    providerBaseUrl: string;
    readBudgetMs: number;
    stopAfter?: string;
  },
): Promise<RendererTurn> {
  return page.evaluate(async (a) => {
    const response = await fetch(`${a.baseUrl}/sessions/${encodeURIComponent(a.sessionId)}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
      body: JSON.stringify({
        prompt: a.prompt,
        providerConfig: {
          apiKey: a.apiKey,
          baseURL: a.providerBaseUrl,
          model: a.model,
          provider: 'anthropic',
          authStyle: 'api_key',
        },
        workingDirectory: a.workspace,
        defaultWorkspaceDirectory: a.workspace,
        options: { runOrigin: 'user' },
      }),
    });

    const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
    const reader = response.body?.getReader();
    const deadline = Date.now() + a.readBudgetMs;
    let streamStalled = false;
    if (reader) {
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        if (Date.now() > deadline) {
          streamStalled = true;
          void reader.cancel().catch(() => {});
          break;
        }
        const next = await Promise.race([
          reader.read(),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]);
        if (next === null) continue; // no chunk in this window; re-check the budget
        const { done, value } = next;
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(6)) as { type?: string; data?: Record<string, unknown> };
            if (typeof parsed.type === 'string') frames.push({ type: parsed.type, data: parsed.data ?? {} });
          } catch {
            // A partial frame: the next read completes it.
          }
        }
        if (a.stopAfter && frames.some((f) => f.type === a.stopAfter)) {
          void reader.cancel().catch(() => {});
          break;
        }
      }
    }

    const text = frames
      .filter((f) => f.type === 'text')
      .map((f) => (typeof f.data.content === 'string' ? f.data.content : ''))
      .join('');
    const doneFrame = frames.find((f) => f.type === 'done')?.data ?? null;
    const errorFrame = frames.find((f) => f.type === 'error')?.data ?? null;

    return {
      httpStatus: response.status,
      frameTypes: frames.map((f) => f.type),
      text,
      done: doneFrame,
      error: errorFrame,
      streamStalled,
    };
  }, {
    baseUrl: args.baseUrl,
    sessionId: args.sessionId,
    workspace: args.workspace,
    providerBaseUrl: args.providerBaseUrl,
    readBudgetMs: args.readBudgetMs,
    stopAfter: args.stopAfter,
    // Serialised rather than closed over: `page.evaluate` runs in the page, so
    // a literal copy of the model or the key here would be a second definition
    // that nothing keeps in step with the constants above.
    model: MODEL,
    apiKey: LOOPBACK_API_KEY,
    prompt: 'Reply with exactly the sentence you were configured to emit, and call no tools.',
  });
}
