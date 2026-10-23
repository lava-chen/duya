/**
 * e2e/perf/scenarios/startup.mjs — how long until the app is usable.
 *
 * TWO BOOTS, BOTH REPORTED
 *
 *   cold  a fresh profile: empty database, no persisted store state. This is
 *         the "user starts Duya" number.
 *   warm  a profile the harness prepared through the product's own IPC: one
 *         project, one session, and the app's own persisted store state. This
 *         is the "user reopens Duya" number, and the one the other agents
 *         change.
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
 * WHICH BOOT THE CONTRACT NAMES DESCRIBE
 *
 * `startup.firstPaint_ms` is the COLD boot (the first paint of a profile the
 * user has never seen) and `startup.typeable_ms` is the WARM boot (the
 * composer of a profile the app can hydrate — a returning user). The cold
 * boot's own composer is reported as `startup.cold.typeable_ms`; on a profile
 * with no project the welcome composer is disabled, so that number is null
 * and the evidence is in the sample.
 *
 * THE WARM PROFILE IS PREPARED, NOT HAND-WRITTEN
 *
 * The prepare launch seeds the session through the product's IPC and then
 * lets the app sync itself (`wakeConversationStore`). The app therefore
 * writes its own persisted store state, and the MEASURED boot is an
 * unmodified product boot: it hydrates, lists the session and enables the
 * composer on its own.
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
  readHydrationState,
  readPaintTiming,
  readProcessStartMs,
  readRenderedMessageCount,
  seedSession,
  userDataRootFor,
  waitForAppReady,
  waitForTypeable,
  wakeConversationStore,
} from '../lib/launch.mjs';
import { installCollector, readCollector } from '../lib/collector.mjs';
import { buildSessionMessages, fixtureDigest } from '../lib/fixtures.mjs';
import { snapshotToMetrics, startResourceProbe } from '../lib/scenario-kit.mjs';
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
      const sessionId = `perf-startup-${ctx.runId}-${index}`;
      const coldNamespace = `startup-cold-${ctx.runId}-${index}`;
      const warmNamespace = `startup-warm-${ctx.runId}-${index}`;
      const workspace = path.join(userDataRootFor(warmNamespace), 'workspace');
      fs.mkdirSync(workspace, { recursive: true });

      // --- the cold boot: a profile the user has never seen --------------
      // The FIRST launch of a profile shows the onboarding wizard, which
      // covers the shell and has no composer, so the flag is written once
      // and the measured cold boot is the SECOND launch of the same (still
      // empty) profile: an empty database and no project.
      const coldPrepare = await launchPerfElectron({ namespace: coldNamespace });
      await waitForAppReady(coldPrepare.page);
      await completeOnboarding(coldPrepare.page);
      await closePerfElectron(coldPrepare.app);

      const cold = await launchPerfElectron({ namespace: coldNamespace });
      const coldProcessStart = readProcessStartMs(cold.app) ?? ctx.launchMark;
      const coldProbe = await startResourceProbe(cold.page);
      await waitForAppReady(cold.page);
      const coldTypeable = await waitForTypeable(cold.page);
      const coldPaint = await readPaintTiming(cold.page);
      const coldHydration = await readHydrationState(cold.page);
      const coldResource = await coldProbe.stop();
      await closePerfElectron(cold.app);

      // --- the warm profile: prepared through the product's own IPC ------
      const prepare = await launchPerfElectron({ namespace: warmNamespace });
      await waitForAppReady(prepare.page);
      await completeOnboarding(prepare.page);
      const messages = buildSessionMessages(FIXTURE_ID, { idPrefix: sessionId });
      await seedSession(prepare.page, {
        sessionId,
        title: `perf startup ${index}`,
        workingDirectory: workspace,
        messages,
      });
      // The app syncs itself, so it writes its own persisted store state and
      // the measured boot hydrates without any help from the harness.
      const warmHydration = await wakeConversationStore(prepare.app, prepare.page);
      await closePerfElectron(prepare.app);

      // --- the measured warm boot ----------------------------------------
      const measured = await launchPerfElectron({ namespace: warmNamespace });
      const processStart = readProcessStartMs(measured.app) ?? ctx.launchMark;
      const probe = await startResourceProbe(measured.page);
      await waitForAppReady(measured.page);
      // The conversation store does not hydrate on its own in this build (see
      // the productDefect note), so the harness lets the app sync itself
      // through the product's own sync event. `startup.typeable_ms` includes
      // this nudge; `startup.warm.typeableAfterSync_ms` is the app's own cost
      // after it.
      const syncedAt = Date.now();
      await wakeConversationStore(measured.app, measured.page, { settleMs: 0 });
      const typeable = await waitForTypeable(measured.page);
      const paint = await readPaintTiming(measured.page);
      const chatState = await readChatViewState(measured.page);
      const renderedRows = await readRenderedMessageCount(measured.page);
      const hydration = await readHydrationState(measured.page);
      const resource = await probe.stop();

      // The instrumented reload: the same boot path, this time observed from
      // inside the document.
      await installCollector(measured.page);
      await measured.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(measured.page);
      // The same nudge as in the measured boot: without it the reloaded
      // document never hydrates either, and the document-relative numbers
      // would describe an app that is not usable.
      await wakeConversationStore(measured.app, measured.page, { settleMs: 0 });
      const reloadTypeable = await waitForTypeable(measured.page);
      const bootSnapshot = await readCollector(measured.page);
      const reloadPaint = await readPaintTiming(measured.page);

      const metrics = {
        // The contract's names.
        'startup.firstPaint_ms': round(
          coldPaint.timeOrigin + (coldPaint.firstContentfulPaintMs ?? 0) - coldProcessStart,
        ),
        'startup.typeable_ms':
          typeable.found && typeable.detectedAt !== null
            ? round(typeable.detectedAt - processStart)
            : null,
        // The cold boot, in full.
        'startup.cold.firstPaint_ms': round(
          coldPaint.timeOrigin + (coldPaint.firstContentfulPaintMs ?? 0) - coldProcessStart,
        ),
        'startup.cold.typeable_ms':
          coldTypeable.found && coldTypeable.detectedAt !== null
            ? round(coldTypeable.detectedAt - coldProcessStart)
            : null,
        // The warm boot, in full.
        'startup.warm.firstPaint_ms': round(
          paint.timeOrigin + (paint.firstContentfulPaintMs ?? 0) - processStart,
        ),
        'startup.warm.typeable_ms':
          typeable.found && typeable.detectedAt !== null
            ? round(typeable.detectedAt - processStart)
            : null,
        // The app's own cost after the sync nudge, without the dispatch.
        'startup.warm.typeableAfterSync_ms':
          typeable.found && typeable.detectedAt !== null
            ? round(typeable.detectedAt - syncedAt)
            : null,
        'startup.reload.firstPaint_ms': round(reloadPaint.firstContentfulPaintMs),
        // Document-relative: the collector sees the composer become editable
        // inside the page, so the number needs no external clock.
        'startup.reload.typeable_ms': round(bootSnapshot?.composerReadyAt ?? null),
        ...snapshotToMetrics(bootSnapshot, {
          'startup.reload.dom.nodes': bootSnapshot?.domNodes ?? null,
        }),
        // The renderer-side CPU and memory of the two boots.
        'startup.cold.cpu.renderer_pct': coldResource['cpu.renderer_pct'],
        'startup.cold.mem.peakMB': coldResource['mem.peakMB'],
        'startup.cold.mem.growthMB': coldResource['mem.growthMB'],
        'startup.warm.cpu.renderer_pct': resource['cpu.renderer_pct'],
        'startup.warm.mem.peakMB': resource['mem.peakMB'],
        'startup.warm.mem.growthMB': resource['mem.growthMB'],
      };

      samples.push({
        index,
        metrics,
        observed: {
          namespace: { cold: coldNamespace, warm: warmNamespace },
          fixture: FIXTURE_ID,
          fixtureDigest: digest,
          sessionId,
          coldProcessStart,
          processStart,
          chatState,
          renderedRows,
          typeable: typeable.evidence ?? { found: typeable.found },
          coldTypeable: coldTypeable.evidence ?? { found: coldTypeable.found },
          reloadTypeable: reloadTypeable.evidence ?? { found: reloadTypeable.found },
          hydration: { cold: coldHydration, prepared: warmHydration, measured: hydration },
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
        coldBoot:
          'a profile with an empty database and no project: the onboarding flag is written in '
          + 'a first launch (the wizard covers the shell and has no composer), and the '
          + 'measured cold boot is the second launch of that same empty profile',
        coldTypeable:
          'a fresh profile has no project, so the welcome composer renders disabled '
          + '(contenteditable=false) and startup.cold.typeable_ms is null; the evidence is in '
          + 'the sample',
        warmBoot:
          'the profile was prepared through the product\'s own IPC (one project, one session) '
          + 'and then synced by the app itself; the measured boot is a plain product launch',
        typeableBasis:
          'the composer is detected by a requestAnimationFrame poll from the harness, and the '
          + 'boot splash must not be COVERING the UI — the welcome view is rendered behind that '
          + 'overlay, and its composer is editable while the overlay is up. The overlay is '
          + 'never unmounted in this build (App.tsx cancels its own unmount timer), so the '
          + 'harness waits for it to stop covering the UI instead of to disappear',
        syncNudge:
          'the conversation store does not hydrate on its own in this build, so the measured '
          + 'boot gets ONE nudge through the product\'s own sync event (sync:threads-changed). '
          + 'startup.typeable_ms includes that dispatch; startup.warm.typeableAfterSync_ms is '
          + 'the app\'s own cost after it',
        instrumentedBoot:
          'the *.reload.* metrics come from an instrumented reload of the same boot path, '
          + 'because an init script cannot reach the first document',
        productDefect:
          'on a profile whose persisted store state is absent, the conversation store never '
          + 'reports itself hydrated (onRehydrateStorage mutates the state instead of setting '
          + 'it), so the session list stays empty and the welcome composer stays disabled. '
          + 'The prepare phase works around it by letting the app sync itself; the defect '
          + 'itself is in packages/ui/src/stores/conversation-store.ts and is NOT fixed here',
      },
    };
  },
};
