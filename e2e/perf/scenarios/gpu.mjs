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
 * THE APP'S OWN WEBGL CONSUMER
 *
 * The terminal panel is the only place in this build that asks for a WebGL
 * context: xterm's WebGL addon creates a WebGL2 context on a canvas, and the
 * panel handles the loss itself (`onContextLoss` -> the DOM renderer). So
 * the context-loss state is exercised on THAT context, and the panel's own
 * renderer badge (`data-renderer`) is read before and after the loss: it is
 * the app's answer to "what does Duya do when the GPU context dies".
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
  userDataRootFor,
  waitForAppReady,
  wakeConversationStore,
} from '../lib/launch.mjs';
import { installCollector, readCollector } from '../lib/collector.mjs';
import { buildSessionMessages, fixtureDigest } from '../lib/fixtures.mjs';
import { gpuMetrics, openSeededSession, snapshotToMetrics, startResourceProbe } from '../lib/scenario-kit.mjs';
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

/**
 * Open the terminal panel — the app's own WebGL consumer.
 *
 * The panel launcher button carries the page id, so the harness asks for the
 * terminal by id instead of by a translated label.
 */
async function openTerminalPanel(page) {
  const launcher = page.locator('.titlebar-panel-launcher[data-page-id="terminal"]').first();
  if ((await launcher.count()) === 0) {
    return { opened: false, reason: 'no terminal panel launcher' };
  }
  try {
    await launcher.click({ timeout: 20_000 });
  } catch (error) {
    return { opened: false, reason: String(error?.message ?? error) };
  }
  await page.waitForTimeout(2500);
  return { opened: true };
}

/**
 * Which renderer the terminal is actually using: 'webgl' or 'dom'.
 *
 * The badge lives in the appearance menu, so the menu is opened for the read
 * and closed again — the panel state is left exactly as it was found.
 */
async function readTerminalRenderer(page) {
  const read = () =>
    page.evaluate(() => {
      const badge = document.querySelector('.terminal-appearance-menu-foot-renderer');
      return badge ? badge.getAttribute('data-renderer') : null;
    });
  const already = await read();
  if (already !== null) return already;
  const button = page.locator('.terminal-appearance-btn').first();
  if ((await button.count()) === 0) return null;
  await button.click({ timeout: 10_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const value = await read();
  await button.click({ timeout: 10_000 }).catch(() => undefined);
  return value;
}

/**
 * The WebGL contexts the collector has seen so far.
 *
 * The terminal panel is opened before this is read, so a context that belongs
 * to the app is already tracked. When the app has no WebGL context at all,
 * the harness creates one in the app's own page — the loss is then still a
 * real GPU event inside the real renderer process, and the report says which
 * of the two it was.
 */
async function readTrackedContexts(page) {
  return page.evaluate(() => {
    const perf = window.__duyaPerf;
    if (!perf || typeof perf.webglState !== 'function') return null;
    return perf.webglState();
  });
}

/** Create a WebGL context in the app's page when the app has none of its own. */
async function createHarnessContext(page) {
  return page.evaluate(() => {
    try {
      const canvas = document.createElement('canvas');
      canvas.width = 64;
      canvas.height = 64;
      canvas.setAttribute('data-duya-perf', 'harness-webgl');
      document.body.appendChild(canvas);
      const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
      return gl ? 'created' : 'unavailable';
    } catch (error) {
      return `error: ${String(error)}`;
    }
  });
}

export default {
  id: 'gpu',
  title: 'GPU normal, GPU unavailable and a lost WebGL context',
  fixture: FIXTURE_ID,

  async run(ctx) {
    const samples = [];
    const digest = fixtureDigest(FIXTURE_ID);

    for (const state of STATES) {
      for (let index = 0; index < ctx.options.samples; index += 1) {
        const namespace = `gpu-${state.id}-${ctx.runId}-${index}`;
        const sessionId = `perf-gpu-${ctx.runId}-${index}`;
        const title = `perf gpu ${index}`;
        const workspace = path.join(userDataRootFor(namespace), 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        const transcript = buildSessionMessages(FIXTURE_ID, { idPrefix: sessionId });

        const measured = await launchPerfElectron({
          namespace,
          extraArgs: state.extraArgs,
        });
        await waitForAppReady(measured.page);
        await seedSession(measured.page, {
          sessionId,
          title,
          workingDirectory: workspace,
          messages: transcript,
        });
        // The app syncs itself, so the sidebar lists the session and the
        // store persists the state the instrumented reload will hydrate from.
        await wakeConversationStore(measured.app, measured.page);
        await installCollector(measured.page);
        await measured.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(measured.page);
        // The reloaded document does not hydrate on its own either (the same
        // store defect), so the app is told to sync itself before the
        // measurement starts.
        await wakeConversationStore(measured.app, measured.page);
        await measured.page.waitForTimeout(1000);
        await openSeededSession(measured.page, {
          title,
          lastMessageId: transcript[transcript.length - 1].id,
        });

        const featureStatus = await gpuFeatureStatus(measured.app);
        const probe = await startResourceProbe(measured.page);
        const terminal = await openTerminalPanel(measured.page);
        const probeBefore = await probeWebgl(measured.page);
        const rendererBefore = await readTerminalRenderer(measured.page);
        let contextsBefore = await readTrackedContexts(measured.page);

        // The app had no WebGL context of its own: create one in its page so
        // the loss is still a real GPU event, and say so in the report.
        let contextSource = 'app';
        if (state.id === 'webgl-context-lost' && (contextsBefore ?? []).length === 0) {
          const created = await createHarnessContext(measured.page);
          await measured.page.waitForTimeout(300);
          contextsBefore = await readTrackedContexts(measured.page);
          contextSource = created === 'created' ? 'harness' : `harness-${created}`;
        }

        let lostContexts = 0;
        if (state.id === 'webgl-context-lost') {
          lostContexts = await measured.page
            .evaluate(() =>
              window.__duyaPerf && typeof window.__duyaPerf.loseWebglContexts === 'function'
                ? window.__duyaPerf.loseWebglContexts()
                : 0,
            )
            .catch(() => 0);
          await measured.page.waitForTimeout(2000);
        }

        const probeAfter = await probeWebgl(measured.page);
        const rendererAfter = await readTerminalRenderer(measured.page);
        const snapshot = await readCollector(measured.page);
        const resource = await probe.stop();
        const trackedContexts = snapshot?.webglContextsLost ?? [];

        const metrics = {
          ...gpuMetrics(featureStatus),
          ...snapshotToMetrics(snapshot),
          ...resource,
          'gpu.probe.available': probeAfter.available ? 1 : 0,
          'gpu.contexts.lost': trackedContexts.filter(Boolean).length,
          'gpu.contexts.total': trackedContexts.length,
          // 1 when the terminal answered a lost context with the DOM renderer.
          'gpu.terminal.degraded': rendererBefore === 'webgl' && rendererAfter === 'dom' ? 1 : 0,
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
            terminal,
            probeBefore,
            probeAfter,
            rendererBefore,
            rendererAfter,
            contextSource,
            contextsBefore,
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
            + `terminal=${rendererBefore ?? '?'}->${rendererAfter ?? '?'} `
            + `lost=${trackedContexts.filter(Boolean).length}`,
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
        webglConsumer:
          'the terminal panel is the app\'s only WebGL consumer (xterm\'s WebGL addon); the '
          + 'context loss is applied to the context that panel created, and the panel\'s own '
          + 'renderer badge (data-renderer) is read before and after the loss',
        ownership:
          'the detection and the fallback path belong to the desktop main process; this '
          + 'scenario only manufactures the states and records what the app did',
      },
    };
  },
};
