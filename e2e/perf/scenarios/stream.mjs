/**
 * e2e/perf/scenarios/stream.mjs — the streaming display under load.
 *
 * Two fixtures:
 *   perf/stream-long-reply  one long reply, streamed token by token
 *   perf/stream-tool-storm  a large number of tool events flowing in
 *
 * CHANNELS
 *
 * The primary channel is the product's real streaming path: the renderer
 * posts a turn to the agent server, the agent server forks the real worker,
 * the worker talks to a loopback Anthropic endpoint that emits a known
 * number of deltas or tool calls, and the renderer receives the frames over
 * the real SSE subscription. Nothing about that path is faked.
 *
 * The fallback channel is the product's own `message:new` broadcast: the
 * main process sends the rows the worker would have persisted, and the
 * renderer ingests them through the preload. It is still the real IPC bus
 * and the real store, but it is NOT the SSE path — so the report always
 * states which channel produced the numbers.
 *
 * MEASURED
 *
 *   stream.block_ms_total   the main-thread time the streaming occupied
 *   stream.worstFreeze_ms   the longest single long task during the stream
 *   stream.frames           the number of frames the stream produced
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  closePerfElectron,
  launchPerfElectron,
  seedSession,
  userDataRootFor,
  waitForAppReady,
} from '../lib/launch.mjs';
import { installCollector, readCollector, resetCollector } from '../lib/collector.mjs';
import { startLoopbackProvider } from '../lib/loopback-provider.mjs';
import { buildStreamChunks, buildToolStormRows, fixtureDigest } from '../lib/fixtures.mjs';
import { openSeededSession, snapshotToMetrics } from '../lib/scenario-kit.mjs';
import { round } from '../lib/metrics.mjs';

const MODEL = 'perf-loopback-model';
/** A loopback token, not a credential. */
const LOOPBACK_API_KEY = 'perf-loopback-not-a-credential';

async function waitForAgentServerUrl(page, timeoutMs = 45_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await page
      .evaluate(() => (window.electronAPI?.agentServer ? window.electronAPI.agentServer.getUrl() : null))
      .catch(() => null);
    if (url) return url;
    await page.waitForTimeout(500);
  }
  throw new Error('the agent server did not report a URL in time');
}

/**
 * Post the turn from the renderer and do NOT await it: the run has to be
 * observed while it is in flight.
 */
async function postTurn(page, args) {
  await page.evaluate((a) => {
    window.__perfTurn = { done: false, status: 0, error: null, text: '' };
    void (async () => {
      try {
        const response = await fetch(
          `${a.baseUrl}/sessions/${encodeURIComponent(a.sessionId)}/chat`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
            body: JSON.stringify({
              prompt: a.prompt,
              providerConfig: {
                apiKey: a.apiKey,
                baseURL: a.providerBaseUrl,
                model: a.model,
                provider: 'anthropic',
                authStyle: 'api_key',
              },
              workingDirectory: a.workspace,
              defaultWorkspaceDirectory: a.workspace,
              options: { runOrigin: 'user' },
            }),
          },
        );
        window.__perfTurn.status = response.status;
        if (!response.body) {
          window.__perfTurn.done = true;
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          window.__perfTurn.text += decoder.decode(value, { stream: true });
        }
        window.__perfTurn.done = true;
      } catch (error) {
        window.__perfTurn.error = String(error && error.message ? error.message : error);
        window.__perfTurn.done = true;
      }
    })();
  }, args);
}

async function readTurnState(page) {
  return page.evaluate(() => window.__perfTurn ?? null);
}

/**
 * The fallback channel: the main process broadcasts the rows the worker
 * would have persisted, through the product's own `message:new` event.
 */
async function broadcastRows(app, payload) {
  await app.evaluate(({ BrowserWindow }, data) => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no BrowserWindow to broadcast to');
    win.webContents.send('message:new', data);
  }, payload);
}

/** How much the transcript changed, as the signal that the channel worked. */
async function readTranscriptState(page) {
  return page.evaluate(() => {
    const list = document.querySelector('.message-list-scroll');
    return {
      hasList: Boolean(list),
      rows: list ? list.querySelectorAll('[data-message-id]').length : 0,
      domNodes: document.getElementsByTagName('*').length,
      textLength: list ? (list.textContent ?? '').length : 0,
    };
  });
}

export default {
  id: 'stream',
  title: 'Streaming display under a sustained flow of content',
  fixture: 'perf/stream-long-reply, perf/stream-tool-storm',

  async run(ctx) {
    const samples = [];
    const notes = {};

    for (const fixtureId of ['perf/stream-long-reply', 'perf/stream-tool-storm']) {
      const digest = fixtureDigest(fixtureId);
      const isToolStorm = fixtureId === 'perf/stream-tool-storm';
      const chunks = isToolStorm ? null : buildStreamChunks(fixtureId);
      const storm = isToolStorm ? buildToolStormRows(fixtureId) : null;

      for (let index = 0; index < ctx.options.samples; index += 1) {
        const namespace = `stream-${fixtureId.replace(/[^a-z0-9]+/gi, '-')}-${ctx.runId}-${index}`;
        const sessionId = `perf-stream-${ctx.runId}-${index}`;
        const workspace = path.join(userDataRootFor(namespace), 'workspace');
        fs.mkdirSync(workspace, { recursive: true });
        fs.writeFileSync(path.join(workspace, 'perf-fixture.txt'), 'perf fixture\n', 'utf8');

        const provider = await startLoopbackProvider(
          isToolStorm
            ? { mode: 'tool', model: MODEL, toolCalls: storm.toolCalls, toolPath: 'perf-fixture.txt' }
            : {
                mode: 'text',
                model: MODEL,
                chunkCount: chunks.chunkCount,
                chunkChars: chunks.chunkChars,
                intervalMs: chunks.intervalMs,
                chunks: chunks.chunks,
              },
        );

        const measured = await launchPerfElectron({ namespace });
        await waitForAppReady(measured.page);
        await seedSession(measured.page, {
          sessionId,
          title: `perf stream ${index}`,
          workingDirectory: workspace,
          messages: [],
        });
        await installCollector(measured.page);
        await measured.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(measured.page);
        // The chat is open for the session the turn is posted to, so the
        // renderer is subscribed to that session's stream.
        await openSeededSession(measured.page, { title: `perf stream ${index}` });

        const before = await readTranscriptState(measured.page);
        await resetCollector(measured.page);

        let channel = 'agent-server-sse';
        let turnState = null;
        let fallbackError = null;

        try {
          const agentUrl = await waitForAgentServerUrl(measured.page);
          await postTurn(measured.page, {
            baseUrl: agentUrl,
            sessionId,
            workspace,
            providerBaseUrl: provider.baseUrl,
            model: MODEL,
            apiKey: LOOPBACK_API_KEY,
            prompt: 'perf streaming fixture',
          });

          const deadline = Date.now() + 120_000;
          let activity = 0;
          while (Date.now() < deadline) {
            turnState = await readTurnState(measured.page);
            const state = await readTranscriptState(measured.page);
            activity = state.rows !== before.rows || state.textLength !== before.textLength ? 1 : 0;
            if (turnState?.done && activity) break;
            if (turnState?.done && !activity) {
              // The turn finished without moving the transcript: fall back.
              break;
            }
            await measured.page.waitForTimeout(200);
          }
          const afterSse = await readTranscriptState(measured.page);
          if (afterSse.rows === before.rows && afterSse.textLength === before.textLength) {
            channel = 'message-new-broadcast';
            fallbackError = 'the agent-server turn produced no visible transcript change';
            await resetCollector(measured.page);
            const beforeBroadcast = await readTranscriptState(measured.page);
            if (isToolStorm) {
              for (const batch of storm.batches) {
                await broadcastRows(measured.app, {
                  sessionId,
                  messages: batch.map((row) => ({ ...row, source: 'send_message' })),
                });
                await measured.page.waitForTimeout(storm.intervalMs);
              }
            } else {
              const rows = chunks.chunks.map((chunk) => ({
                id: `perf-chunk-${ctx.runId}-${index}-${chunk.index}`,
                session_id: sessionId,
                role: 'assistant',
                content: chunk.text,
                created_at: 1_700_000_000_000 + chunk.index,
                msg_type: 'text',
                source: 'send_message',
              }));
              for (const row of rows) {
                await broadcastRows(measured.app, { sessionId, messages: [row] });
                await measured.page.waitForTimeout(chunks.intervalMs);
              }
            }
            const afterBroadcast = await readTranscriptState(measured.page);
            turnState = {
              ...(turnState ?? {}),
              fallbackRows: afterBroadcast.rows - beforeBroadcast.rows,
              fallbackTextDelta: afterBroadcast.textLength - beforeBroadcast.textLength,
            };
          }
        } catch (error) {
          channel = 'failed';
          fallbackError = String(error?.message ?? error);
        }

        await measured.page.waitForTimeout(500);
        const snapshot = await readCollector(measured.page);
        const after = await readTranscriptState(measured.page);
        const longTasks = (snapshot?.longTasks ?? []).map((task) => task.duration);

        samples.push({
          index: samples.length,
          metrics: {
            'stream.block_ms_total': round(longTasks.reduce((sum, value) => sum + value, 0)),
            'stream.worstFreeze_ms': round(
              longTasks.length > 0 ? Math.max(...longTasks) : 0,
            ),
            'stream.frames': snapshot?.frameCount ?? null,
            ...snapshotToMetrics(snapshot),
          },
          observed: {
            fixture: fixtureId,
            fixtureDigest: digest,
            namespace,
            channel,
            fallbackError,
            turnState,
            transcriptBefore: before,
            transcriptAfter: after,
            providerRequests: provider.requests.length,
            consoleErrors: measured.consoleErrors.slice(0, 5),
            pageErrors: measured.pageErrors.slice(0, 5),
          },
          error: channel === 'failed' ? fallbackError : null,
        });

        await closePerfElectron(measured.app);
        await provider.close();
        ctx.log(
          `stream ${fixtureId} sample ${index}: channel=${channel} `
            + `block=${samples[samples.length - 1].metrics['stream.block_ms_total']}ms`,
        );
      }
    }

    notes.channels = {
      'agent-server-sse':
        'the product path: the renderer posts a turn to the agent server, the worker '
        + 'forks, the loopback provider streams, the renderer receives the frames',
      'message-new-broadcast':
        'the fallback: the main process broadcasts the rows through the product\'s own '
        + 'message:new event; the IPC bus and the store are real, the SSE path is not',
    };
    return {
      samples,
      notes,
    };
  },
};
