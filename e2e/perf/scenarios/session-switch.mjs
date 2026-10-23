/**
 * e2e/perf/scenarios/session-switch.mjs — opening and switching heavy chats.
 *
 * The fixtures `perf/session-100`, `perf/session-1000` and `perf/session-10000`
 * are three sizes of the same conversation shape. For each size the harness
 * seeds TWO sessions of that size, restores one of them at boot, and then
 * switches to the other one by CLICKING its row in the sidebar — the
 * product's own navigation, not a store poke.
 *
 * MEASURED
 *
 *   session.open_ms          the click -> the new transcript is on screen
 *   session.boot.render_ms   process start -> the restored transcript is on
 *                            screen (the "reopen my last chat" number)
 *   scroll.frame.p95_ms      the frame p95 while the transcript is scrolled
 *
 * The "on screen" signal is the LAST message of the fixture appearing in the
 * DOM with its `data-message-id`; the message list renders its trailing rows
 * unconditionally, so this is a real paint signal and not a store signal.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closePerfElectron,
  launchPerfElectron,
  readProcessStartMs,
  seedSession,
  restoreSession,
  userDataRootFor,
  waitForAppReady,
} from '../lib/launch.mjs';
import { installCollector, readCollector, resetCollector } from '../lib/collector.mjs';
import { buildSessionMessages, fixtureDigest } from '../lib/fixtures.mjs';
import {
  clickSidebarThread,
  describeSidebar,
  showWorkTab,
  snapshotToMetrics,
} from '../lib/scenario-kit.mjs';
import { round } from '../lib/metrics.mjs';

const FIXTURES = ['perf/session-100', 'perf/session-1000', 'perf/session-10000'];

/** Wait until a specific message row is painted. */
async function waitForMessageRow(page, messageId, timeoutMs = 120_000) {
  await page.waitForFunction(
    (id) => Boolean(document.querySelector(`[data-message-id="${id}"]`)),
    messageId,
    { timeout: timeoutMs, polling: 'raf' },
  );
}

/**
 * Scroll the transcript in steps and report the frame times of that scroll.
 *
 * The scroll runs inside the page on its own animation frames, so the frame
 * intervals it produces are the frames the user would actually see.
 */
async function scrollTranscript(page, steps = 40) {
  return page.evaluate(async (stepCount) => {
    const list = document.querySelector('.message-list-scroll');
    if (!list) return { ok: false, reason: 'no .message-list-scroll in the document' };
    const frames = [];
    let last = null;
    const tick = (t) => {
      if (last !== null) frames.push(t - last);
      last = t;
      if (frames.length < stepCount) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
    const max = Math.max(0, list.scrollHeight - list.clientHeight);
    for (let i = 0; i < stepCount; i += 1) {
      list.scrollTop = Math.round((max * i) / Math.max(1, stepCount - 1));
      list.dispatchEvent(new Event('scroll'));
      await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    const clean = frames.filter((value) => value > 0 && value < 2000);
    clean.sort((a, b) => a - b);
    const at = (p) =>
      clean.length === 0
        ? null
        : clean[Math.min(clean.length - 1, Math.round((clean.length - 1) * p))];
    return {
      ok: true,
      frames: clean.length,
      p50: at(0.5),
      p95: at(0.95),
      max: clean.length > 0 ? clean[clean.length - 1] : null,
      scrollHeight: list.scrollHeight,
    };
  }, steps);
}

export default {
  id: 'session-switch',
  title: 'Opening and switching sessions with large transcripts',
  fixture: FIXTURES.join(', '),

  async run(ctx) {
    const samples = [];
    const notes = {};

    for (const fixtureId of FIXTURES) {
      const messages = buildSessionMessages(fixtureId);
      const digest = fixtureDigest(fixtureId);
      notes[fixtureId] = { digest, messageCount: messages.length };

      for (let index = 0; index < ctx.options.samples; index += 1) {
        const namespace = `switch-${fixtureId.replace(/[^a-z0-9]+/gi, '-')}-${ctx.runId}-${index}`;
        const sessionA = `perf-a-${ctx.runId}-${index}`;
        const sessionB = `perf-b-${ctx.runId}-${index}`;
        const titleA = `perf-a-${index}`;
        const titleB = `perf-b-${index}`;
        const workspace = path.join(userDataRootFor(namespace), 'workspace');
        fs.mkdirSync(workspace, { recursive: true });

        // --- seed ------------------------------------------------------
        const seed = await launchPerfElectron({ namespace });
        await waitForAppReady(seed.page);
        await seedSession(seed.page, {
          sessionId: sessionA,
          title: titleA,
          workingDirectory: workspace,
          messages,
        });
        await seedSession(seed.page, {
          sessionId: sessionB,
          title: titleB,
          workingDirectory: workspace,
          messages,
        });
        await restoreSession(seed.page, { activeThreadId: sessionA, currentView: 'chat' });
        await closePerfElectron(seed.app);

        // --- measure ---------------------------------------------------
        const measured = await launchPerfElectron({ namespace });
        const processStart = readProcessStartMs(measured.app) ?? ctx.launchMark;
        await waitForAppReady(measured.page);
        await installCollector(measured.page);
        await measured.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(measured.page);

        const lastMessageId = messages[messages.length - 1].id;
        try {
          await waitForMessageRow(measured.page, lastMessageId);
          const bootDetectedAt = Date.now();
          // The document's own time origin is the start of THIS renderer
          // load; the process start is the start of the whole app. Both are
          // reported.
          const documentStart = await measured.page.evaluate(() => performance.timeOrigin);
          const bootRenderMs = bootDetectedAt - documentStart;

          await showWorkTab(measured.page);
          const sidebar = await describeSidebar(measured.page);

          // The boot is measured on its own; the switch starts from a clean
          // counter so the two do not share a window.
          const bootSnapshot = await readCollector(measured.page);
          await resetCollector(measured.page);

          const switchStartedAt = Date.now();
          await clickSidebarThread(measured.page, titleB);
          await waitForMessageRow(measured.page, lastMessageId);
          const switchMs = Date.now() - switchStartedAt;

          const scroll = await scrollTranscript(measured.page);
          const snapshot = await readCollector(measured.page);

          samples.push({
            index: samples.length,
            metrics: {
              'session.boot.render_ms': round(bootRenderMs),
              'session.boot.fromProcessStart_ms': round(bootDetectedAt - processStart),
              'session.boot.commit.count': bootSnapshot?.mutationBatches ?? null,
              'session.boot.dom.nodes': bootSnapshot?.domNodes ?? null,
              'session.boot.longtask.total_ms': round(
                (bootSnapshot?.longTasks ?? []).reduce((sum, task) => sum + task.duration, 0),
              ),
              'session.open_ms': round(switchMs),
              'scroll.frame.p95_ms': round(scroll.p95),
              'scroll.frame.p50_ms': round(scroll.p50),
              'scroll.frame.max_ms': round(scroll.max),
              ...snapshotToMetrics(snapshot, {
                'session.fixture.messages': messages.length,
              }),
            },
            observed: {
              fixture: fixtureId,
              fixtureDigest: digest,
              namespace,
              sessionA,
              sessionB,
              sidebar,
              scroll,
            },
            error: null,
          });

          ctx.log(
            `session-switch ${fixtureId} sample ${index}: `
              + `open=${switchMs}ms boot=${bootRenderMs}ms scrollP95=${scroll.p95}ms`,
          );
        } catch (error) {
          // One sample that cannot navigate must not take the whole scenario
          // down: the evidence is recorded and the next sample runs.
          const sidebar = await describeSidebar(measured.page).catch(() => null);
          samples.push({
            index: samples.length,
            metrics: {},
            observed: { fixture: fixtureId, fixtureDigest: digest, namespace, sidebar },
            error: String(error?.message ?? error),
          });
          ctx.log(`session-switch ${fixtureId} sample ${index} failed: ${error?.message}`);
        }
      }
    }

    return {
      samples,
      notes: {
        fixtures: notes,
        navigation:
          'the switch is a click on the session row in the sidebar (div.thread-item), '
          + 'not a store poke',
        onScreenSignal: 'the last fixture message row appearing in the DOM',
      },
    };
  },
};
