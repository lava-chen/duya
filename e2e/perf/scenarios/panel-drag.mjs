/**
 * e2e/perf/scenarios/panel-drag.mjs — dragging the panel edge and the wall
 * separators.
 *
 * The panel wall has two kinds of drag handle:
 *
 *   - the OUTER EDGE (`.resize-handle-left`): it moves the whole panel
 *     region, so the chat column next to it re-lays out on every frame;
 *   - the WALL SEPARATOR (`.panel-wall-separator-column`): it moves the
 *     boundary between two columns inside the wall, so the wall's layout
 *     ratios change on every frame.
 *
 * Both are dragged the way a user drags them: real mouse events on the real
 * handle, one step per animation frame.
 *
 * MEASURED
 *
 *   panel.drag.edge.ms          the wall time of the edge drag
 *   panel.drag.edge.frames      the animation frames the drag took
 *   panel.drag.edge.frame.p95   the p95 frame interval during the drag
 *   panel.drag.edge.longtask.*  the long tasks the drag caused
 *   panel.drag.edge.commit      the render commits the drag caused
 *   panel.drag.edge.storage     the localStorage WRITES during the drag
 *   panel.drag.edge.storage.bytes  how many bytes were written
 *
 * The storage counters are the deterministic half of the measurement: a drag
 * is a transient gesture, so the state it produces is persisted once, at the
 * end of the gesture. A drag that writes to localStorage on every frame pays
 * a synchronous disk-backed write per frame, and that is not a number that
 * moves with the machine -- it is a number that is wrong.
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
import { openSeededSession, snapshotToMetrics, startResourceProbe } from '../lib/scenario-kit.mjs';
import { round, frameIntervals, percentile } from '../lib/metrics.mjs';

const FIXTURE_ID = 'perf/session-100';

/**
 * How many sessions the sidebar holds while the drag is measured.
 *
 * A real profile has hundreds of sessions (the machine this was measured on
 * has 739), and the sidebar is the largest consumer of the panel context:
 * a drag that re-renders the context re-renders every session row in it. A
 * sidebar with two rows cannot show what that costs.
 */
const SIDEBAR_SESSIONS = 500;

/**
 * Count the localStorage writes of the page.
 *
 * `Storage.prototype.setItem` is what the app calls, so patching the
 * prototype catches every write no matter which key it goes to. The counters
 * live on the page, so they survive the reload as long as the patch is
 * installed as an init script.
 */
const STORAGE_COUNTER_SOURCE = `
(() => {
  const counters = { writes: 0, bytes: 0, removals: 0 };
  const proto = window.Storage && window.Storage.prototype;
  if (!proto) return;
  const originalSet = proto.setItem;
  const originalRemove = proto.removeItem;
  proto.setItem = function patchedSetItem(key, value) {
    counters.writes += 1;
    counters.bytes += String(value == null ? '' : value).length;
    return originalSet.call(this, key, value);
  };
  proto.removeItem = function patchedRemoveItem(key) {
    counters.removals += 1;
    return originalRemove.call(this, key);
  };
  Object.defineProperty(window, '__duyaPerfStorage', {
    configurable: true,
    get() { return counters; },
  });
})();
`;

/** The handles the wall currently offers. */
async function readHandles(page) {
  return page.evaluate(() => {
    const rect = (element) => {
      if (!element) return null;
      const box = element.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    };
    const edge = document.querySelector('.resize-handle-left');
    const separator = document.querySelector('.panel-wall-separator-column .resize-handle');
    return {
      edge: rect(edge),
      separator: rect(separator),
      wallColumns: document.querySelectorAll('.panel-wall-separator-column').length,
      openPanels: document.querySelectorAll('.panel-card').length,
      threadRows: document.querySelectorAll('div.thread-item').length,
    };
  });
}

/** The storage counters, read back from the page. */
async function readStorage(page) {
  return page.evaluate(() => {
    const counters = window.__duyaPerfStorage;
    if (!counters) return null;
    return { writes: counters.writes, bytes: counters.bytes, removals: counters.removals };
  });
}

/**
 * Drag a handle from its centre by `distance` pixels, one step per frame.
 *
 * The steps are paced by the animation frame clock of the page, because that
 * is the clock the product's own rAF throttle runs on: a drag that fires
 * faster than the frames would measure the throttle, not the drag.
 */
async function dragHandle(page, box, distance, steps = 40) {
  const startX = box.x + box.width / 2;
  const startY = box.y + box.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  const stepSize = distance / steps;
  for (let step = 0; step < steps; step += 1) {
    await page.mouse.move(startX + stepSize * (step + 1), startY);
    await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
  }
  await page.mouse.up();
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => resolve(null))));
}

/**
 * Fill the sidebar with sessions.
 *
 * The sidebar is the expensive part of a drag: it is a consumer of the panel
 * context, so a drag that re-renders the context re-renders every session
 * row in it. A real profile has hundreds of sessions, and a sidebar with two
 * rows cannot show what that costs.
 */
async function seedSessionList(page, count, prefix) {
  return page.evaluate(
    async (input) => {
      const api = window.electronAPI;
      let created = 0;
      for (let index = 0; index < input.count; index += 1) {
        // No working directory: the session lands in the "no project" group,
        // which the sidebar always shows. A session with its own project would
        // need a project group of its own to be visible.
        await api.thread.create({
          id: `${input.prefix}-${index}`,
          title: `${input.prefix} ${index}`,
        });
        created += 1;
      }
      return created;
    },
    { count, prefix },
  );
}

/** Open panels through the product's own launcher row. */
async function openPanels(page, pageIds) {
  const opened = [];
  for (const pageId of pageIds) {
    const button = page.locator(`.titlebar-panel-launcher[data-page-id="${pageId}"]`).first();
    if ((await button.count()) === 0) {
      opened.push(`${pageId}:missing`);
      continue;
    }
    if (await button.isDisabled().catch(() => true)) {
      opened.push(`${pageId}:unavailable`);
      continue;
    }
    await button.click({ timeout: 20_000 }).catch(() => undefined);
    await page
      .waitForTimeout(500)
      .catch(() => undefined);
    opened.push(`${pageId}:clicked`);
  }
  return opened;
}

export default {
  id: 'panel-drag',
  title: 'Dragging the panel edge and the wall separators',
  fixture: FIXTURE_ID,

  async run(ctx) {
    const samples = [];
    const notes = {};
    const digest = fixtureDigest(FIXTURE_ID);
    const panelIds = (ctx.options.panelIds ?? 'workspace,terminal').split(',');

    for (let index = 0; index < ctx.options.samples; index += 1) {
      const namespace = `panel-drag-${ctx.runId}-${index}`;
      const sessionId = `perf-drag-${ctx.runId}-${index}`;
      const title = `perf drag ${index}`;
      const workspace = path.join(userDataRootFor(namespace), 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'perf-fixture.txt'), 'perf fixture\n', 'utf8');
      const transcript = buildSessionMessages(FIXTURE_ID, { idPrefix: sessionId });

      const measured = await launchPerfElectron({ namespace });
      await waitForAppReady(measured.page);
      await measured.page.addInitScript({ content: STORAGE_COUNTER_SOURCE }).catch(() => undefined);
      await seedSession(measured.page, {
        sessionId,
        title,
        workingDirectory: workspace,
        messages: transcript,
      });
      await wakeConversationStore(measured.app, measured.page);
      await installCollector(measured.page);
      await measured.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(measured.page);
      await wakeConversationStore(measured.app, measured.page);
      await openSeededSession(measured.page, {
        title,
        lastMessageId: transcript[transcript.length - 1].id,
      });

      // The sidebar is filled with sessions first: the drag re-renders the
      // consumers of the panel context, and the sidebar is the biggest one.
      const sidebarSessions = SIDEBAR_SESSIONS;
      const seededSessions = sidebarSessions > 0
        ? await seedSessionList(measured.page, sidebarSessions, `perf-list-${index}`)
        : 0;
      // The store has to learn about the new sessions before the sidebar can
      // show them: the seed writes through the bridge, and the store learns
      // about a session list through the product's own sync event.
      if (seededSessions > 0) {
        await wakeConversationStore(measured.app, measured.page);
      }
      await measured.page.waitForTimeout(1000);

      const opened = await openPanels(measured.page, panelIds);
      await measured.page.waitForTimeout(1000);

      const handlesBefore = await readHandles(measured.page);
      const probe = await startResourceProbe(measured.page);

      // --- the outer edge ------------------------------------------------
      let edge = null;
      if (handlesBefore.edge) {
        await resetCollector(measured.page);
        const storageBefore = await readStorage(measured.page);
        const startedAt = Date.now();
        await dragHandle(measured.page, handlesBefore.edge, -180);
        const elapsedMs = Date.now() - startedAt;
        const snapshot = await readCollector(measured.page);
        const storageAfter = await readStorage(measured.page);
        edge = {
          ms: elapsedMs,
          snapshot,
          storageWrites: (storageAfter?.writes ?? 0) - (storageBefore?.writes ?? 0),
          storageBytes: (storageAfter?.bytes ?? 0) - (storageBefore?.bytes ?? 0),
        };
      }

      // --- the wall separator --------------------------------------------
      const handlesNow = await readHandles(measured.page);
      let separator = null;
      if (handlesNow.separator) {
        await resetCollector(measured.page);
        const storageBefore = await readStorage(measured.page);
        const startedAt = Date.now();
        await dragHandle(measured.page, handlesNow.separator, -120);
        const elapsedMs = Date.now() - startedAt;
        const snapshot = await readCollector(measured.page);
        const storageAfter = await readStorage(measured.page);
        separator = {
          ms: elapsedMs,
          snapshot,
          storageWrites: (storageAfter?.writes ?? 0) - (storageBefore?.writes ?? 0),
          storageBytes: (storageAfter?.bytes ?? 0) - (storageBefore?.bytes ?? 0),
        };
      }

      const resource = await probe.stop();
      const handlesAfter = await readHandles(measured.page);

      samples.push({
        index,
        metrics: {
          'panel.drag.edge.ms': edge ? round(edge.ms) : null,
          'panel.drag.edge.storage.writes': edge ? edge.storageWrites : null,
          'panel.drag.edge.storage.bytes': edge ? edge.storageBytes : null,
          'panel.drag.separator.ms': separator ? round(separator.ms) : null,
          'panel.drag.separator.storage.writes': separator ? separator.storageWrites : null,
          'panel.drag.separator.storage.bytes': separator ? separator.storageBytes : null,
          ...(edge ? snapshotToMetrics(edge.snapshot, {}) : {}),
          ...(separator
            ? {
                'panel.drag.separator.frame.p95_ms': round(
                  percentile(frameIntervals(separator.snapshot?.frames ?? []), 0.95),
                ),
                'panel.drag.separator.longtask.total_ms': round(
                  (separator.snapshot?.longTasks ?? []).reduce((sum, task) => sum + task.duration, 0),
                ),
                'panel.drag.separator.commit.count': separator.snapshot?.mutationBatches ?? null,
              }
            : {}),
          ...resource,
        },
        observed: {
          fixture: FIXTURE_ID,
          fixtureDigest: digest,
          namespace,
          sessionId,
          seededSessions,
          opened,
          handlesBefore,
          handlesAfter,
          edgeSnapshot: edge?.snapshot ?? null,
          separatorSnapshot: separator?.snapshot ?? null,
          consoleErrors: measured.consoleErrors.slice(0, 5),
          pageErrors: measured.pageErrors.slice(0, 5),
        },
        error: null,
      });

      await closePerfElectron(measured.app);
      ctx.log(
        `panel-drag sample ${index}: edge=${edge ? `${edge.ms}ms storage=${edge.storageWrites}` : 'no-handle'} `
          + `separator=${separator ? `${separator.ms}ms storage=${separator.storageWrites}` : 'no-handle'}`,
      );
    }

    return {
      samples,
      notes: {
        fixture: FIXTURE_ID,
        fixtureDigest: digest,
        panelIds,
        drag:
          'the handles are dragged with real mouse events, one step per animation frame, '
          + 'on the handles the wall itself renders',
        storage:
          'the localStorage writes are counted in the page, by patching Storage.prototype, '
          + 'so the number is the product\'s own writes and not an estimate',
      },
    };
  },
};
