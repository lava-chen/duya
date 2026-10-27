/**
 * e2e/perf/scenarios/panels.mjs — several panels, a terminal and an agent
 * session open at the same time.
 *
 * The side panel is opened through the product's own launcher: the empty
 * panel zone renders one row per page it can open, and clicking a row opens
 * that page. The harness clicks rows until several panels are open, records
 * which pages those were (the zone carries `data-page-id`), and measures the
 * cost of opening them and of scrolling the terminal with everything open.
 *
 * Nothing about the panel system is changed; the harness only uses the same
 * affordance a user does.
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
import { round } from '../lib/metrics.mjs';

const FIXTURE_ID = 'perf/session-100';

/** What the panel zone currently shows. */
async function readPanelState(page) {
  return page.evaluate(() => {
    const zone = document.querySelector('[data-page-id]');
    const launcher = Array.from(document.querySelectorAll('.panel-empty-launcher-row'));
    const cards = Array.from(document.querySelectorAll('.panel-card'));
    return {
      zonePresent: Boolean(zone),
      zonePageId: zone ? zone.getAttribute('data-page-id') : null,
      launcherRows: launcher.length,
      launcherTitles: launcher.map((row) => row.getAttribute('title')),
      openPanels: cards.length,
      panelPageIds: cards.map((card) => card.getAttribute('data-pane-id')),
      domNodes: document.getElementsByTagName('*').length,
    };
  });
}

/** How many panels are open. */
async function panelCount(page) {
  return page.evaluate(() => document.querySelectorAll('.panel-card').length);
}

/**
 * Open panels through the product's own launcher row.
 *
 * The chat header carries one launcher button per panel type, and each
 * button carries the page id in `data-page-id` — so the harness asks for a
 * specific page by id instead of by a translated label. Clicking an open
 * type focuses it, clicking a closed one opens it, which is exactly the
 * "several panels at once" state the scenario is about.
 */
async function openPanels(page, pageIds) {
  const opened = [];
  for (const pageId of pageIds) {
    const button = page.locator(`.titlebar-panel-launcher[data-page-id="${pageId}"]`).first();
    const count = await button.count();
    if (count === 0) {
      opened.push(`${pageId}:missing`);
      continue;
    }
    const disabled = await button.isDisabled().catch(() => true);
    if (disabled) {
      opened.push(`${pageId}:unavailable`);
      continue;
    }
    const before = await panelCount(page);
    await button.click({ timeout: 20_000 });
    await page
      .waitForFunction(
        (expected) => document.querySelectorAll('.panel-card').length > expected,
        before,
        { timeout: 20_000 },
      )
      .catch(() => undefined);
    const after = await panelCount(page);
    opened.push(`${pageId}:${after > before ? 'opened' : 'no-change'}`);
  }
  return opened;
}

export default {
  id: 'panels',
  title: 'Several panels, a terminal and an agent session open together',
  fixture: FIXTURE_ID,

  async run(ctx) {
    const samples = [];
    const digest = fixtureDigest(FIXTURE_ID);
    const panelTarget = ctx.options.panels ?? 3;
    const panelIds = (ctx.options.panelIds ?? 'workspace,terminal,browser').split(',');

    for (let index = 0; index < ctx.options.samples; index += 1) {
      const namespace = `panels-${ctx.runId}-${index}`;
      const sessionId = `perf-panels-${ctx.runId}-${index}`;
      const title = `perf panels ${index}`;
      const workspace = path.join(userDataRootFor(namespace), 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      fs.writeFileSync(path.join(workspace, 'perf-fixture.txt'), 'perf fixture\n', 'utf8');
      const transcript = buildSessionMessages(FIXTURE_ID, { idPrefix: sessionId });

      const measured = await launchPerfElectron({ namespace });
      await waitForAppReady(measured.page);
      await seedSession(measured.page, {
        sessionId,
        title,
        workingDirectory: workspace,
        messages: transcript,
      });
      // The app syncs itself, so the sidebar lists the session and the store
      // persists the state the instrumented reload will hydrate from.
      await wakeConversationStore(measured.app, measured.page);
      await installCollector(measured.page);
      await measured.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(measured.page);
      // The reloaded document does not hydrate on its own either (the same
      // store defect), so the app is told to sync itself before the
      // measurement starts.
      await wakeConversationStore(measured.app, measured.page);
      // The chat is open — with an agent session in it — before the panels
      // are opened on top of it.
      await openSeededSession(measured.page, {
        title,
        lastMessageId: transcript[transcript.length - 1].id,
      });

      const before = await readPanelState(measured.page);
      await resetCollector(measured.page);
      const probe = await startResourceProbe(measured.page);
      let opened = [];
      let openError = null;
      const openStartedAt = Date.now();
      try {
        opened = await openPanels(measured.page, panelIds);
      } catch (error) {
        openError = String(error?.message ?? error);
      }
      const openMs = Date.now() - openStartedAt;
      const after = await readPanelState(measured.page);

      // Give the newly mounted panels a moment to settle, then collect.
      await measured.page.waitForTimeout(1500);
      const snapshot = await readCollector(measured.page);
      const resource = await probe.stop();

      samples.push({
        index,
        metrics: {
          'panels.open_ms': round(openMs),
          'panels.open_count': after.openPanels,
          'panels.dom.nodes': after.domNodes,
          ...snapshotToMetrics(snapshot),
          ...resource,
        },
        observed: {
          fixture: FIXTURE_ID,
          fixtureDigest: digest,
          namespace,
          sessionId,
          openedTitles: opened,
          before,
          after,
          openError,
          consoleErrors: measured.consoleErrors.slice(0, 5),
          pageErrors: measured.pageErrors.slice(0, 5),
        },
        error: openError,
      });

      await closePerfElectron(measured.app);
      ctx.log(
        `panels sample ${index}: opened=${after.openPanels} in ${openMs}ms `
          + `(${opened.join(', ')})`,
      );
    }

    return {
      samples,
      notes: {
        fixture: FIXTURE_ID,
        fixtureDigest: digest,
        panelTarget,
        panelIds,
        opening:
          'the panels are opened by clicking the chat header\'s own launcher buttons '
          + '(.titlebar-panel-launcher[data-page-id])',
      },
    };
  },
};
