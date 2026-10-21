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
 * E4.4 asks for one thing: the durable receipt and the UI agreeing. Two tests
 * cover it, and they do NOT currently agree:
 *
 *  1. `the real boundary opens a durable run bound to this turn` — PASSES.
 *     The run a turn OPENS is real: a manifest that parses and hashes, an
 *     input digest, and the turn's own model and workspace bound into it.
 *  2. `E4.4 contract: events, terminal and UI agreement` — RUNS, and FAILS.
 *     `fixme` is gone, so it is a real red test rather than a comment. The two
 *     assertions it fails on, and the evidence for each, are in "The state of
 *     the contract test" below. It is left red deliberately.
 *
 * ## Why test 2 was once `test.fixme`
 *
 * The contract was FALSE in the real Electron path, and the cause was a
 * product defect, not a missing test. The run row was written, then
 * `run:create`'s REPLY was not readable: `ControlPlaneService.serve` re-parsed
 * the Control Plane's wire shape into a typed `RunWriteReceipt` carrying
 * neither the `ok` boolean nor `run:append`'s `written` count, so
 * `readRunReceipt` saw `unreadable`, `openRun` reported `accepted: false`, and
 * the router treated that as "nothing was dispatched". The worker was spawned
 * and `init`ed but never received `chat:start`, so no `chat:*` frame was ever
 * emitted: no text, no terminal, an empty event ledger, and a `runs` row
 * stranded at `status='running'` with `terminal=NULL`. Verbatim from the
 * namespace's own `app.log` at dispatch time:
 *
 *   [WARN] [agent-server] chat turn dispatched without a durable run
 *     {"stage":"run_not_created","reason":"run:create replied without a boolean ok"}
 *
 * PR #182 fixed it by forwarding the producer's own reply instead of a
 * re-parsed form, and fixed the same drift on `run:append`. Its regression
 * test drives the real `db:request` bridge
 * (`apps/desktop/src/main/__tests__/run-create-ack-real-bridge.test.ts`); this
 * file is the same claim from the OUTSIDE, through the real preload and a real
 * forked worker subprocess. So `fixme` is gone: the contract is asserted, not
 * described.
 *
 * ## The state of the contract test: one assertion fixed, one adjudicated
 *
 * Deleting `fixme` made it run, and it failed on TWO assertions. Both stated a
 * shape of the stream or the ledger that the real product does not have, and
 * neither was a symptom of the defect #182 fixed. They have since been
 * adjudicated SEPARATELY, because they are not the same kind of wrong:
 *
 *  1. `expect(turn.frameTypes[turn.frameTypes.length - 1]).toBe('done')` —
 *     received `title_generated`. The real terminal sequence is
 *     `ready, appConnection:listDescriptors, status, token_usage, status,
 *     text, text, token_usage, token_usage, db_persisted, done,
 *     title_generated`. **This assertion was wrong and has been corrected.**
 *     `title_generated` is a legitimate post-terminal HOST frame: title
 *     generation is a separate async LLM call the worker does not await before
 *     `chat:done`, and the product deliberately keeps reading past the terminal
 *     to collect it (`router.ts:1708-1715`), force-closing the stream after a
 *     configurable window if it never arrives (`router.ts:1716-1726`). The
 *     protocol spec agrees it is not a run event at all — host-only
 *     (`07-agent-protocol-spec.md:278`, `:313`) — and the translator leaves it
 *     unmapped and forward-only. The runtime is NOT emitting out of contract;
 *     the test was. It is now repointed at the invariant that actually holds
 *     (terminal present; only the title frame may follow it) rather than at the
 *     literal last element, which would be flaky on the timeout path.
 *
 *  2. The `assistant.message_finalized` lookup — the ledger holds 0 such rows.
 *     **This assertion is RIGHT and the product is short, so it is left red.**
 *     A real completed turn persists `assistant.text_block` instead
 *     (`1:run.started 3:assistant.usage 5:assistant.text_block
 *     6:assistant.text_block 7:assistant.usage 8:assistant.usage
 *     9:run.completed`), and the event it wants has no producer on ANY path —
 *     desktop, headless, CLI and subagent all funnel through the one
 *     `translateFrame` seam, which has no arm for it.
 *
 *     It is tempting to conclude the declaration is stale and repoint this at
 *     `assistant.text_block`. That would be wrong, and the registry is the
 *     evidence. The event carries a written rationale for its own existence
 *     (`legacy/sse-event.ts:185-186` — the legacy surface "never marked the
 *     point where the message stopped changing, which is why compaction had to
 *     guess a boundary"), the spec derives its payload from `AssistantMessage`
 *     (`07-agent-protocol-spec.md:244`), contract §F requires reconnect
 *     recovery from a "message snapshot" rather than from discarded deltas, and
 *     the consumer already treats it as authoritative and superseding
 *     (`transcript-snapshot.ts:28-31`). None of that is the shape of a leftover.
 *
 *     Nor is it a one-line translator fix. `content` and `stopReason` are both
 *     REQUIRED, and the only terminal frame the worker sends is `chat:done` =
 *     `{ sessionId }` (`worker-protocol.ts:326-329`), which carries neither;
 *     `translateFrame` is a pure per-frame function, so producing the event
 *     today would mean inventing the two facts it exists to record. Closing
 *     this is a wire extension — the agent has to carry the finalized message —
 *     which is a larger slice than an assertion change and is not this file's
 *     to land. The gap is recorded as a first-class row in the control-plane
 *     census (`control-plane-census.ts`, `assistant.message_finalized`,
 *     `producer: NOT YET WIRED`) with a gate that makes the whole class
 *     undroppable.
 *
 *     An earlier draft of this header proposed repointing the lookup to
 *     `assistant.text_block`. That advice is withdrawn: it would have frozen a
 *     contract violation into a green test, which is the exact outcome this
 *     file exists to prevent.
 *
 * Why the previous author could not have known: while `openRun` refused, the
 * stream stopped at `ready`. No text, no terminal, no ledger — so the frame
 * order and the event names were never observable, and both assertions were
 * guesses. The contract was written to fail, correctly; one of them also
 * guessed wrong about the far end, which only a real turn could reveal.
 *
 * What IS proven, read back from the same namespace SQLite after that run:
 *   - `status=completed`, `terminal=completed`, `finished_at >= started_at`;
 *   - a 7-row `run_events` ledger with strictly increasing, unique `seq`;
 *   - `run.started` first, carrying the manifest hash the row recorded;
 *   - `run.completed` last, its payload `status` equal to the row's terminal.
 *
 * The #182 defect class is therefore genuinely gone through the real boundary:
 * the worker receives `chat:start`, the turn reaches a terminal, and the
 * durable terminal event agrees with the row. What remains red is the durable
 * AUTHORITATIVE MESSAGE the contract names, and it is red because the product
 * does not emit it — not because the contract misdescribes it.
 *
 * ## What this file still does NOT prove
 *
 * Named here rather than left for a reader to assume:
 *   - No live provider. The model is the loopback fixture, which decides the
 *     bytes for one HTTP request. How a real model decides a turn, and what it
 *     would choose to call, is out of scope for this file.
 *   - No packaged app. The main process is `dist-electron/main.js` from
 *     `npm run electron:build`, not an installed binary. E4.4's packaged gate
 *     (E4.4-B) is a separate bullet and remains unmet.
 *   - `chat:start` dispatched exactly once is NOT asserted here. This file
 *     observes that a terminal exists, which a duplicate dispatch could also
 *     produce. The exactly-once claim belongs to the bridge-level test named
 *     above, which asserts the dispatch count directly.
 *   - One text-only turn: no tool call, no thinking block, no injected error.
 *     The behaviour matrix is E4.2's subject, not this file's.
 *   - The renderer-side agreement is asserted against the SSE frames this spec
 *     reads in the page, not against pixels. A turn whose MESSAGE LIST disagreed
 *     with those frames would not be caught here.
 *
 * ## A namespace hazard worth knowing before a run goes red
 *
 * `NAMESPACE` keys two DIFFERENT roots, and only one of them is per-worktree.
 * `--user-data-dir` (set by `launchDuya`) is the namespace's Electron userData,
 * so `databases/duya-core.db` lands inside THIS repo. But the config that
 * decides that path is `~/.duya/test-namespaces/<ns>/config.toml`
 * (`compass.resolveConfigRoot`), which is keyed on the namespace NAME ALONE and
 * is therefore shared by every worktree that picks the same name. At boot the
 * app writes its own absolute `storage.database_path` there, so the LAST
 * worktree to run this spec wins and an earlier or parallel one opens its
 * database somewhere else entirely — leaving `<ns>/databases` absent here, and
 * failing `openCoreDb` with a path error that reads like a product bug.
 *
 * The failure text below is written so that case is recognisable. Recovery is
 * to clear `storage.database_path` in that config.toml (an empty value falls
 * back to the per-namespace default); the alternative, a unique NAMESPACE per
 * worktree, trades the collision for a namespace no human remembers.
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
 * Shared by both tests because the contract test must drive a real turn too:
 * `openCoreDb` can only be trusted if a real turn wrote the rows it reads.
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
        'The default lands in the namespace userData, so a MISSING databases ' +
        'directory usually means a stale storage.database_path in ' +
        '~/.duya/test-namespaces/<ns>/config.toml pointed this namespace at ' +
        'another worktree. Clear it and re-run before suspecting the product.',
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
    // Stopped at `ready`: this test is about the run being OPENED, and the
    // worker's own readiness frame is the last thing that claim needs.
    // Driving the turn all the way to a terminal is the contract test's job.
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

      // What this test does NOT claim, stated where a reader will see it: this
      // turn's stream is cancelled at `ready`, so its run settles `failed`
      // rather than completing. This test proves the run OPENED and is bound to
      // this turn; the terminal, the ordered ledger and the agreement with the
      // UI are asserted by the contract test below.
      stage(`run ${run.id} status=${run.status} terminal=${String(run.terminal)}`);
    } finally {
      db.close();
    }
  });

  /**
   * E4.4's actual claim: the ledger is persisted in order, the run reaches a
   * terminal, and the terminal agrees with what the renderer was shown.
   *
   * This was `test.fixme` while the `run:create` reply was unreadable, so
   * `openRun` refused, nothing was dispatched, and none of this could hold.
   * PR #182 fixed that, so these assertions now run for real. Two of them were
   * red, and they were adjudicated differently: the frame-ordering one was a
   * wrong expectation and has been corrected to the invariant that actually
   * holds, while the `assistant.message_finalized` one is a correct expectation
   * the product does not yet satisfy. The file header carries the evidence and
   * the reasoning for each.
   *
   * It therefore stays RED on purpose, on ONE assertion. Do not re-`fixme` it,
   * and do not narrow the assertions down to whatever happens to pass: a
   * contract trimmed to the green is a rubber stamp. In particular, do NOT
   * repoint the finalized lookup at `assistant.text_block` — that would turn a
   * contract violation into a passing test, which is the one outcome this file
   * exists to make impossible. The remaining red is a real product gap, and it
   * is tracked as a `NOT YET WIRED` row in the control-plane census rather than
   * being deleted from here.
   */
  test('E4.4 contract: events, terminal and UI agreement', async () => {
    const { turn, sessionId } = await runRealTurn({ readBudgetMs: 120_000 });
    const db = openCoreDb();
    try {
      // A turn that produced nothing is the defect, stated as an assertion
      // rather than inferred from a timeout.
      expect(turn.streamStalled, `frames: ${turn.frameTypes.join(',') || '<none>'}`).toBe(false);
      expect(turn.error).toBeNull();
      expect(turn.text).toBe(EXPECTED_TEXT);
      // `done` is the TERMINAL, and it is NOT the last frame on the wire.
      // Title generation is a separate async LLM call the worker does not
      // await before `chat:done`, so the product deliberately keeps reading
      // past the terminal to collect the title (`router.ts:1708-1715`), under a
      // configurable window — default 5s — that force-closes the stream if the
      // title never arrives (`router.ts:1716-1726`). `title_generated` is
      // host-only by the protocol spec (`07-agent-protocol-spec.md:278` and
      // `:313`): it is deliberately NOT a protocol event, and the translator
      // leaves it unmapped and forward-only, which is why it reaches this test
      // at all.
      //
      // So the contract is not "the last frame is `done`" — and it is equally
      // not "the last frame is `title_generated`", because the title is
      // OPTIONAL: the timeout path ends the stream without it, so a literal
      // last-element assertion would be flaky. What is invariant is the SHAPE
      // of the tail: the terminal exists, and nothing but the host's title
      // frame follows it. That is strictly stronger than what it replaces — it
      // fails on a duplicated `done`, on an `error` arriving after the
      // terminal, and on any other frame the run layer emits past the point it
      // finished, all of which the old single-element check waved through.
      const doneAt = turn.frameTypes.lastIndexOf('done');
      expect(doneAt, `frames: ${turn.frameTypes.join(',') || '<none>'}`).toBeGreaterThanOrEqual(0);
      // `chat:done` is always forwarded with its payload (`router.ts:601-602`),
      // so a terminal frame carrying no data is a defect, not a shape.
      expect(turn.done, 'the done frame carried no payload').not.toBeNull();
      const afterTerminal = turn.frameTypes.slice(doneAt + 1);
      expect(
        afterTerminal.filter((type) => type !== 'title_generated'),
        `frames after the terminal: ${afterTerminal.join(',') || '<none>'}`,
      ).toEqual([]);
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
      //
      // THIS ASSERTION IS CURRENTLY RED, AND IT IS CORRECT TO BE. The product
      // emits no `assistant.message_finalized` on any path; a real turn writes
      // `assistant.text_block` instead. The event is not a stale declaration —
      // the registry ships a rationale for it, the spec derives it from
      // `AssistantMessage`, contract §F names it as the reconnect-recovery
      // snapshot, and the consumer already treats it as authoritative. So the
      // gap is the product's, and it is recorded as a `NOT YET WIRED` row in
      // `packages/agent-runtime/src/control-plane-census.ts` with a gate that
      // keeps the whole declared-but-unproduced class findable.
      //
      // Do not "fix" this by looking up `assistant.text_block` instead. That
      // would delete the only executable statement of the contract, replace it
      // with a description of current behaviour, and turn this file green for
      // the wrong reason.
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
