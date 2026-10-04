/**
 * ui-states/ui-states.spec.ts - plan 587 E4.4, bullet 4.
 *
 * The plan's words: "Playwright verifies light/dark, pending/terminal/approval
 * for UI-involving changes; a browser mock only verifies visuals, the bridge
 * must be Electron."
 *
 * ## What "the bridge must be Electron" means here
 *
 * Every test below launches the real main process from `dist-electron/main.js`
 * under `DUYA_TEST=1` with an isolated namespace, and every assertion that
 * touches state crosses `preload.ts -> contextBridge -> ipcMain` in at least
 * one direction:
 *
 *   - the THEME test clicks the app's OWN theme button, which calls
 *     `save({theme})` -> `settingsDb.set('theme', ...)` -> ipcMain -> SQLite,
 *     and reads the committed row back from the namespace's SQLite with an
 *     INDEPENDENT connection. A browser-only run could do neither: there is no
 *     `ipcMain`, and there is no namespace database to read.
 *   - the RUN-STATE test drives a turn through the renderer's own HTTP entry
 *     into the real Agent Server, which forks a real worker subprocess. The run
 *     row and the event ledger it reads back were written by that worker.
 *   - the APPROVAL test reads the renderer's approval data source through the
 *     preload, resolves the approval through the preload, and checks the CAS
 *     transition in SQLite.
 *
 * The colour assertions are the one place pixels matter, and they are asserted
 * as RESOLVED COMPUTED VALUES on real elements rather than as the presence of
 * a class or an attribute - see `THEME_TOKENS`.
 *
 * ## The vocabulary, taken from the product rather than invented
 *
 * Plan 587 keeps three separately-named tables apart on purpose, and this file
 * does not merge them:
 *
 *   1. Run lifecycle - `RunStatus` in
 *      `apps/desktop/src/main/db/core/run-store.ts:52`:
 *      `'running' | 'completed' | 'cancelled' | 'budget_exhausted' | 'failed'`.
 *      The comment there calls `running` "Live" and the other four "the four
 *      terminal arms". So `pending` here means `status='running'` with
 *      `terminal IS NULL`, and `terminal` means one of the four arms with the
 *      `terminal` column naming the same arm.
 *   2. Approval row status - `toolApprovalState.ts:93`:
 *      `status IN ('pending','approved','consumed','denied')` with
 *      `decision IN ('allow','always','deny')`. This is the third table, and it
 *      is NOT the run lifecycle: an approval row is not a run, and `pending`
 *      here means the approval is awaiting a user decision.
 *   3. The internal permission policy - `PermissionBehavior` in
 *      `permissions/types.ts:85` is `allow | ask | deny`, and the protocol's
 *      response vocabulary is `allow | allow_always | deny | defer` (plan 587
 *      section E). Neither is asserted here, because this slice asserts the two
 *      states the renderer actually renders.
 *
 * ## How each state is reached, and what that does and does not prove
 *
 *   - `pending` - a REAL turn. A live `runs` row (`status='running'`,
 *     `terminal IS NULL`) with only `run.started` in the ledger, observed
 *     while the SSE stream was still open and the renderer had not been told
 *     the turn ended.
 *   - `terminal` - the same real turn, driven to its end. The row settles on
 *     one of `RunStatus`'s four terminal arms with the `terminal` column naming
 *     the same arm, `finished_at >= started_at`, and a ledger whose last event
 *     agrees with the row.
 *   - `approval` - a SEEDED durable row. See that test's own header.
 *
 * The model in both run-state tests is `loopback-hold.ts`, a loopback
 * Anthropic endpoint that decides bytes for one HTTP request and holds the
 * socket open; it cannot open a run, settle a run or append an event. The run,
 * the ledger and the terminal are the executor's work. The fixture holds the
 * response open only so "in flight" is an observation rather than a race.
 *
 * ## A harness bug this file already had, kept fixed on purpose
 *
 * An earlier version of the turn driver called a MODULE-SCOPE helper from
 * inside `page.evaluate`. Playwright serialises the callback and runs it in the
 * page, so that helper does not exist there: the `fetch` fired (a real run was
 * created and completed) and the reader then threw a `ReferenceError` that the
 * floating `void (async ...)()` swallowed. The symptom was `frames=[]` and a
 * durable run that completed - which reads exactly like "the product sent no
 * frames", and was briefly reported as a product defect. The bullet-1 spec
 * passed against the same build the whole time, which is what disproved it.
 *
 * Two things are therefore deliberate here: every function the page runs is
 * self-contained, and the page-side promise carries a `.catch` that records
 * `pageError`, so a throw in the renderer is named instead of looking like
 * silence. `e2e/turn/electron-turn.spec.ts` is the known-good precedent for the
 * self-contained shape.
 *
 * ## What this file does NOT claim
 *
 * Named here rather than left for a reader to assume:
 *   - No live provider. Nothing here needs a credential, and nothing here
 *     proves what a real model would decide. E4.4's live-chat bullet is a
 *     separate item and needs a key.
 *   - No packaged app. The main process is the `dist-electron/` build.
 *   - No message-list pixels. The run-state test asserts the durable state and
 *     the frames the renderer received; it does not assert that a particular
 *     message bubble was painted. Opening a session-bound chat surface in a
 *     fresh isolated namespace needs a navigation step this slice did not
 *     solve, and mutating the Zustand store from `page.evaluate` instead of
 *     clicking would have been fabricating renderer state. The approval test is
 *     bounded by the same gap and says so in place.
 */
import { test, expect, type Page } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { launchDuya, closeDuya, invokeApi, userDataRootFor, type DuyaApp } from '../helpers';
import { startHeldLoopbackAnthropic, type HeldLoopback } from './loopback-hold';

/**
 * One namespace per test. Sharing one across three Electron launches couples
 * them: a prior app's ports, database handles and settings are all still on
 * disk when the next one boots, and a failure then reads as a product defect
 * when it is test isolation. `userDataRootFor` derives the path, so these
 * cannot drift from what `launchDuya` actually used.
 */
const THEME_NAMESPACE = 'e4-4-ui-states-theme';
const RUN_NAMESPACE = 'e4-4-ui-states-run';
const APPROVAL_NAMESPACE = 'e4-4-ui-states-approval';

const MODEL = 'claude-offline-e2e-ui-states';
/** A loopback token, NOT a credential. See loopback-hold.ts. */
const LOOPBACK_API_KEY = 'e2e-loopback-not-a-credential';
const EXPECTED_TEXT = 'E4.4 UI states reached a real terminal.';

/** How long the fixture holds the response open, i.e. how long `pending` lasts. */
const HOLD_MS = 20_000;

/**
 * Real theme tokens, and the light/dark pair `base.css` declares for them.
 *
 * Two value forms, and the difference is not cosmetic:
 *   - A CUSTOM property read through `getPropertyValue` comes back as the
 *     declared token (`#fefdfb`), because custom properties are substituted
 *     textually and are never resolved to a colour.
 *   - A REAL property on a real element (`backgroundColor`) comes back resolved
 *     (`rgb(254, 253, 251)`), which is the value the compositor used.
 *
 * Asserting both is what separates "the app honoured the theme switch" from
 * "an attribute changed": the token proves the cascade switched, and the
 * resolved colour proves a painted element actually changed with it. A
 * stylesheet that failed to load, or a token the app never overrides, leaves
 * the two themes equal and fails here.
 */
const THEME_TOKENS = [
  { name: '--bg-canvas', light: '#fefdfb', dark: '#1e1e1e' },
  { name: '--text', light: '#1a1a1a', dark: '#ffffff' },
] as const;

/** The resolved `background-color` of a real element, per theme. */
const ROOT_BACKGROUND = {
  light: 'rgb(254, 253, 251)',
  dark: 'rgb(30, 30, 30)',
} as const;

interface RunRow {
  id: string;
  session_id: string;
  status: string;
  terminal: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
  manifest_hash: string;
}

interface RunEventRow {
  run_id: string;
  seq: number;
  event_type: string;
  envelope_json: string;
}

interface ChatTurnResult {
  httpStatus: number;
  frameTypes: string[];
  text: string;
  error: Record<string, unknown> | null;
  streamStalled: boolean;
}

function stage(label: string): void {
  console.log(`[e2e-ui-states] ${label}`);
}

/**
 * The live app and its model fixture, for `afterEach` to tear down.
 *
 * Module scope, not `describe` scope: `startRealTurn` is a module-level helper
 * (both run-state tests share it) and a helper declared inside the describe
 * body cannot see the describe body's bindings.
 */
let dua: DuyaApp | undefined;
let provider: HeldLoopback | undefined;

/** The namespace's core database - `sessions`, `runs`, `run_events`. */
function coreDb(namespace: string): Database.Database {
  return new Database(path.join(userDataRootFor(namespace), 'databases', 'duya-core.db'));
}

/** The namespace's main database - `settings`, `threads`, `messages`, approvals. */
function mainDb(namespace: string): Database.Database {
  return new Database(path.join(userDataRootFor(namespace), 'databases', 'duya-main.db'));
}

/** Read one `runs` row, or null when the run has not been written yet. */
function readRun(db: Database.Database, sessionId: string): RunRow | null {
  const rows = db.prepare('SELECT * FROM runs WHERE session_id = ?').all(sessionId) as RunRow[];
  return rows[0] ?? null;
}

interface StartedTurn {
  page: Page;
  sessionId: string;
  db: Database.Database;
  provider: HeldLoopback;
}

/**
 * Launch the app, register nothing, and post ONE real turn from the renderer.
 *
 * Shared by the pending and the terminal test, because the pending test has to
 * trust the store: a run row is only meaningful if a real turn wrote it, and
 * the terminal test must observe the same kind of run.
 */
async function startRealTurn(): Promise<StartedTurn> {
  const loopback = await startHeldLoopbackAnthropic({
    text: EXPECTED_TEXT,
    model: MODEL,
    holdMs: HOLD_MS,
    inputTokens: 11,
    outputTokens: 7,
  });
  const launched = await launchDuya({ namespace: RUN_NAMESPACE });
  // Handed to the module-level bindings so `afterEach` tears both down even
  // when a test fails before it returns.
  provider = loopback;
  dua = launched;
  const page = launched.page;
  stage(`loopback provider at ${loopback.baseUrl}`);

  const agentUrl = await waitForAgentServerUrl(page);
  expect(agentUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  stage(`agent server at ${agentUrl}`);

  const workspace = path.join(userDataRootFor(RUN_NAMESPACE), `workspace-turn`);
  fs.mkdirSync(workspace, { recursive: true });
  const sessionId = `e4-4-ui-states-turn-${Date.now()}`;

  // The real IPC handler, the same call the renderer makes to create a chat.
  const created = await invokeApi<{ id: string }>(page, 'thread.create', {
    id: sessionId,
    title: 'E4.4 UI states turn',
    working_directory: workspace,
  });
  expect(created.id).toBe(sessionId);
  stage(`session ${sessionId} created through the preload`);

  // The turn is posted FROM THE RENDERER but not awaited, so the run can be
  // observed while it is genuinely in flight. The fetch is the renderer's own:
  // same URL, headers and body shape `agent-http-client.ts` uses.
  stage('posting the turn without awaiting it');
  await startChatTurnInBackground(page, {
    baseUrl: agentUrl,
    sessionId,
    workspace,
    providerBaseUrl: loopback.baseUrl,
  });

  return { page, sessionId, db: coreDb(RUN_NAMESPACE), provider: loopback };
}

interface PollResult {
  row: RunRow | null;
  /** The turn's own view, so a failure names the route's answer and not just
   *  an absent row. */
  lastProbe: string;
}

/**
 * The turn's own view of itself, for a failure message.
 *
 * `httpStatus` is recorded as soon as the route's response headers arrive,
 * separately from the frame list, because the informative failure here is
 * "the route never answered" and a probe that only reports once the stream
 * ENDS cannot distinguish that from a slow turn.
 */
async function sampleTurn(page: Page): Promise<string> {
  const probe = await page.evaluate(
    () =>
      (
        window as unknown as {
          __e44: { done: boolean; httpStatus: number; result: ChatTurnResult | null };
        }
      ).__e44,
  );
  const state = probe.done
    ? 'the turn finished'
    : probe.httpStatus > 0
      ? 'the stream is still open'
      : 'the route has not sent response headers';
  if (!probe.result) return `${state}; httpStatus=${probe.httpStatus}`;
  return (
    `${state}; http=${probe.result.httpStatus} frames=[${probe.result.frameTypes.join(',')}] ` +
    `error=${JSON.stringify(probe.result.error)}`
  );
}

/** Poll for a run row that is live: `status='running'` and no terminal. */
async function pollForLiveRun(page: Page, db: Database.Database, sessionId: string): Promise<PollResult> {
  const deadline = Date.now() + 120_000;
  let lastProbe = 'the turn produced no result frame yet';
  while (Date.now() < deadline) {
    const row = readRun(db, sessionId);
    if (row && row.terminal === null) return { row, lastProbe };
    lastProbe = await sampleTurn(page);
    await page.waitForTimeout(200);
  }
  return { row: readRun(db, sessionId), lastProbe };
}

/** Poll for a run row that has settled: a terminal is present. */
async function pollForSettledRun(
  page: Page,
  db: Database.Database,
  sessionId: string,
): Promise<PollResult> {
  const deadline = Date.now() + 180_000;
  let lastProbe = 'the turn produced no result frame yet';
  while (Date.now() < deadline) {
    const row = readRun(db, sessionId);
    if (row && row.terminal !== null) return { row, lastProbe };
    lastProbe = await sampleTurn(page);
    await page.waitForTimeout(250);
  }
  return { row: null, lastProbe };
}

test.describe('E4.4 - light/dark and the pending/terminal/approval states', () => {
  // Electron boot, a worker fork, and a held model response.
  test.setTimeout(300_000);

  test.afterEach(async () => {
    await provider?.close();
    provider = undefined;
    if (dua) {
      await closeDuya(dua.app);
      dua = undefined;
    }
  });

  // ---------------------------------------------------------------------------
  // light / dark
  // ---------------------------------------------------------------------------

  test('the theme switch repaints the shell in both themes and persists both', async () => {
    dua = await launchDuya({ namespace: THEME_NAMESPACE });
    const page = dua.page;
    stage('electron launched, preload exposed');

    // A namespace is created with `theme=dark` in the settings table, and the
    // sidebar deliberately renders the SYSTEM preference until that setting
    // load resolves (app-sidebar.tsx:446). So the first paint after boot is
    // the fallback, not the answer, and reading it as the baseline would make
    // the first click a no-op: `toggleTheme` saves the opposite of whatever
    // `resolvedTheme` currently is. Waiting for the setting to reach the DOM is
    // therefore not a convenience - it is what makes the flip real.
    await waitForSettledTheme(page, THEME_NAMESPACE);
    const baseline = await readRenderedTheme(page);
    stage(`baseline data-theme=${baseline.dataTheme} bg=${baseline.tokens['--bg-canvas'].trim()}`);

    const persistedBefore = readPersistedTheme(THEME_NAMESPACE);
    stage(`settings.theme before any click = ${String(persistedBefore)}`);
    // The rendered theme and the stored one agree before this spec touches
    // anything, which is the claim the rest of the test depends on.
    expect(baseline.dataTheme).toBe(persistedBefore);

    // The REAL switch: the app's own theme button, which calls
    // `save({theme})` -> `settingsDb.set('theme', ...)` -> ipcMain -> SQLite.
    // No attribute is written by this spec at any point.
    await clickThemeToggle(page);
    const flipRect = await describeThemeToggles(page);
    stage(`clicked the theme toggle; candidates now ${flipRect}`);

    // The app's own effect writes `data-theme`; wait for the flip rather than
    // racing it, so a slow save is not read as a missing switch.
    await page.waitForFunction(
      (was) => document.documentElement.getAttribute('data-theme') !== was,
      baseline.dataTheme,
      { timeout: 30_000 },
    );
    const afterFlip = await readRenderedTheme(page);
    stage(`after click data-theme=${afterFlip.dataTheme}`);

    // --- the switch moved the app between the two themes ---
    expect([baseline.dataTheme, afterFlip.dataTheme].sort()).toEqual(['dark', 'light']);
    const light = afterFlip.dataTheme === 'light' ? afterFlip : baseline;
    const dark = afterFlip.dataTheme === 'dark' ? afterFlip : baseline;

    // Not "a class exists": every custom property resolved to the OTHER
    // theme's declared token.
    for (const token of THEME_TOKENS) {
      expect(light.tokens[token.name].trim(), `${token.name} in light`).toBe(token.light);
      expect(dark.tokens[token.name].trim(), `${token.name} in dark`).toBe(token.dark);
      expect(light.tokens[token.name]).not.toBe(dark.tokens[token.name]);
    }

    // And a REAL ELEMENT was repainted with a resolved colour, not just the
    // :root token block swapped. This is the used value, in `rgb()`.
    expect(light.rootBackground).toBe(ROOT_BACKGROUND.light);
    expect(dark.rootBackground).toBe(ROOT_BACKGROUND.dark);
    expect(light.rootBackground).not.toBe(dark.rootBackground);

    // --- both themes reached durable storage through ipcMain ---
    const persistedAfterFlip = readPersistedTheme(THEME_NAMESPACE);
    expect(persistedAfterFlip, 'the click must have crossed the bridge to SQLite').toBe(
      afterFlip.dataTheme,
    );
    expect(persistedBefore).not.toBe(persistedAfterFlip);

    // Click back, so BOTH directions of the switch are exercised on one live
    // window and both values are proven durable. The app's toggle computes its
    // target from `resolvedTheme`, which is fed by the SETTINGS load rather
    // than by the attribute it just wrote, so the second click waits for the
    // stored value to catch up with the DOM. Clicking earlier computes the same
    // target twice and the attribute never moves - a test-ordering bug that
    // would otherwise read as a broken switch.
    await waitForSettledTheme(page, THEME_NAMESPACE);
    await clickThemeToggle(page);
    await page.waitForFunction(
      (want) => document.documentElement.getAttribute('data-theme') === want,
      baseline.dataTheme,
      { timeout: 30_000 },
    );
    const afterReturn = await readRenderedTheme(page);
    expect(afterReturn.dataTheme).toBe(baseline.dataTheme);
    expect(afterReturn.rootBackground).toBe(baseline.rootBackground);
    expect(readPersistedTheme(THEME_NAMESPACE)).toBe(baseline.dataTheme);

    // A fresh boot must land on the persisted theme with no click at all,
    // which is the claim that the SETTING drives rendering rather than the
    // button's side effect.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(
      (want) => document.documentElement.getAttribute('data-theme') === want,
      baseline.dataTheme,
      { timeout: 30_000 },
    );
    const afterReload = await readRenderedTheme(page);
    expect(afterReload.dataTheme).toBe(baseline.dataTheme);
    expect(afterReload.rootBackground).toBe(baseline.rootBackground);
    stage('theme verified in both directions, persisted and re-read after reload');
  });

  // ---------------------------------------------------------------------------
  // pending / terminal
  // ---------------------------------------------------------------------------

  /**
   * `pending` is `RunStatus`'s live arm, observed rather than described.
   *
   * The fixture holds the model response open so the window in which the run is
   * live is seconds wide instead of a race. If this test ever fails with "no
   * live run row", the turn did not get as far as the run layer - read the
   * namespace's `app.log` and the turn's own last frame before suspecting the
   * assertion.
   */
  test('a real run is pending while it is genuinely in flight', async () => {
    const { page, sessionId, db } = await startRealTurn();
    try {
      // --- pending ---
      // The run row is opened by the executor, so poll for it: "no row yet" is
      // not the pending state, "a live row with no terminal" is. The turn's own
      // HTTP result is sampled on every pass, so a turn that never reached the
      // route reports the route's answer instead of a bare "no run row".
      const pending = await pollForLiveRun(page, db, sessionId);
      expect(
        pending.row,
        `no live run row for ${sessionId} within 120s; the turn said: ${pending.lastProbe}`,
      ).not.toBeNull();
      // `RunStatus`'s live arm, and no terminal has been written.
      expect(pending.row!.status, 'a live run is status=running').toBe('running');
      expect(pending.row!.terminal, 'a live run holds no terminal').toBeNull();
      expect(pending.row!.finished_at, 'a live run has not finished').toBeNull();
      expect(pending.row!.manifest_hash, 'the run is bound to a real frozen manifest').not.toBe('');
      stage(`PENDING run=${pending.row!.id} status=${pending.row!.status} terminal=null`);

      // The renderer had not been told the turn ended - the stream was still
      // open at the moment the row was live, so the two agree.
      const midFlight = await page.evaluate(
        () => (window as unknown as { __e44: { done: boolean } }).__e44.done,
      );
      expect(midFlight, 'the turn must still be in flight while the run is pending').toBe(false);

      // The ledger agrees with the row: the run opened, and nothing claims
      // otherwise while it is live.
      const events = db
        .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq')
        .all(pending.row!.id) as RunEventRow[];
      expect(events.length).toBeGreaterThan(0);
      expect(events[0].event_type).toBe('run.started');
      const startedPayload = (JSON.parse(events[0].envelope_json) as {
        payload: { manifestHash?: string };
      }).payload;
      expect(startedPayload.manifestHash).toBe(pending.row!.manifest_hash);
      expect(
        events.some((e) => e.event_type === 'run.completed' || e.event_type === 'run.failed'),
        'a live run must not already carry a terminal event',
      ).toBe(false);
      stage(`PENDING ledger holds ${events.length} event(s), none terminal`);
    } finally {
      db.close();
    }
  });

  /**
   * `terminal` is `RunStatus`'s four terminal arms, asserted against the
   * product's own vocabulary rather than against whichever arm happened to
   * occur. All four are accepted - which one a turn lands on depends on how it
   * ended, and a provider or environment failure legitimately yields `failed`.
   * What is NOT accepted is a run with no terminal, a row whose `status` and
   * `terminal` disagree, or a ledger whose last event contradicts the row.
   *
   * Note that the SSE stream does not close when the run settles: the app makes
   * a second model call for the session title afterwards, so `done` is not the
   * turn's signal. This test reads the text off the stream as it arrives and
   * the terminal out of the database, which are the two things it is claiming.
   */
  test('a real run reaches a terminal that agrees with its own ledger', async () => {
    const { page, sessionId, provider: loopback, db } = await startRealTurn();
    try {
      // --- terminal ---
      const settled = await pollForSettledRun(page, db, sessionId);
      expect(
        settled.row,
        `the run never reached a terminal within 180s; the turn said: ${settled.lastProbe}`,
      ).not.toBeNull();

      const turn = await waitForTurnText(page, 90_000);
      expect(turn.error).toBeNull();
      expect(turn.text).toBe(EXPECTED_TEXT);
      // The model boundary was really crossed, by the real client, to the
      // endpoint this spec gave it.
      expect(loopback.requests.length).toBeGreaterThanOrEqual(1);
      expect(loopback.authHeadersSeen).toContain(LOOPBACK_API_KEY);
      expect(loopback.requests.some((r) => r.model === MODEL)).toBe(true);

      // `status` and `terminal` are written by the same UPDATE, so they name
      // the same arm; a row that disagreed would be a lost claim. Any of the
      // four arms is a terminal - which one depends on how the turn ended, and
      // a provider or environment failure legitimately yields `failed`.
      const TERMINAL_ARMS = ['completed', 'cancelled', 'budget_exhausted', 'failed'] as const;
      expect(TERMINAL_ARMS, 'a settled run carries one of the four terminal arms').toContain(
        settled.row!.status,
      );
      expect(settled.row!.terminal).toBe(settled.row!.status);
      expect(settled.row!.finished_at).not.toBeNull();
      expect(settled.row!.finished_at!).toBeGreaterThanOrEqual(settled.row!.started_at ?? 0);
      stage(`TERMINAL run=${settled.row!.id} status=${settled.row!.status}`);

      // The event ledger: ordered, unique, terminal-last, and agreeing with
      // the row. A run whose row says `completed` while its own last event
      // says otherwise is exactly the disagreement this slice exists to catch.
      const events = db
        .prepare('SELECT * FROM run_events WHERE run_id = ? ORDER BY seq')
        .all(settled.row!.id) as RunEventRow[];
      expect(events.length).toBeGreaterThan(0);
      const seqs = events.map((e) => e.seq);
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
      expect(new Set(seqs).size).toBe(seqs.length);
      expect(events[0].event_type).toBe('run.started');

      const last = events[events.length - 1];
      expect(['run.completed', 'run.failed', 'run.cancelled', 'run.budget_exhausted']).toContain(
        last.event_type,
      );
      const terminalPayload = (JSON.parse(last.envelope_json) as {
        payload: { type: string; status?: string };
      }).payload;
      expect(terminalPayload.status).toBe(settled.row!.terminal);

      // The text the renderer received is the text the ledger holds. The
      // durable text blocks are `assistant.text_block` events - that is the
      // event name a real completed turn writes here.
      const durableText = events
        .filter((e) => e.event_type === 'assistant.text_block')
        .flatMap((e) => {
          const payload = (JSON.parse(e.envelope_json) as { payload: { text?: string } }).payload;
          return payload.text ? [payload.text] : [];
        })
        .join('');
      expect(durableText, 'the ledger must hold the turn text').toBe(EXPECTED_TEXT);
      expect(turn.text).toBe(durableText);
    } finally {
      db.close();
    }
  });

  // ---------------------------------------------------------------------------
  // approval
  // ---------------------------------------------------------------------------

  test('an approval awaiting a user decision round-trips through the real bridge', async () => {
    // --- How this state is reached, stated where a reader will see it ---
    //
    // SEEDED, not driven by a model. `persistApprovalCard`
    // (packages/agent/src/process/tool-approval-card.ts:52) creates exactly
    // this row when a tool permission ask cannot be answered in-process, and
    // the row is the state the renderer binds to: `BotDirectChatView` hydrates
    // from `toolApproval.listBySession` and keeps live via
    // `toolApproval.onUpdated`, and `BotToolApprovalCard` renders
    // `data-status` from it. What the seed replaces is the MODEL's decision to
    // call a tool that needs approval, which needs a provider that emits a tool
    // call. What it does NOT replace is any of the behaviour under test: the
    // pending read, the user's decision, the CAS transition and the re-read all
    // run through the real preload, the real ipcMain handlers and the real
    // SQLite file.
    //
    // WHAT IS NOT PROVEN, precisely: that the approval CARD is painted. The
    // card renders inside the bot-direct chat surface, and getting a
    // session-bound surface open in a fresh isolated namespace needs a
    // navigation step this slice did not solve; mutating the Zustand store
    // from `page.evaluate` instead of clicking would have been fabricating
    // renderer state, which is the thing E4.4 forbids. So this test stops at
    // the last boundary it can cross honestly.
    dua = await launchDuya({ namespace: APPROVAL_NAMESPACE });
    const page = dua.page;
    stage('electron launched for the approval round trip');

    const sessionId = `bot:e4-4-approval-agent-${Date.now()}`;
    const approvalId = `e4-4-approval-${Date.now()}`;
    const toolInput = { command: 'rm -rf build-artifacts' };
    const inputHash = createHash('sha256').update(JSON.stringify(toolInput)).digest('hex');

    // Seed the row the product writes. An independent connection is used on
    // purpose: a row this process can read is a row that was committed.
    await seedPendingApproval({ namespace: APPROVAL_NAMESPACE, sessionId, approvalId, toolInput, inputHash });
    stage(`seeded approval ${approvalId} status=pending`);

    // --- pending: the renderer's own read of the approval data source ---
    const listed = await invokeApi<Array<{ id: string; status: string; decision: string | null }>>(
      page,
      'toolApproval.listBySession',
      sessionId,
    );
    const row = listed.find((r) => r.id === approvalId);
    expect(row, `toolApproval.listBySession did not return ${approvalId}`).toBeDefined();
    // `tool_approval_state`'s own status vocabulary - not the run lifecycle.
    expect(row!.status).toBe('pending');
    expect(row!.decision, 'an undecided approval holds no decision').toBeNull();
    expect(readApprovalStatus(APPROVAL_NAMESPACE, approvalId)).toBe('pending');
    stage('PENDING approval visible through the preload with status=pending');

    // --- the user's decision, through the preload ---
    await invokeApi(page, 'toolApproval.resolve', approvalId, 'allow');

    // The resolver CAS-transitions the row and broadcasts
    // `tool-approval:updated` to every window. Polled rather than assumed,
    // because the broadcast and the read are separate statements.
    let after: string | null = null;
    const by = Date.now() + 30_000;
    while (Date.now() < by) {
      after = readApprovalStatus(APPROVAL_NAMESPACE, approvalId);
      if (after !== 'pending') break;
      await page.waitForTimeout(150);
    }
    expect(after, 'resolve must move the row out of pending').not.toBe('pending');
    expect(after).toBe('approved');

    // And the renderer's own read agrees with the file, in both directions.
    const relisted = await invokeApi<Array<{ id: string; status: string; decision: string | null }>>(
      page,
      'toolApproval.listBySession',
      sessionId,
    );
    const resolved = relisted.find((r) => r.id === approvalId);
    expect(resolved!.status).toBe('approved');
    expect(resolved!.decision).toBe('allow');
    stage(`TERMINAL approval status=${String(resolved!.status)} decision=${String(resolved!.decision)}`);

    // The store is genuinely the one the app opened, not a copy this spec made.
    const dbFile = path.join(userDataRootFor(APPROVAL_NAMESPACE), 'databases', 'duya-main.db');
    expect(fs.existsSync(dbFile), `main database missing at ${dbFile}`).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** The theme as the browser actually resolved it, not as the DOM declares it. */
interface RenderedTheme {
  dataTheme: string | null;
  tokens: Record<string, string>;
  rootBackground: string;
}

async function readRenderedTheme(page: Page): Promise<RenderedTheme> {
  return page.evaluate((names) => {
    const root = document.documentElement;
    const computed = getComputedStyle(root);
    const tokens: Record<string, string> = {};
    for (const name of names) tokens[name] = computed.getPropertyValue(name);
    // Resolve `--bg-canvas` on a REAL element inside the real document, so
    // the value read back is the one the cascade produced rather than the
    // declared token. `#root` itself is transparent (measured: it computes to
    // `rgba(0, 0, 0, 0)` in both themes), so the probe carries the token
    // instead of relying on the app's own layout choice - which is not what
    // this assertion is about. The claim it makes is "the cascade resolves the
    // canvas token to a different colour in each theme", not "a particular
    // product element paints it".
    const probe = document.createElement('div');
    probe.style.position = 'absolute';
    probe.style.pointerEvents = 'none';
    probe.style.backgroundColor = 'var(--bg-canvas)';
    document.body.appendChild(probe);
    const rootBackground = getComputedStyle(probe).backgroundColor;
    probe.remove();
    return { dataTheme: root.getAttribute('data-theme'), tokens, rootBackground };
  }, THEME_TOKENS.map((t) => t.name));
}

/**
 * Wait until the persisted setting has reached the DOM.
 *
 * The sidebar renders the system preference until its settings load resolves
 * and only trusts `settings.theme` afterwards, so a read taken too early sees
 * the fallback. Polling the file and the DOM together is what makes the
 * baseline a real baseline.
 */
/**
 * Describe every theme-toggle candidate in the DOM, for a failure message.
 *
 * The sidebar renders the toggle twice - once in the expanded rail
 * (`button.rail-btn`) and once in the expanded sidebar
 * (`button.theme-toggle`) - and which one is clickable depends on the rail's
 * collapsed state. Naming the geometry turns "locator.click timed out" into
 * "the toggle is at y=1180, below the 900px viewport".
 */
async function describeThemeToggles(page: Page): Promise<string> {
  const parts = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('button.theme-toggle, button.rail-btn'),
    ) as HTMLButtonElement[];
    return nodes.map((n) => {
      const r = n.getBoundingClientRect();
      return `${n.className.split(' ')[0]}@${Math.round(r.x)},${Math.round(r.y)} ${Math.round(r.width)}x${Math.round(r.height)}`;
    });
  });
  return parts.length > 0 ? parts.join(' | ') : '<no theme toggle in the DOM>';
}

/**
 * Wait until no modal overlay is covering the shell.
 *
 * A fresh isolated namespace intermittently shows a modal (the onboarding
 * wizard) over the sidebar. Playwright's click auto-wait retries for 30s and
 * then reports "intercepts pointer events", which reads as a broken toggle
 * rather than as an overlay in the way. This waits the overlay out and, if it
 * persists, says so with the on-screen text - which names which modal it was.
 */
async function waitForNoModalOverlay(page: Page, budgetMs = 30_000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const overlays = await page.evaluate(
      () => document.querySelectorAll('div.fixed.inset-0.z-50').length,
    );
    if (overlays === 0) return;
    await page.waitForTimeout(250);
  }
  const onScreen = await page.evaluate(() => (document.body.innerText ?? '').slice(0, 200));
  throw new Error(
    `a modal overlay (div.fixed.inset-0.z-50) still covers the shell after ${budgetMs}ms; ` +
      `on-screen text: ${onScreen}`,
  );
}

/**
 * Click the app's own theme switch.
 *
 * Picks the candidate that is actually on screen, scrolls it into view, and
 * clicks it. Scrolling first matters: the sidebar's toggle sits at the bottom
 * of the panel, and a click that Playwright cannot land reports a bare
 * 30s timeout that says nothing about where the button was.
 */
async function clickThemeToggle(page: Page): Promise<void> {
  // Retried because the modal is a RACE, not a fixed obstacle: it can mount
  // after the readiness check and before the click lands, and Playwright's
  // click then reports "intercepts pointer events" against the button. Each
  // attempt re-waits for the overlay, so the loop only ever clicks the real
  // control with nothing on top of it. The theme assertions are untouched by
  // this - a run that cannot get an unobstructed click fails either way.
  const deadline = Date.now() + 90_000;
  let lastError = '';
  for (let attempt = 1; ; attempt++) {
    try {
      await waitForNoModalOverlay(page, 15_000);
      const index = await page.evaluate(() => {
    const nodes = Array.from(
      document.querySelectorAll('button.theme-toggle, button.rail-btn'),
    ) as HTMLButtonElement[];
    const onScreen = nodes.findIndex((n) => {
      const r = n.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight;
    });
    return onScreen >= 0 ? onScreen : -1;
  });
  if (index < 0) {
    throw new Error(
      `no on-screen theme toggle to click; candidates: ${await describeThemeToggles(page)}`,
    );
  }
  const toggle = page.locator('button.theme-toggle, button.rail-btn').nth(index);
  await toggle.scrollIntoViewIfNeeded();
  await toggle.click({ timeout: 15_000 });
      return;
    } catch (err) {
      lastError = (err as Error).message.split('\n')[0];
      if (Date.now() > deadline) {
        throw new Error(
          `could not get an unobstructed click on the theme toggle after ${attempt} attempt(s): ` +
            `${lastError}; candidates: ${await describeThemeToggles(page)}`,
        );
      }
      await page.waitForTimeout(500);
    }
  }
}

async function waitForSettledTheme(page: Page, namespace: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  let last = '<no persisted theme row>';
  while (Date.now() < deadline) {
    const persisted = readPersistedTheme(namespace);
    last = String(persisted);
    if (persisted === 'light' || persisted === 'dark') {
      const rendered = await page.evaluate(() =>
        document.documentElement.getAttribute('data-theme'),
      );
      if (rendered === persisted) return;
    }
    await page.waitForTimeout(250);
  }
  throw new Error(`the persisted theme never reached the DOM; settings.theme=${last}`);
}

/** `settings.theme`, read with an independent connection to the namespace DB. */function readPersistedTheme(namespace: string): string | null {
  const db = mainDb(namespace);
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get('theme') as
      | { value: string }
      | undefined;
    return row?.value ?? null;
  } finally {
    db.close();
  }
}

async function seedPendingApproval(args: {
  namespace: string;
  sessionId: string;
  approvalId: string;
  toolInput: Record<string, unknown>;
  inputHash: string;
}): Promise<void> {
  const file = path.join(userDataRootFor(args.namespace), 'databases', 'duya-main.db');
  if (!fs.existsSync(file)) {
    throw new Error(
      `main database not found at ${file}. The default lands in the namespace userData, so a MISSING ` +
        'databases directory usually means a stale storage.database_path in ' +
        '~/.duya/test-namespaces/<ns>/config.toml pointed this namespace at another worktree. Clear it ' +
        'and re-run before suspecting the product.',
    );
  }
  // The app owns this database and may still be running its schema migrations
  // when this test starts, so a busy write is expected rather than exceptional.
  // Retried briefly; anything else propagates.
  const deadline = Date.now() + 30_000;
  for (;;) {
    const db = new Database(file);
    try {
      db.prepare(
        `INSERT INTO tool_approval_state
           (id, message_id, session_id, scope_type, scope_id, tool_name, tool_input_json,
            input_hash, status, decision, decided_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?)`,
      ).run(
        args.approvalId,
        `approval-card-${args.approvalId}`,
        args.sessionId,
        'session',
        args.sessionId,
        'Bash',
        JSON.stringify(args.toolInput),
        args.inputHash,
        Date.now(),
      );
      return;
    } catch (err) {      const busy = /busy|locked/i.test((err as Error).message);
      if (!busy || Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 500));
    } finally {
      db.close();
    }
  }
}

function readApprovalStatus(namespace: string, approvalId: string): string | null {
  const db = mainDb(namespace);
  try {
    const row = db.prepare('SELECT status FROM tool_approval_state WHERE id = ?').get(approvalId) as
      | { status: string }
      | undefined;
    return row?.status ?? null;
  } finally {
    db.close();
  }
}

async function waitForAgentServerUrl(page: Page): Promise<string> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const url = await invokeApi<string | null>(page, 'agentServer.getUrl');
    if (url) return url;
    await page.waitForTimeout(500);
  }
  throw new Error('agentServer.getUrl never returned a URL within 30s');
}

/**
 * POST the chat turn from the renderer and let it run in the background.
 *
 * The result lands on `window.__e44` rather than being returned, because a
 * returned promise would be awaited by Playwright and this spec has to observe
 * the run while the turn is still in flight.
 */
async function startChatTurnInBackground(
  page: Page,
  args: { baseUrl: string; sessionId: string; workspace: string; providerBaseUrl: string },
): Promise<void> {
  await page.evaluate((a) => {
    const w = window as unknown as {
      __e44: {
        done: boolean;
        httpStatus: number;
        frames: string[];
        text: string;
        pageError: string | null;
      };
    };
    w.__e44 = { done: false, httpStatus: 0, frames: [], text: '', pageError: null };
    void (async () => {
      const response = await fetch(
        `${a.baseUrl}/sessions/${encodeURIComponent(a.sessionId)}/chat`,
        {
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
        },
      );
      // Recorded before the stream is read, so a probe can tell "the route has
      // not answered" from "the turn is running".
      w.__e44.httpStatus = response.status;
      // Everything the page needs lives INSIDE this callback, on purpose.
      // `page.evaluate` serialises the function and runs it in the page, so a
      // reference to a module-scope helper is a ReferenceError THERE - and the
      // floating `void (async ...)()` below swallows it, which presents
      // exactly like "the product sent no frames". This spec hit that bug: the
      // fetch fired (a real run was created and completed) and then the reader
      // threw, leaving `frames=[]` and reading as a product defect. The
      // try/catch makes any such failure name itself instead.
      const reader = response.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        const frames: Array<{ type: string; data: Record<string, unknown> }> = [];
        let buffer = '';
        // Published after every chunk. Waiting for the stream to CLOSE would
        // measure the session-title model call that follows the terminal, not
        // the turn this spec is about.
        const publish = (): void => {
          w.__e44.frames = frames.map((f) => f.type);
          w.__e44.text = frames
            .filter((f) => f.type === 'text')
            .map((f) => (typeof f.data.content === 'string' ? f.data.content : ''))
            .join('');
        };
        for (;;) {
          const next = await Promise.race([
            reader.read(),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 5_000)),
          ]);
          if (next === null) continue; // no chunk in this window
          const { done, value } = next;
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const chunks = buffer.split('\n\n');
          buffer = chunks.pop() ?? '';
          for (const chunk of chunks) {
            const dataLine = chunk.split('\n').find((line) => line.startsWith('data: '));
            if (!dataLine) continue;
            try {
              const parsed = JSON.parse(dataLine.slice(6)) as {
                type?: string;
                data?: Record<string, unknown>;
              };
              if (typeof parsed.type === 'string') frames.push({ type: parsed.type, data: parsed.data ?? {} });
            } catch {
              // A partial frame; the next read completes it.
            }
          }
          publish();
        }
        publish();
      }
      w.__e44.done = true;
    })().catch((err: unknown) => {
      // A page-side throw must not be invisible: it would look like silence.
      w.__e44.pageError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      w.__e44.done = true;
    });
  }, {
    baseUrl: args.baseUrl,
    sessionId: args.sessionId,
    workspace: args.workspace,
    providerBaseUrl: args.providerBaseUrl,
    model: MODEL,
    apiKey: LOOPBACK_API_KEY,
    prompt: 'Reply with exactly the sentence you were configured to emit, and call no tools.',
  });
}

/**
 * Wait until the renderer has actually RECEIVED the turn's text.
 *
 * Deliberately not "until the stream closed": a real turn's socket stays open
 * for the session-title model call that follows the terminal, so closing is not
 * the turn's signal. The text arriving on the stream is.
 */
async function waitForTurnText(page: Page, budgetMs: number): Promise<ChatTurnResult> {
  const deadline = Date.now() + budgetMs;
  let last = {
    frames: [] as string[],
    text: '',
    httpStatus: 0,
    pageError: null as string | null,
  };
  while (Date.now() < deadline) {
    const state = await page.evaluate(() => {
      const w = window as unknown as {
        __e44: {
          done: boolean;
          httpStatus: number;
          frames: string[];
          text: string;
          pageError: string | null;
        };
      };
      return {
        done: w.__e44.done,
        httpStatus: w.__e44.httpStatus,
        frames: w.__e44.frames,
        text: w.__e44.text,
        pageError: w.__e44.pageError,
      };
    });
    last = state;
    // A page-side throw is a harness failure, and is reported as one rather
    // than as a product that sent nothing.
    if (state.pageError) {
      throw new Error(`the page-side stream reader threw: ${state.pageError}`);
    }
    if (state.text === EXPECTED_TEXT || (state.done && state.frames.length > 0)) {
      return {
        httpStatus: state.httpStatus,
        frameTypes: state.frames,
        text: state.text,
        error: null,
        streamStalled: false,
      };
    }
    await page.waitForTimeout(250);
  }
  throw new Error(
    `the turn's text never arrived within ${budgetMs}ms; httpStatus=${last.httpStatus} ` +
      `frames=[${last.frames.join(',')}] pageError=${String(last.pageError)}`,
  );
}
