/**
 * e2e/perf/scenarios/startup.mjs — how long until the app is usable.
 *
 * TWO KINDS OF BOOT, BOTH REPORTED
 *
 *   cold  a fresh namespace: no database, no sessions. The app comes up on
 *         the welcome screen. This is the "user starts Duya" number.
 *   warm  a namespace seeded with the `perf/session-100` fixture and the
 *         session restored through the product's own persistence, so the
 *         app comes up straight into a chat. This is the "user reopens
 *         their last session" number, and it is the one the other agents
 *         change, because it includes loading a transcript.
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
  launchPerfElectron,
  readChatViewState,
  readPaintTiming,
  readProcessStartMs,
  readRenderedMessageCount,
  restoreSession,
  seedSession,
  setRendererState,
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
    const messages = buildSessionMessages(FIXTURE_ID);
    const digest = fixtureDigest(FIXTURE_ID);

    for (let index = 0; index < ctx.options.samples; index += 1) {
      const namespace = `startup-${ctx.runId}-${index}`;
      const sessionId = `perf-startup-${ctx.runId}-${index}`;
      const workspace = path.join(userDataRootFor(namespace), 'workspace');
      fs.mkdirSync(workspace, { recursive: true });

      // --- prepare ------------------------------------------------------
      // The onboarding wizard covers the shell, so the flag is set first.
      // The first load of a fresh profile therefore cannot be measured
      // against a composer — it is measured against the wizard — and the
      // cold number below comes from the SECOND load of the same profile,
      // which has an empty database and no wizard.
      const prepare = await launchPerfElectron({ namespace });
      await waitForAppReady(prepare.page);
      await setRendererState(prepare.page, { currentView: 'home' });
      await closePerfElectron(prepare.app);

      // --- cold boot: empty database, welcome screen ---------------------
      const cold = await launchPerfElectron({ namespace });
      const coldProcessStart = readProcessStartMs(cold.app) ?? ctx.launchMark;
      await waitForAppReady(cold.page);
      const coldTypeable = await waitForTypeable(cold.page);
      const coldPaint = await readPaintTiming(cold.page);
      const coldMetrics = {
        'startup.cold.firstPaint_ms': round(
          coldPaint.timeOrigin + (coldPaint.firstContentfulPaintMs ?? 0) - coldProcessStart,
        ),
        'startup.cold.typeable_ms':
          coldTypeable.found && coldTypeable.detectedAt !== null
            ? round(coldTypeable.detectedAt - coldProcessStart)
            : null,
      };
      await closePerfElectron(cold.app);

      // --- warm boot: the same namespace, seeded, then launched again ----
      const seed = await launchPerfElectron({ namespace });
      await waitForAppReady(seed.page);
      await seedSession(seed.page, {
        sessionId,
        title: `perf startup ${index}`,
        workingDirectory: workspace,
        messages,
      });
      await restoreSession(seed.page, { activeThreadId: sessionId, currentView: 'chat' });
      await closePerfElectron(seed.app);

      const warm = await launchPerfElectron({ namespace });
      const warmProcessStart = readProcessStartMs(warm.app) ?? ctx.launchMark;
      await waitForAppReady(warm.page);
      const warmTypeable = await waitForTypeable(warm.page);
      const warmPaint = await readPaintTiming(warm.page);
      const warmChatState = await readChatViewState(warm.page);

      // The instrumented reload: the same boot path, this time observed from
      // inside the document.
      await installCollector(warm.page);
      await warm.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(warm.page);
      await waitForTypeable(warm.page);
      const bootSnapshot = await readCollector(warm.page);
      // The transcript arrives after the shell: wait for it, then read the
      // collector again so the commit and DOM numbers describe a chat that
      // is actually on screen.
      let transcriptSnapshot = null;
      let transcriptFound = false;
      try {
        await warm.page.waitForFunction(
          (id) => Boolean(document.querySelector(`[data-message-id="${id}"]`)),
          messages[messages.length - 1].id,
          { timeout: 60_000, polling: 'raf' },
        );
        transcriptFound = true;
        transcriptSnapshot = await readCollector(warm.page);
      } catch {
        transcriptSnapshot = null;
      }
      const reloadPaint = await readPaintTiming(warm.page);
      const transcriptState = await readChatViewState(warm.page);
      const renderedRows = await readRenderedMessageCount(warm.page);

      const metrics = {
        // The contract's names: the first paint of a fresh profile and the
        // time to a composer that accepts keys.
        'startup.firstPaint_ms': coldMetrics['startup.cold.firstPaint_ms'],
        'startup.typeable_ms':
          warmTypeable.found && warmTypeable.detectedAt !== null
            ? round(warmTypeable.detectedAt - warmProcessStart)
            : null,
        ...coldMetrics,
        'startup.warm.firstPaint_ms': round(
          warmPaint.timeOrigin + (warmPaint.firstContentfulPaintMs ?? 0) - warmProcessStart,
        ),
        'startup.warm.typeable_ms':
          warmTypeable.found && warmTypeable.detectedAt !== null
            ? round(warmTypeable.detectedAt - warmProcessStart)
            : null,
        'startup.reload.firstPaint_ms': round(reloadPaint.firstContentfulPaintMs),
        'startup.reload.typeable_ms': round(bootSnapshot?.composerReadyAt ?? null),
        ...snapshotToMetrics(bootSnapshot, {
          'startup.reload.dom.nodes': bootSnapshot?.domNodes ?? null,
        }),
        'startup.reload.transcript.commit.count':
          transcriptSnapshot?.mutationBatches ?? null,
        'startup.reload.transcript.dom.nodes': transcriptSnapshot?.domNodes ?? null,
        'startup.reload.transcript.longtask.total_ms': round(
          (transcriptSnapshot?.longTasks ?? []).reduce((sum, task) => sum + task.duration, 0),
        ),
      };

      samples.push({
        index,
        metrics,
        observed: {
          namespace,
          fixture: FIXTURE_ID,
          fixtureDigest: digest,
          sessionId,
          coldProcessStart,
          warmProcessStart,
          warmChatState,
          transcriptState,
          renderedRows,
          transcriptFound,
          collectorInstalledAt: bootSnapshot?.installedAt ?? null,
          collectorTimeOrigin: bootSnapshot?.timeOrigin ?? null,
          coldTypeable: coldTypeable.evidence ?? { found: coldTypeable.found },
          warmTypeable: warmTypeable.evidence ?? { found: warmTypeable.found },
          coldConsoleErrors: cold.consoleErrors.slice(0, 5),
          warmConsoleErrors: warm.consoleErrors.slice(0, 5),
          pageErrors: warm.pageErrors.slice(0, 5),
        },
        error: null,
      });

      await closePerfElectron(warm.app);
      ctx.log(`startup sample ${index}: ${JSON.stringify(metrics)}`);
    }

    return {
      samples,
      notes: {
        fixture: FIXTURE_ID,
        fixtureDigest: digest,
        coldBoot:
          'the profile is fresh (empty database); the onboarding flag is set in a prepare '
          + 'launch, because the wizard covers the shell and has no composer',
        coldTypeable:
          'a fresh profile has no configured provider, so the welcome composer renders '
          + 'DISABLED (contenteditable=false); startup.cold.typeable_ms is therefore null and '
          + 'the evidence is in the sample. startup.typeable_ms is the warm boot, where the '
          + 'restored chat has an enabled composer',
        warmBoot: 'the same profile, seeded with perf/session-100, chat restored from localStorage',
        typeableBasis:
          'the composer is detected by a requestAnimationFrame poll from the harness, '
          + 'so startup.typeable_ms is an upper bound of the true value',
        instrumentedBoot:
          'the *.reload.* metrics come from an instrumented reload of the same boot path, '
          + 'because an init script cannot reach the first document',
      },
    };
  },
};
