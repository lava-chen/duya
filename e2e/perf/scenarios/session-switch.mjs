/**
 * e2e/perf/scenarios/session-switch.mjs — opening and switching heavy chats.
 *
 * The fixtures `perf/session-100`, `perf/session-1000` and `perf/session-10000`
 * are three sizes of the same conversation shape. For each size the harness
 * seeds TWO sessions of that size through the product's own IPC and then
 * navigates between them the way a user does: by CLICKING their rows in the
 * sidebar — not by poking the store.
 *
 * MEASURED
 *
 *   session.open_ms          the click -> the new transcript is on screen
 *   session.switch_ms        the same, for the second session
 *   scroll.frame.p95_ms      the frame p95 while the transcript is scrolled
 *   commit.count / dom.nodes / longtask.*   the cost of that render
 *
 * The "on screen" signal is the LAST message of the fixture appearing in the
 * DOM with its `data-message-id`; the message list renders its trailing rows
 * unconditionally, so this is a real paint signal and not a store signal.
 *
 * WHY THE NAVIGATION IS IN ONE RUN
 *
 * The harness does not restore a session across a restart: in this build the
 * boot splash cannot resolve a session the worker does not know, so a
 * restored session never renders. Everything here therefore happens in one
 * app run, which is also the journey the numbers describe: open a heavy
 * chat, switch to another heavy chat, scroll it.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closePerfElectron,
  launchPerfElectron,
  seedSession,
  userDataRootFor,
  waitForAppReady,
  wakeConversationStore,
} from '../lib/launch.mjs';
import { installCollector, readCollector, resetCollector } from '../lib/collector.mjs';
import { buildSessionMessages, fixtureDigest } from '../lib/fixtures.mjs';
import {
  clickSidebarThread,
  describeSidebar,
  showWorkTab,
  signalBudgetMs,
  snapshotToMetrics,
  startResourceProbe,
} from '../lib/scenario-kit.mjs';
import { round } from '../lib/metrics.mjs';

const FIXTURES = ['perf/session-100', 'perf/session-1000', 'perf/session-10000'];

/** Wait until a specific message row is painted. */
async function waitForMessageRow(page, messageId, timeoutMs) {
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
      const digest = fixtureDigest(fixtureId);
      notes[fixtureId] = {
        digest,
        messageCount: buildSessionMessages(fixtureId).length,
        signalBudgetMs: signalBudgetMs(buildSessionMessages(fixtureId).length),
      };

      for (let index = 0; index < ctx.options.samples; index += 1) {
        const namespace = `switch-${fixtureId.replace(/[^a-z0-9]+/gi, '-')}-${ctx.runId}-${index}`;
        const sessionA = `perf-a-${ctx.runId}-${index}`;
        const sessionB = `perf-b-${ctx.runId}-${index}`;
        const titleA = `perf-a-${index}`;
        const titleB = `perf-b-${index}`;
        const workspace = path.join(userDataRootFor(namespace), 'workspace');
        fs.mkdirSync(workspace, { recursive: true });

        // The row ids are namespaced per session: the transcript store appends
        // with INSERT OR IGNORE on the message id, so the SAME fixture seeded
        // into two sessions of one database would leave the second one empty.
        const messagesA = buildSessionMessages(fixtureId, { idPrefix: sessionA });
        const messagesB = buildSessionMessages(fixtureId, { idPrefix: sessionB });
        // The budget of the "on screen" signal follows the size of the
        // transcript: the data path of the largest fixture is slow on a busy
        // machine, and a sample that times out is not a measurement.
        const budget = signalBudgetMs(messagesA.length);

        const measured = await launchPerfElectron({ namespace });
        await waitForAppReady(measured.page);
        await seedSession(measured.page, {
          sessionId: sessionA,
          title: titleA,
          workingDirectory: workspace,
          messages: messagesA,
        });
        await seedSession(measured.page, {
          sessionId: sessionB,
          title: titleB,
          workingDirectory: workspace,
          messages: messagesB,
        });
        // The app syncs itself, so the sidebar lists the two sessions and the
        // store persists the state the instrumented reload will hydrate from.
        await wakeConversationStore(measured.app, measured.page);

        // The collector is installed before the reload, so the instrumented
        // document covers the whole navigation.
        await installCollector(measured.page);
        await measured.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(measured.page);
        // The reloaded document does not hydrate on its own either (the same
        // store defect), so the app is told to sync itself before the
        // navigation is measured. This is setup: the collector is reset
        // again right before the measured click.
        await wakeConversationStore(measured.app, measured.page);
        await showWorkTab(measured.page);

        const lastIdA = messagesA[messagesA.length - 1].id;
        const lastIdB = messagesB[messagesB.length - 1].id;

        try {
          const sidebar = await describeSidebar(measured.page);

          // --- open the first heavy chat --------------------------------
          const probe = await startResourceProbe(measured.page);
          const openStartedAt = Date.now();
          await clickSidebarThread(measured.page, titleA);
          await waitForMessageRow(measured.page, lastIdA, budget);
          const openMs = Date.now() - openStartedAt;
          const openSnapshot = await readCollector(measured.page);
          await resetCollector(measured.page);

          // --- switch to the second one ----------------------------------
          const switchStartedAt = Date.now();
          await clickSidebarThread(measured.page, titleB);
          await waitForMessageRow(measured.page, lastIdB, budget);
          const switchMs = Date.now() - switchStartedAt;
          const switchSnapshot = await readCollector(measured.page);

          const scroll = await scrollTranscript(measured.page);
          const snapshot = await readCollector(measured.page);
          const resource = await probe.stop();

          samples.push({
            index: samples.length,
            metrics: {
              'session.open_ms': round(openMs),
              'session.switch_ms': round(switchMs),
              'session.open.commit.count': openSnapshot?.mutationBatches ?? null,
              'session.open.longtask.total_ms': round(
                (openSnapshot?.longTasks ?? []).reduce((sum, task) => sum + task.duration, 0),
              ),
              'session.switch.commit.count': switchSnapshot?.mutationBatches ?? null,
              'session.switch.longtask.total_ms': round(
                (switchSnapshot?.longTasks ?? []).reduce((sum, task) => sum + task.duration, 0),
              ),
              'scroll.frame.p95_ms': round(scroll.p95),
              'scroll.frame.p50_ms': round(scroll.p50),
              'scroll.frame.max_ms': round(scroll.max),
              ...snapshotToMetrics(snapshot, {
                'session.fixture.messages': messagesA.length,
              }),
              ...resource,
            },
            observed: {
              fixture: fixtureId,
              fixtureDigest: digest,
              namespace,
              sessionA,
              sessionB,
              sidebar,
              scroll,
              signalBudgetMs: budget,
            },
            error: null,
          });

          ctx.log(
            `session-switch ${fixtureId} sample ${index}: `
              + `open=${openMs}ms switch=${switchMs}ms scrollP95=${scroll.p95}ms`,
          );
        } catch (error) {
          // One sample that cannot navigate must not take the whole scenario
          // down: the evidence is recorded and the next sample runs.
          const sidebar = await describeSidebar(measured.page).catch(() => null);
          samples.push({
            index: samples.length,
            metrics: {},
            observed: { fixture: fixtureId, fixtureDigest: digest, namespace, sidebar },
            error: String(error?.stack ?? error?.message ?? error),
          });
          ctx.log(`session-switch ${fixtureId} sample ${index} failed: ${error?.message}`);
        }

        await closePerfElectron(measured.app);
      }
    }

    return {
      samples,
      notes: {
        fixtures: notes,
        fixtureDigest: FIXTURES.map((id) => `${id}:${notes[id].digest}`).join(' '),
        navigation:
          'the sessions are opened and switched by clicking their rows in the sidebar '
          + '(div.thread-item), not by a store poke',
        onScreenSignal: 'the last fixture message row appearing in the DOM',
        signalBudget:
          'the "on screen" signal is given a budget that follows the size of the '
          + 'transcript (60s up to 1000 messages, 240s above), so a slow data path '
          + 'shows up as a slow number instead of a failed sample',
        sameRun:
          'the whole journey happens in one app run: this build cannot restore a session '
          + 'across a restart (the boot splash stays on "Preparing session…"), so the '
          + 'heavy-transcript numbers describe the navigation, not the restart',
      },
    };
  },
};
