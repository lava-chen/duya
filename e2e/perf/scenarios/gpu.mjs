/**
 * e2e/perf/scenarios/gpu.mjs — the three GPU states, measured and recorded.
 *
 * The detection of the states and the fallback behaviour belong to the
 * desktop main process (another agent's slice). This scenario only does two
 * things: it manufactures the three states through observable channels, and
 * it records what the app actually did, so the owner of the fallback path
 * has evidence to work with.
 *
 *   gpu-normal          the ordinary launch
 *   gpu-unavailable     the same launch with `--disable-gpu`, so Chromium
 *                       reports the feature as disabled
 *   webgl-context-lost  the ordinary launch, after which every WebGL
 *                       context the app created is really lost through the
 *                       `WEBGL_lose_context` extension. The collector
 *                       tracks the contexts the app asked for, so the loss
 *                       reaches the app's own canvas and not a probe.
 *
 * No product default is changed: the flags are launch arguments and the
 * context loss is a real GPU-context event.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closePerfElectron,
  gpuFeatureStatus,
  launchPerfElectron,
  seedSession,
  restoreSession,
  userDataRootFor,
  waitForAppReady,
} from '../lib/launch.mjs';
import { installCollector, readCollector } from '../lib/collector.mjs';
import { buildSessionMessages, fixtureDigest } from '../lib/fixtures.mjs';
import { gpuMetrics, snapshotToMetrics } from '../lib/scenario-kit.mjs';
import { round } from '../lib/metrics.mjs';

const FIXTURE_ID = 'perf/session-100';

const STATES = [
  { id: 'gpu-normal', extraArgs: [] },
  { id: 'gpu-unavailable', extraArgs: ['--disable-gpu'] },
  { id: 'webgl-context-lost', extraArgs: [] },
];

/** Can the renderer create a WebGL context right now? */
async function probeWebgl(page) {
  return page.evaluate(() => {
    try {
      // An OffscreenCanvas is used on purpose: the collector only tracks the
      // contexts created through HTMLCanvasElement, so the probe does not
      // pollute the list of the app's own contexts.
      const canvas =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(1, 1)
          : document.createElement('canvas');
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      if (!gl) return { available: false, renderer: null, lost: null };
      const info = gl.getExtension('WEBGL_debug_renderer_info');
      return {
        available: true,
        renderer: info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        lost: typeof gl.isContextLost === 'function' ? gl.isContextLost() : null,
      };
    } catch (error) {
      return { available: false, renderer: null, lost: null, error: String(error) };
    }
  });
}

/** Open the Conductor view, which is where the app draws on a canvas. */
async function openCanvasView(page) {
  try {
    const conductor = page.getByTestId('nav-conductor');
    if ((await conductor.count()) === 0) return { opened: false, reason: 'no conductor nav entry' };
    await conductor.click({ timeout: 15_000 });
    await page.waitForTimeout(1500);
    const canvases = await page.evaluate(() => document.querySelectorAll('canvas').length);
    return { opened: true, canvases };
  } catch (error) {
    return { opened: false, reason: String(error?.message ?? error) };
  }
}

export default {
  id: 'gpu',
  title: 'GPU normal, GPU unavailable and a lost WebGL context',
  fixture: FIXTURE_ID,

  async run(ctx) {
    const samples = [];
    const transcript = buildSessionMessages(FIXTURE_ID);
    const digest = fixtureDigest(FIXTURE_ID);

    for (const state of STATES) {
      for (let index = 0; index < ctx.options.samples; index += 1) {
        const namespace = `gpu-${state.id}-${ctx.runId}-${index}`;
        const sessionId = `perf-gpu-${ctx.runId}-${index}`;
        const workspace = path.join(userDataRootFor(namespace), 'workspace');
        fs.mkdirSync(workspace, { recursive: true });

        const measured = await launchPerfElectron({
          namespace,
          extraArgs: state.extraArgs,
        });
        await waitForAppReady(measured.page);
        await seedSession(measured.page, {
          sessionId,
          title: `perf gpu ${index}`,
          workingDirectory: workspace,
          messages: transcript,
        });
        await restoreSession(measured.page, { activeThreadId: sessionId, currentView: 'chat' });
        await measured.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(measured.page);
        await installCollector(measured.page);
        await measured.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(measured.page);
        await measured.page.waitForTimeout(1000);

        const featureStatus = await gpuFeatureStatus(measured.app);
        const canvasView = await openCanvasView(measured.page);
        const probeBefore = await probeWebgl(measured.page);

        let lostContexts = 0;
        if (state.id === 'webgl-context-lost') {
          lostContexts = await measured.page
            .evaluate(() =>
              window.__duyaPerf && typeof window.__duyaPerf.loseWebglContexts === 'function'
                ? window.__duyaPerf.loseWebglContexts()
                : 0,
            )
            .catch(() => 0);
          await measured.page.waitForTimeout(1500);
        }

        const probeAfter = await probeWebgl(measured.page);
        const snapshot = await readCollector(measured.page);
        const trackedContexts = snapshot?.webglContextsLost ?? [];

        const metrics = {
          ...gpuMetrics(featureStatus),
          ...snapshotToMetrics(snapshot),
          'gpu.probe.available': probeAfter.available ? 1 : 0,
          'gpu.contexts.lost': trackedContexts.filter(Boolean).length,
          'gpu.contexts.total': trackedContexts.length,
        };

        samples.push({
          index: samples.length,
          metrics,
          observed: {
            fixture: FIXTURE_ID,
            fixtureDigest: digest,
            state: state.id,
            launchArgs: state.extraArgs,
            namespace,
            featureStatus,
            canvasView,
            probeBefore,
            probeAfter,
            lostContexts,
            trackedContextsLost: trackedContexts,
            consoleErrors: measured.consoleErrors.slice(0, 10),
            pageErrors: measured.pageErrors.slice(0, 10),
          },
          error: null,
        });

        await closePerfElectron(measured.app);
        ctx.log(
          `gpu ${state.id} sample ${index}: webgl=${featureStatus?.webgl ?? '?'} `
            + `probe=${probeAfter.available} lost=${trackedContexts.filter(Boolean).length}`,
        );
      }
    }

    return {
      samples,
      notes: {
        fixture: FIXTURE_ID,
        fixtureDigest: digest,
        states: STATES.map((state) => ({
          id: state.id,
          how: state.extraArgs.length > 0 ? state.extraArgs.join(' ') : 'default launch',
        })),
        ownership:
          'the detection and the fallback path belong to the desktop main process; this '
          + 'scenario only manufactures the states and records what the app did',
      },
    };
  },
};
