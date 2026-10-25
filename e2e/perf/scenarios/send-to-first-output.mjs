/**
 * e2e/perf/scenarios/send-to-first-output.mjs — the gap between submitting a
 * turn and the first visible agent output.
 *
 * WHY THIS SCENARIO EXISTS
 *
 * The two journeys the shared harness already covers (startup, streaming) do
 * not measure the moment a USER feels most: pressing enter, and then staring
 * at an empty transcript while the agent is somewhere else. The streaming
 * scenario measures the RENDER of a reply that is already flowing; it says
 * nothing about the wait BEFORE the first byte.
 *
 * That wait is the product's own startup path for every turn: the renderer
 * posts the turn, the agent server forks or reuses a worker, the worker
 * (re)initialises the agent, and only then does the provider get asked. Every
 * step in between is latency the user pays before seeing a single character.
 *
 * WHAT IT MEASURES
 *
 *   turn.submit_to_provider_ms    submit -> the provider received the request
 *   turn.provider_to_output_ms    the provider's answer -> the first visible
 *                                 agent output in the renderer
 *   turn.submit_to_output_ms      submit -> the first visible agent output
 *
 * The middle number is the one that separates "the model is slow" from "we
 * are slow": it is measured at the provider's own socket, so everything the
 * product does before the request leaves is in the FIRST number and nothing
 * else is in it.
 *
 * TWO TURNS IN ONE SESSION
 *
 * A sample sends TWO turns to the SAME session. The second turn runs in a
 * worker that already exists, so it is the turn that pays for whatever the
 * product re-does per turn instead of once per session. Comparing the two
 * turns is what separates "the cost is the model's" from "the cost is
 * ours, and we pay it every time".
 *
 * THE CHANNEL IS THE REAL ONE
 *
 * The turn is posted to the product's own agent server over SSE, the worker
 * really forks, and the provider really is the loopback Anthropic endpoint
 * speaking the real streaming wire protocol. The renderer is subscribed to
 * the same session, so the visible output is the product's own rendering of
 * the run, not a mock.
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
import { startLoopbackProvider } from '../lib/loopback-provider.mjs';
import { openSeededSession } from '../lib/scenario-kit.mjs';
import { round } from '../lib/metrics.mjs';

const MODEL = 'perf-loopback-model';
/** A loopback token, not a credential. */
const LOOPBACK_API_KEY = 'perf-loopback-not-a-credential';

/** How long one turn may take before the sample gives up on it. */
const TURN_BUDGET_MS = 120_000;

/**
 * The text the model "says". It is the marker the renderer is watched for, so
 * the "first visible output" is the AGENT's own output and not the user's
 * message bubble (which the product paints immediately).
 */
const OUTPUT_MARKER = 'PERF-AGENT-OUTPUT-MARKER';

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
 * Post one turn and watch it from the outside.
 *
 * The fetch is NOT awaited: the run has to be observed while it is in flight.
 * The promise resolves when the stream ends, and the collected timestamps say
 * when the first byte and the first content actually arrived.
 */
async function postTurn(page, args) {
  await page.evaluate((a) => {
    window.__perfTurn = {
      done: false,
      status: 0,
      error: null,
      text: '',
      firstChunkAt: null,
      firstContentAt: null,
      submittedAt: Date.now(),
    };
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
        window.__perfTurn.headersAt = Date.now();
        if (!response.body) {
          window.__perfTurn.done = true;
          return;
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (window.__perfTurn.firstChunkAt === null) window.__perfTurn.firstChunkAt = Date.now();
          const chunk = decoder.decode(value, { stream: true });
          window.__perfTurn.text += chunk;
          if (
            window.__perfTurn.firstContentAt === null
            && (chunk.includes('content_block_delta') || chunk.includes('thinking_delta'))
          ) {
            window.__perfTurn.firstContentAt = Date.now();
          }
        }
        window.__perfTurn.done = true;
      } catch (error) {
        window.__perfTurn.error = String(error && error.message ? error.message : error);
        window.__perfTurn.done = true;
      }
    })();
  }, args);
  return Date.now();
}

async function readTurnState(page) {
  return page.evaluate(() => window.__perfTurn ?? null);
}

/** How much the transcript changed — the "the user can see something" signal. */
async function readTranscriptState(page) {
  return page.evaluate(() => {
    const list = document.querySelector('.message-list-scroll');
    return {
      hasList: Boolean(list),
      rows: list ? list.querySelectorAll('[data-message-id]').length : 0,
      textLength: list ? (list.textContent ?? '').length : 0,
      text: list ? (list.textContent ?? '') : '',
    };
  });
}

/**
 * Wait for one turn to reach the provider and to show up in the renderer.
 *
 * The provider's request timestamp is read from the loopback server, which is
 * in THIS process: it is the exact instant the product handed the question to
 * the model, with no instrumentation inside the product.
 */
async function runTurn(page, provider, options) {
  const submittedAt = await postTurn(page, options);
  const providerRequestsBefore = provider.requests.length;

  const deadline = Date.now() + TURN_BUDGET_MS;
  let providerAt = null;
  let firstOutputAt = null;
  let state = null;
  while (Date.now() < deadline) {
    if (providerAt === null && provider.requests.length > providerRequestsBefore) {
      providerAt = provider.requests[provider.requests.length - 1].at;
    }
    state = await readTurnState(page);
    const transcript = await readTranscriptState(page);
    if (
      firstOutputAt === null
      && transcript.text.includes(OUTPUT_MARKER)
    ) {
      firstOutputAt = Date.now();
    }
    if (state?.done && providerAt !== null && firstOutputAt !== null) break;
    if (state?.done && providerAt === null) break;
    await page.waitForTimeout(50);
  }

  if (providerAt === null && provider.requests.length > providerRequestsBefore) {
    providerAt = provider.requests[provider.requests.length - 1].at;
  }
  if (firstOutputAt === null) {
    const transcript = await readTranscriptState(page);
    if (transcript.text.includes(OUTPUT_MARKER)) firstOutputAt = Date.now();
  }

  return {
    'turn.submit_to_provider_ms': providerAt === null ? null : round(providerAt - submittedAt),
    'turn.submit_to_output_ms': firstOutputAt === null ? null : round(firstOutputAt - submittedAt),
    'turn.provider_to_output_ms':
      providerAt === null || firstOutputAt === null ? null : round(firstOutputAt - providerAt),
    'turn.sse_first_chunk_ms':
      state?.firstChunkAt === null || state?.firstChunkAt === undefined
        ? null
        : round(state.firstChunkAt - submittedAt),
    'turn.sse_first_content_ms':
      state?.firstContentAt === null || state?.firstContentAt === undefined
        ? null
        : round(state.firstContentAt - submittedAt),
    'turn.provider_requests': provider.requests.length - providerRequestsBefore,
    'turn.status': state?.status ?? null,
    'turn.error': state?.error ?? null,
    'turn.done': state?.done ?? null,
  };
}

export default {
  id: 'send-to-first-output',
  title: 'From submitting a turn to the first visible agent output',
  fixture: 'the loopback Anthropic endpoint, two turns in one session',

  async run(ctx) {
    const samples = [];

    for (let index = 0; index < ctx.options.samples; index += 1) {
      const namespace = `send-${ctx.runId}-${index}`;
      const sessionId = `perf-send-${ctx.runId}-${index}`;
      const workspace = path.join(userDataRootFor(namespace), 'workspace');
      fs.mkdirSync(workspace, { recursive: true });

      const provider = await startLoopbackProvider({
        mode: 'text',
        model: MODEL,
        chunkCount: 1,
        intervalMs: 40,
        chunks: [{ text: OUTPUT_MARKER }],
      });

      // The product rejects a chat when the machine's memory is nearly full
      // (the agent server's own safety valve, 90% by default). That valve is
      // not what this scenario measures, and a developer's machine is often
      // above the line -- so it is raised here and the report says so.
      const measured = await launchPerfElectron({
        namespace,
        env: { DUYA_MEMORY_THRESHOLD: '0.99' },
      });
      let observed = {};
      try {
        await waitForAppReady(measured.page);
        await seedSession(measured.page, {
          sessionId,
          title: `perf send ${index}`,
          workingDirectory: workspace,
          messages: [],
        });
        await wakeConversationStore(measured.app, measured.page);
        await measured.page.reload({ waitUntil: 'domcontentloaded' });
        await waitForAppReady(measured.page);
        await wakeConversationStore(measured.app, measured.page);
        await openSeededSession(measured.page, { title: `perf send ${index}` });

        const agentUrl = await waitForAgentServerUrl(measured.page);
        const turnArgs = {
          baseUrl: agentUrl,
          sessionId,
          workspace,
          providerBaseUrl: provider.baseUrl,
          model: MODEL,
          apiKey: LOOPBACK_API_KEY,
        };

        // Turn 1 pays for everything the session has to set up.
        const first = await runTurn(measured.page, provider, {
          ...turnArgs,
          prompt: 'perf first turn',
        });
        // Turn 2 runs in the worker that turn 1 already built.
        const second = await runTurn(measured.page, provider, {
          ...turnArgs,
          prompt: 'perf second turn',
        });

        observed = {
          namespace,
          sessionId,
          first,
          second,
          consoleErrors: measured.consoleErrors.slice(0, 5),
          pageErrors: measured.pageErrors.slice(0, 5),
        };

        samples.push({
          index: samples.length,
          metrics: {
            'turn1.submit_to_provider_ms': first['turn.submit_to_provider_ms'],
            'turn1.submit_to_output_ms': first['turn.submit_to_output_ms'],
            'turn1.provider_to_output_ms': first['turn.provider_to_output_ms'],
            'turn2.submit_to_provider_ms': second['turn.submit_to_provider_ms'],
            'turn2.submit_to_output_ms': second['turn.submit_to_output_ms'],
            'turn2.provider_to_output_ms': second['turn.provider_to_output_ms'],
            // The gap between the two turns is what a per-turn cost shows up
            // as: the second turn reuses the worker, so anything it still
            // pays is paid PER TURN.
            'turn.repeat_cost_ms':
              first['turn.submit_to_provider_ms'] === null || second['turn.submit_to_provider_ms'] === null
                ? null
                : round(first['turn.submit_to_provider_ms'] - second['turn.submit_to_provider_ms']),
          },
          observed,
          error: first['turn.error'] ?? second['turn.error'] ?? null,
        });

        ctx.log(
          `send-to-first-output sample ${index}: `
            + `turn1 submit->provider=${first['turn.submit_to_provider_ms']}ms `
            + `turn2 submit->provider=${second['turn.submit_to_provider_ms']}ms`,
        );
      } catch (error) {
        samples.push({
          index: samples.length,
          metrics: {},
          observed: { namespace, sessionId, ...observed },
          error: String(error?.stack ?? error?.message ?? error),
        });
        ctx.log(`send-to-first-output sample ${index} failed: ${error?.message}`);
      } finally {
        await closePerfElectron(measured.app);
        await provider.close();
      }
    }

    return {
      samples,
      notes: {
        channel:
          'the turn is posted to the product\'s own agent server over SSE; the worker '
          + 'really forks; the provider is the loopback Anthropic endpoint speaking the '
          + 'real streaming wire protocol',
        submitToProvider:
          'submit -> the loopback provider received the request. The timestamp is read '
          + 'from the provider\'s own socket in the harness process, so everything the '
          + 'product does before the request leaves the machine is inside this number',
        submitToOutput:
          'submit -> the first visible agent output in the renderer (the transcript '
          + 'gained a row). This is the number the user waits for',
        repeatCost:
          'turn1 minus turn2 on submit->provider: what the product still pays PER TURN '
          + 'even though the worker already exists',
        providerToOutput:
          'the provider received the request -> the first visible output. Everything '
          + 'here is rendering and delivery, not preparation',
      },
    };
  },
};
