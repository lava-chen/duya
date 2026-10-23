/**
 * e2e/perf/scenarios/startup.mjs — how long until the app is usable.
 *
 * WHAT IS MEASURED
 *
 *   startup.firstPaint_ms   process start -> first contentful paint
 *   startup.typeable_ms     process start -> the composer accepts keys
 *
 * The process start is read from the OS process table, not from the
 * harness, because the spawn happens inside `electron.launch()` and the
 * harness can only bracket it.
 *
 * THE PROFILE UNDER MEASUREMENT
 *
 * The measured boot is the boot of a profile that a user would recognise:
 * the onboarding wizard is done, one project is registered, and one
 * session exists in the sidebar. The profile is prepared in an earlier
 * launch (the product's own IPC does the seeding), and the MEASURED launch
 * is the first one that sees it. That matters for the composer: the
 * welcome view only enables the composer once a project is known, so a
 * profile with no project would report "no typeable composer" and measure
 * nothing.
 *
 * The measured boot lands on the welcome screen. The app is not asked to
 * restore a session across the restart: the boot splash of this build
 * cannot resolve a session the worker does not know (the splash stays on
 * "Preparing session…" and the transcript never renders), so the harness
 * measures the heavy-transcript journey where it is reachable — opening
 * and switching a seeded session — in the `session-switch` scenario.
 *
 * THE TWO BOOTS
 *
 * The in-page collector cannot cover the FIRST load (an init script only
 * reaches the next document), so the boot is measured twice: once on the
 * first load — process start basis, no instrumentation — and once on an
 * instrumented reload, which yields the precise document-relative numbers
 * (paint, composer readiness, long tasks, frame times). Both are reported,
 * under different names.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closePerfElectron,
  completeOnboarding,
  launchPerfElectron,
  readChatViewState,
  readPaintTiming,
  readProcessStartMs,
  readRenderedMessageCount,
  seedSession,
  userDataRootFor,
  waitForAppReady,
  waitForTypeable,
} from '../lib/launch.mjs';
import { installCollector, readCollector } from '../lib/collector.mjs';
import { buildSessionMessages, fixtureDigest } from '../lib/fixtures.mjs';
import { snapshotToMetrics } from '../lib/scenario-kit.mjs';
import { round } from '../lib/metrics.mjs';

const FIXTURE_ID = 'perf/session-100';

export default {
  id: 'startup',
  title: 'Electron process start to a usable composer',
  fixture: FIXTURE_ID,

  async run(ctx) {
    const samples = [];
    const digest = fixtureDigest(FIXTURE_ID);

    for (let index = 0; index < ctx.options.samples; index += 1) {
      const namespace = `startup-${ctx.runId}-${index}`;
      const sessionId = `perf-startup-${ctx.runId}-${index}`;
      const workspace = path.join(userDataRootFor(namespace), 'workspace');
      fs.mkdirSync(workspace, { recursive: true });

      // --- prepare ------------------------------------------------------
      // The onboarding wizard covers the shell, so the flag is set first.
      // The session is seeded through the product's own IPC, which also
      // registers the project the welcome view needs for its composer.
      const prepare = await launchPerfElectron({ namespace });
      await waitForAppReady(prepare.page);
      await completeOnboarding(prepare.page);
      const messages = buildSessionMessages(FIXTURE_ID, { idPrefix: sessionId });
      await seedSession(prepare.page, {
        sessionId,
        title: `perf startup ${index}`,
        workingDirectory: workspace,
        messages,
      });
      await closePerfElectron(prepare.app);

      // --- the measured boot --------------------------------------------
      const measured = await launchPerfElectron({ namespace });
      const processStart = readProcessStartMs(measured.app) ?? ctx.launchMark;
      await waitForAppReady(measured.page);
      const typeable = await waitForTypeable(measured.page);
      const paint = await readPaintTiming(measured.page);
      const chatState = await readChatViewState(measured.page);
      const renderedRows = await readRenderedMessageCount(measured.page);

      // The instrumented reload: the same boot path, this time observed from
      // inside the document.
      await installCollector(measured.page);
      await measured.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(measured.page);
      const reloadTypeable = await waitForTypeable(measured.page);
      const bootSnapshot = await readCollector(measured.page);
      const reloadPaint = await readPaintTiming(measured.page);

      const metrics = {
        // The contract's names.
        'startup.firstPaint_ms': round(
          paint.timeOrigin + (paint.firstContentfulPaintMs ?? 0) - processStart,
        ),
        'startup.typeable_ms':
          typeable.found && typeable.detectedAt !== null
            ? round(typeable.detectedAt - processStart)
            : null,
        'startup.domContentLoaded_ms': round(
          paint.timeOrigin + (paint.domContentLoadedMs ?? 0) - processStart,
        ),
        'startup.reload.firstPaint_ms': round(reloadPaint.firstContentfulPaintMs),
        // Document-relative: the collector sees the composer become editable
        // inside the page, so the number needs no external clock.
        'startup.reload.typeable_ms': round(bootSnapshot?.composerReadyAt ?? null),
        ...snapshotToMetrics(bootSnapshot, {
          'startup.reload.dom.nodes': bootSnapshot?.domNodes ?? null,
        }),
      };

      samples.push({
        index,
        metrics,
        observed: {
          namespace,
          fixture: FIXTURE_ID,
          fixtureDigest: digest,
          sessionId,
          processStart,
          chatState,
          renderedRows,
          typeable: typeable.evidence ?? { found: typeable.found },
          reloadTypeable: reloadTypeable.evidence ?? { found: reloadTypeable.found },
          collectorInstalledAt: bootSnapshot?.installedAt ?? null,
          collectorTimeOrigin: bootSnapshot?.timeOrigin ?? null,
          consoleErrors: measured.consoleErrors.slice(0, 5),
          pageErrors: measured.pageErrors.slice(0, 5),
        },
        error: null,
      });

      await closePerfElectron(measured.app);
      ctx.log(`startup sample ${index}: ${JSON.stringify(metrics)}`);
    }

    return {
      samples,
      notes: {
        fixture: FIXTURE_ID,
        fixtureDigest: digest,
        profile:
          'the measured boot is a profile with the onboarding done, one project registered and '
          + 'one session in the sidebar — the state a user recognises as "my Duya"',
        typeable:
          'the composer is only enabled once the welcome view knows a project, so the profile '
          + 'is prepared before the measured boot',
        typeableBasis:
          'the composer is detected by a requestAnimationFrame poll from the harness, and the '
          + 'boot splash (.duya-startup-landing) must be gone as well — the welcome view is '
          + 'rendered behind that overlay, and its composer is editable while the overlay is up',
        instrumentedBoot:
          'the *.reload.* metrics come from an instrumented reload of the same boot path, '
          + 'because an init script cannot reach the first document',
        crossRestartRestore:
          'the app is NOT asked to restore a session across the restart: in this build the '
          + 'boot splash cannot resolve a session the worker does not know (it stays on '
          + '"Preparing session…" and the transcript never renders), so the heavy-transcript '
          + 'journey is measured as an in-run navigation in the session-switch scenario',
      },
    };
  },
};
