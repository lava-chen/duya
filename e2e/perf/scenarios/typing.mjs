/**
 * e2e/perf/scenarios/typing.mjs — input latency while typing.
 *
 * The fixture is `perf/typing-30s`: 30 seconds of continuous typing in the
 * composer, one keystroke every 60 ms, with a fixed text so the run is
 * reproducible.
 *
 * The latency is measured inside the renderer: the collector takes the
 * keydown's own timestamp and the timestamp of the frame after the frame in
 * which the edit was painted (a double requestAnimationFrame — the paint of
 * frame N is complete before the callback of frame N+1 runs).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closePerfElectron,
  launchPerfElectron,
  seedSession,
  userDataRootFor,
  waitForAppReady,
  waitForTypeable,
} from '../lib/launch.mjs';
import { installCollector, readCollector, readHeapUsage, resetCollector } from '../lib/collector.mjs';
import { buildSessionMessages, buildTypingFixture, fixtureDigest } from '../lib/fixtures.mjs';
import { openSeededSession, snapshotToMetrics } from '../lib/scenario-kit.mjs';
import { round } from '../lib/metrics.mjs';

const FIXTURE_ID = 'perf/typing-30s';
const TRANSCRIPT_FIXTURE = 'perf/session-100';

export default {
  id: 'typing',
  title: 'Composer input latency during continuous typing',
  fixture: FIXTURE_ID,

  async run(ctx) {
    const samples = [];
    const typing = buildTypingFixture(FIXTURE_ID);
    const digest = fixtureDigest(FIXTURE_ID);

    for (let index = 0; index < ctx.options.samples; index += 1) {
      const namespace = `typing-${ctx.runId}-${index}`;
      const sessionId = `perf-typing-${ctx.runId}-${index}`;
      const title = `perf typing ${index}`;
      const workspace = path.join(userDataRootFor(namespace), 'workspace');
      fs.mkdirSync(workspace, { recursive: true });
      const transcript = buildSessionMessages(TRANSCRIPT_FIXTURE, { idPrefix: sessionId });

      const measured = await launchPerfElectron({ namespace });
      await waitForAppReady(measured.page);
      await seedSession(measured.page, {
        sessionId,
        title,
        workingDirectory: workspace,
        messages: transcript,
      });
      await installCollector(measured.page);
      await measured.page.reload({ waitUntil: 'domcontentloaded' });
      await waitForAppReady(measured.page);

      // The chat the user types into is opened through the sidebar, the way
      // they would open it.
      await openSeededSession(measured.page, {
        title,
        lastMessageId: transcript[transcript.length - 1].id,
      });

      const typeable = await waitForTypeable(measured.page);
      if (!typeable.found) {
        samples.push({
          index,
          metrics: {},
          observed: {
            fixture: FIXTURE_ID,
            fixtureDigest: digest,
            namespace,
            reason: typeable.reason,
            evidence: typeable.evidence,
          },
          error: typeable.reason,
        });
        await closePerfElectron(measured.app);
        continue;
      }

      // Put the caret in the composer: the latency is only meaningful for
      // keystrokes that actually reach the input.
      const composer = measured.page.locator('[role="textbox"][contenteditable="true"]').first();
      await composer.click({ timeout: 30_000 });
      await measured.page.waitForTimeout(250);

      await resetCollector(measured.page);
      const heapReadings = [];
      const heapBefore = await readHeapUsage(null);

      const startedAt = Date.now();
      const typingPromise = measured.page.keyboard.type(typing.text, {
        delay: typing.intervalMs,
      });
      // Sample the heap while the typing runs, so the report has a curve and
      // not just two points.
      while (true) {
        const elapsed = Date.now() - startedAt;
        if (elapsed >= typing.durationMs) break;
        await measured.page.waitForTimeout(2000);
        const reading = await measured.page
          .evaluate(() => {
            const memory = performance.memory;
            return memory
              ? { usedMB: memory.usedJSHeapSize / (1024 * 1024), totalMB: memory.jsHeapSizeLimit / (1024 * 1024) }
              : null;
          })
          .catch(() => null);
        if (reading) heapReadings.push(reading);
      }
      await typingPromise;
      const durationMs = Date.now() - startedAt;

      const snapshot = await readCollector(measured.page);
      const heapAfter = await measured.page
        .evaluate(() => {
          const memory = performance.memory;
          return memory
            ? { usedMB: memory.usedJSHeapSize / (1024 * 1024), totalMB: memory.jsHeapSizeLimit / (1024 * 1024) }
            : null;
        })
        .catch(() => null);
      if (heapAfter) heapReadings.push(heapAfter);

      const used = heapReadings.map((reading) => reading?.usedMB).filter((value) => Number.isFinite(value));
      const metrics = {
        ...snapshotToMetrics(snapshot),
        'typing.duration_ms': round(durationMs),
        'typing.keystrokes': typing.keystrokes,
        'mem.peakMB': used.length > 0 ? round(Math.max(...used)) : null,
        'mem.growthMB': used.length > 1 ? round(used[used.length - 1] - used[0]) : null,
      };

      samples.push({
        index,
        metrics,
        observed: {
          fixture: FIXTURE_ID,
          fixtureDigest: digest,
          transcriptFixture: TRANSCRIPT_FIXTURE,
          namespace,
          durationMs,
          heapSamples: heapReadings.length,
          heapBefore,
          keystrokesObserved: snapshot?.keyLatencies?.length ?? 0,
          consoleErrors: measured.consoleErrors.slice(0, 5),
          pageErrors: measured.pageErrors.slice(0, 5),
        },
        error: null,
      });

      await closePerfElectron(measured.app);
      ctx.log(
        `typing sample ${index}: p50=${metrics['interact.p50_ms']}ms `
          + `p95=${metrics['interact.p95_ms']}ms frames=${metrics['frame.p95_ms']}ms`,
      );
    }

    return {
      samples,
      notes: {
        fixture: FIXTURE_ID,
        fixtureDigest: digest,
        transcriptFixture: TRANSCRIPT_FIXTURE,
        latencyDefinition:
          'keydown timestamp -> the animation frame after the frame in which the edit was '
          + 'painted (double requestAnimationFrame)',
        heapSource: 'performance.memory in the renderer (Chromium), sampled every 2s',
      },
    };
  },
};
