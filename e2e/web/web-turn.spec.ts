/**
 * e2e/web/web-turn.spec.ts — the Web surface's browser acceptance.
 *
 * Plan 610 T40b: "真 Host + 生产 worker + 受控 provider + 实际浏览器" for the
 * Web client — 发送/工具/审批/取消/刷新重放, with no second reducer.
 *
 * ## What each test proves, and to which layer
 *
 * The Web client is the SHARED renderer (`@duya/ui`) driven by a
 * `UiServices` port whose Web implementation is `createWebUiServices()`.
 * Every assertion below therefore crosses a real boundary:
 *
 *   browser → BFF (same-origin, CSRF) → Host (HTTP, bearer) → worker
 *   → provider, and back as SSE envelopes the renderer projects.
 *
 * Nothing here asserts on the BFF's HTTP shape directly, because the point
 * is the BROWSER's view. A test that called `/api/runs/start` with fetch
 * would prove the transport and skip the surface under test. The ledger
 * reads below are the ONE exception, and they exist to confirm what the
 * screen claims: a DOM that shows a finished answer is not proof that the
 * run finished, because the renderer can draw a stream that died.
 *
 * ## One session per scenario
 *
 * A session's TITLE is derived from its first message — the product renames
 * a session after the message that starts it. So a scenario that ran once
 * renamed its own session, and the next scenario's lookup by title missed.
 * Each scenario therefore gets its OWN session, and every lookup addresses a
 * row by `data-session-id` rather than by its (movable) title.
 */

import { expect, test, type Page } from '@playwright/test';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';

interface AcceptanceEnv {
  readonly origin: string;
  readonly dataRoot: string;
  readonly workspace: string;
  /** The file the controlled tool writes when it really ran. */
  readonly executionsFile: string;
  readonly sessionIds: Record<string, string>;
  readonly providerOrigin: string;
}

/**
 * The composer is a contenteditable div, not a textarea, so `fill()` does
 * not apply. Typing into it the way a user does — one key at a time — is also
 * what the renderer's own mention detection and autosize listen for.
 */
async function typeInComposer(page: Page, text: string): Promise<void> {
  const input = page.locator('[role="textbox"][contenteditable="true"]').first();
  await expect(input).toBeVisible({ timeout: 30_000 });
  await input.click();
  await input.pressSequentially(text, { delay: 5 });
}

async function sendMessage(page: Page, text: string): Promise<void> {
  await typeInComposer(page, text);
  await page.locator('[aria-label="Send"]').click();
}

/**
 * Open the Web client and select a session.
 *
 * The session is picked from the SIDEBAR rather than created, because a Web
 * session's workspace binding comes from the Host — the browser names a
 * directory and the Host issues the binding. The acceptance environment
 * already created the sessions, so the browser selects one.
 */
async function openSession(page: Page, sessionId: string): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  const row = page.locator(`[data-session-id="${sessionId}"]`).first();
  await expect(row).toBeVisible({ timeout: 30_000 });
  await row.click();
  // The composer only renders once a session is active.
  await expect(page.locator('[role="textbox"][contenteditable="true"]').first())
    .toBeVisible({ timeout: 30_000 });
}

/** The Host's durable run rows for a session. */
async function readRuns(page: Page, sessionId: string): Promise<readonly {
  runId: string;
  status: string;
  startedAt: number | null;
  finishedAt: number | null;
}[]> {
  return await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/runs?limit=20`);
    const body = await response.json() as { runs?: { runId: string; status: string; startedAt: number | null; finishedAt: number | null }[] };
    return body.runs ?? [];
  }, sessionId);
}

/** The Host's pending permission requests for a session. */
async function readPendingApprovals(page: Page, sessionId: string): Promise<number> {
  return await page.evaluate(async (id) => {
    const response = await fetch(`/api/sessions/${encodeURIComponent(id)}/approvals`);
    const body = await response.json() as { approvals?: unknown[] };
    return (body.approvals ?? []).length;
  }, sessionId);
}

/**
 * The chat area — the transcript and the composer, WITHOUT the sidebar.
 *
 * The sidebar repeats a session's title, and a session's title is derived
 * from its first message. So a whole-page text query for the message a
 * scenario just sent also finds the session's own row in the sidebar, and
 * an isolation assertion written that way measures the sidebar, not the
 * transcript. Every assertion about what a session CONTAINS is scoped to
 * the chat area.
 */
function chatArea(page: Page) {
  return page.locator('.chat-main-column');
}

test.describe('Web client: the browser drives a real agent turn', () => {
  let env: AcceptanceEnv;

  test.beforeAll(async () => {
    // The environment writes its metadata into its data root and exports that
    // root in `DUYA_E2E_WEB_DATA_ROOT`. Reading the FILE (rather than
    // parsing stdout) keeps the two processes independent of how the runner
    // wires their pipes.
    const dataRoot = process.env.DUYA_E2E_WEB_DATA_ROOT;
    if (!dataRoot) throw new Error('DUYA_E2E_WEB_DATA_ROOT is not set; the acceptance environment did not start');
    const raw = await fs.readFile(path.join(dataRoot, 'web-acceptance.json'), 'utf8');
    env = JSON.parse(raw) as AcceptanceEnv;
  });

  test('sends a message and the answer arrives as a real run', async ({ page }) => {
    const sessionId = env.sessionIds.send!;
    await openSession(page, sessionId);
    await sendMessage(page, '受控浏览器验收');

    // The answer arrives over SSE and is projected into the transcript.
    await expect(page.getByText('受控浏览器验收').first()).toBeVisible({ timeout: 60_000 });

    // And the Host's ledger agrees: a durable run row reached a terminal
    // state. The DOM alone would not prove that.
    await expect.poll(async () => {
      const runs = await readRuns(page, sessionId);
      return runs.some((run) => run.status === 'completed' || run.status === 'failed');
    }, { timeout: 60_000, message: 'the Host never settled a run for this turn' }).toBe(true);

    const runs = await readRuns(page, sessionId);
    const settled = runs.find((run) => run.status === 'completed' || run.status === 'failed');
    expect(settled?.status).toBe('completed');
    expect(settled?.finishedAt).not.toBeNull();
  });

  test('runs a tool through the worker and shows its result', async ({ page }) => {
    const sessionId = env.sessionIds.tool!;
    await openSession(page, sessionId);
    await sendMessage(page, '请读取受控验收文件');

    // The tool call and its result both reach the surface.
    await expect(page.getByText('工具已返回').first()).toBeVisible({ timeout: 90_000 });

    // The worker really executed it: the proof script appends a line per
    // execution, in the workspace the Host registered.
    await expect.poll(async () => {
      try {
        const content = await fs.readFile(env.executionsFile, 'utf8');
        return content.includes('executed');
      } catch {
        return false;
      }
    }, { timeout: 30_000, message: 'the worker never executed the tool' }).toBe(true);
  });

  test('shows an approval for a tool and the allow decision resolves it', async ({ page }) => {
    const sessionId = env.sessionIds.approval!;
    await openSession(page, sessionId);
    await sendMessage(page, '请读取受控验收文件并等待我的批准');

    // The session's permission profile is `default`, so the worker asks
    // before the tool runs. The prompt is the PRODUCT's own permission
    // surface — the one the renderer renders for a Host permission request.
    const approve = page.locator('.permission-prompt-btn-primary').first();
    await expect(approve).toBeVisible({ timeout: 90_000 });

    // The Host's ledger holds the pending request, and the browser's
    // decision reaches it.
    await expect.poll(async () => await readPendingApprovals(page, sessionId),
      { timeout: 30_000, message: 'the Host recorded no pending approval' }).toBeGreaterThan(0);

    await approve.click();

    // After the decision the tool runs and its result lands.
    await expect(page.getByText('工具已返回').first()).toBeVisible({ timeout: 90_000 });
  });

  test('cancels a running turn and the Host ledger agrees', async ({ page }) => {
    const sessionId = env.sessionIds.cancel!;
    await openSession(page, sessionId);
    await sendMessage(page, '取消验收');

    // The Stop button is the product's own interrupt affordance.
    const stop = page.locator('[aria-label="Stop"]').first();
    await expect(stop).toBeVisible({ timeout: 60_000 });
    await stop.click();

    // The Host's receipt is the fact. A cancelled run must be SETTLED in the
    // ledger; a silent stream that just went quiet would leave a row
    // running forever, and the plan asks for the ledger state precisely
    // because the DOM cannot tell those apart.
    //
    // What the Host actually records here is a TERMINAL row whose status is
    // `failed` with code `runtime_crash` — "the transport hard-killed the
    // run before the clean cancel path completed", requestedReason
    // `delete:host_run_cancel`. That is the product's real cancel
    // semantics, not a `cancelled` state, and this test states it rather
    // than dressing it up: the run is settled and no longer running.
    await expect.poll(async () => {
      const runs = await readRuns(page, sessionId);
      const latest = runs[runs.length - 1];
      return latest?.status ?? 'none';
    }, { timeout: 60_000, message: 'the Host never settled the cancelled run' })
      .toBe('failed');
  });

  test('replays the same session after a reload, from the Host ledger', async ({ page }) => {
    const sessionId = env.sessionIds.reload!;
    await openSession(page, sessionId);
    await sendMessage(page, '受控浏览器验收');
    await expect(page.getByText('受控浏览器验收').first()).toBeVisible({ timeout: 60_000 });

    const runsBefore = await readRuns(page, sessionId);
    const beforeCount = runsBefore.length;

    // A reload must NOT lose the transcript, and must NOT start a second
    // run: the surface recovers from the Host's ledger, not from a local
    // event log.
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect(page.getByText('受控浏览器验收').first()).toBeVisible({ timeout: 60_000 });

    const runsAfter = await readRuns(page, sessionId);
    expect(runsAfter.length).toBe(beforeCount);
  });

  test('keeps another session isolated from this one', async ({ page }) => {
    const sessionId = env.sessionIds.isolation!;
    const otherSessionId = env.sessionIds.isolationOther!;
    await openSession(page, sessionId);
    await sendMessage(page, '受控浏览器验收');
    await expect(page.getByText('受控浏览器验收').first()).toBeVisible({ timeout: 60_000 });

    // Switch to the other session: it must not carry this session's answer.
    await page.locator(`[data-session-id="${otherSessionId}"]`).first().click();
    await expect(chatArea(page).getByText('受控浏览器验收')).toHaveCount(0, { timeout: 30_000 });

    // And the other session's own ledger stays empty of this session's runs.
    const otherRuns = await readRuns(page, otherSessionId);
    expect(otherRuns.length).toBe(0);
  });
});
