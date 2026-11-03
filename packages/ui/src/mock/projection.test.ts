import { describe, expect, it } from 'vitest';
import { SurfaceModel } from '@duya/client-core';
import { MOCK_RUNS } from './fixtures';

describe('mock run script', () => {
  it('projects the scripted reply into an assistant message', () => {
    const fixture = MOCK_RUNS.find((run) => run.runId === 'mock-run-sidebar');
    expect(fixture).toBeDefined();

    const model = new SurfaceModel();
    for (const envelope of fixture!.events) {
      model.apply(envelope);
    }

    const messages = model.messages;
    expect(messages.length).toBe(1);
    expect(messages[0]!.text).toContain('信息架构');
    expect(model.toolCalls.length).toBe(1);
  });

  /**
   * The reply has to come AFTER the tool call.
   *
   * The renderer lifts only the text that follows the LAST tool/thinking
   * action into the visible reply; text before it is intermediate narration
   * and stays folded inside the collapsed tool group. A script that replies
   * first therefore renders as an empty round — a bug that is invisible in
   * the projection (the text is there) and only shows up on screen.
   */
  it('orders the reply after the tool call so it renders as the final answer', () => {
    const fixture = MOCK_RUNS.find((run) => run.runId === 'mock-run-sidebar');
    expect(fixture).toBeDefined();

    const types = fixture!.events.map((event) => event.payload.type);
    const toolIndex = types.indexOf('tool.call_started');
    const textIndex = types.indexOf('assistant.text_delta');
    expect(toolIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThanOrEqual(0);
    expect(textIndex).toBeGreaterThan(toolIndex);
  });
});
