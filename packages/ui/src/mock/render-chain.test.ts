/**
 * Where the assistant text is lost, if it is.
 *
 * The chain the browser walks is:
 *
 *   bridge -> createUiServices -> run projection -> mergeRunSessionRows
 *   -> projectMessageTranscript -> the rows the chat view renders
 *
 * Each stage is the PRODUCT's code. This test walks all of them and asserts
 * the reply survives every one, so a regression names the stage that broke.
 */

import { describe, expect, it } from 'vitest';
import { createUiServices } from '@/services';
import { mergeRunSessionRows } from '@/lib/run-session-view';
import { projectMessageTranscript } from '@/lib/project-message-transcript';
import { createMockHostBridge } from './mock-host-bridge';
import { MOCK_SESSION_IDS } from './fixtures';

const POLL_INTERVAL_MS = 5;

async function projectMockRun(): Promise<Awaited<ReturnType<typeof mergeRunSessionRows>>[number][]> {
  const bridge = createMockHostBridge();
  const services = createUiServices({
    bridge,
    platform: 'web',
    capabilities: {
      localFileAccess: false,
      settings: false,
      extensions: false,
      bots: false,
      automation: false,
      workflows: false,
      turnConfiguration: true,
    },
    ledgerPollIntervalMs: POLL_INTERVAL_MS,
  });

  const sessionId = MOCK_SESSION_IDS.sidebar;
  const runs = await services.runs.listBySession(sessionId);
  const controller = new AbortController();
  const projection = services.runs.openSession(runs[0]!.runId, sessionId, controller.signal);
  projection.start();

  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const snapshot = projection.getSnapshot();
    if (snapshot.messages.length > 0 && snapshot.run.status === 'completed') break;
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
  const snapshot = projection.getSnapshot();
  controller.abort();
  return mergeRunSessionRows([], snapshot);
}

describe('mock assistant text survives the render chain', () => {
  it('keeps the reply text through merge and transcript projection', async () => {
    const merged = await projectMockRun();

    // Stage 1 — the projection produced a row with text.
    const assistant = merged.find((row) => row.role === 'assistant' && row.content !== '');
    expect(assistant, 'the projection produced no assistant text').toBeDefined();
    expect(String(assistant!.content)).toContain('信息架构');

    // Stage 2 — the transcript projector kept it.
    const projected = projectMessageTranscript(merged).messages;
    const projectedAssistant = projected.find((row) => row.role === 'assistant' && row.content !== '');
    expect(projectedAssistant, 'the transcript projection dropped the assistant text').toBeDefined();
    expect(JSON.stringify(projectedAssistant!.content)).toContain('信息架构');
  });
});
