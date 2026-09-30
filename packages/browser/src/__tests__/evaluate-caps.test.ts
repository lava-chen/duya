import { describe, it, expect } from 'vitest';
import { evaluateAction, iframeEvaluateAction } from '../actions/evaluate.js';
import type { ActionContext } from '../actions/types.js';

const EVALUATE_RESULT_MAX_CHARS = 50_000;

function makeCtx(cdp: Record<string, unknown>): ActionContext {
  return {
    cdp,
    mode: 'webview',
    browserBackendMode: 'built-in',
    extensionAvailable: false,
    checkDomainBlocked: () => false,
  } as unknown as ActionContext;
}

describe('evaluateAction result cap', () => {
  it('passes small results through unchanged', async () => {
    const raw = { value: 42, nested: { ok: true } };
    const out = await evaluateAction.execute(
      { script: 'return {value:42}' },
      makeCtx({ evaluate: async () => raw }),
    );
    expect(out.result).toEqual(raw);
    expect(out.truncated).toBeUndefined();
  });

  it('truncates oversized results and flags them', async () => {
    const huge = 'x'.repeat(EVALUATE_RESULT_MAX_CHARS + 5000);
    const out = await evaluateAction.execute(
      { script: 'window.__data' },
      makeCtx({ evaluate: async () => huge }),
    );
    expect(out.truncated).toBe(true);
    expect(typeof out.result).toBe('string');
    const text = out.result as string;
    expect(text.length).toBeLessThan(huge.length);
    expect(text).toContain('[truncated');
    expect(text.startsWith('x')).toBe(true);
  });

  it('caps objects whose serialization exceeds the budget', async () => {
    const bigObject = { items: Array.from({ length: 5000 }, (_, i) => ({ i, pad: 'y'.repeat(40) })) };
    const out = await evaluateAction.execute(
      { script: 'collect()' },
      makeCtx({ evaluate: async () => bigObject }),
    );
    expect(out.truncated).toBe(true);
    expect((out.result as string).length).toBeLessThanOrEqual(EVALUATE_RESULT_MAX_CHARS + 200);
  });

  it('caps non-serializable results via String()', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic['self'] = cyclic;
    cyclic['pad'] = 'z'.repeat(EVALUATE_RESULT_MAX_CHARS + 100);
    const out = await evaluateAction.execute(
      { script: 'cyclic()' },
      makeCtx({ evaluate: async () => cyclic }),
    );
    expect(out.truncated).toBe(true);
  });
});

describe('iframe_evaluateAction result cap', () => {
  it('truncates oversized frame results too', async () => {
    const huge = 'a'.repeat(EVALUATE_RESULT_MAX_CHARS + 10);
    const out = await iframeEvaluateAction.execute(
      { frameIndex: 0, script: 'document.body.innerText' },
      makeCtx({ evaluateInFrame: async () => huge }),
    );
    expect(out.truncated).toBe(true);
    expect(typeof out.result).toBe('string');
    expect((out.result as string)).toContain('[truncated');
  });

  it('passes small frame results through unchanged', async () => {
    const out = await iframeEvaluateAction.execute(
      { frameIndex: 1, script: 'document.title' },
      makeCtx({ evaluateInFrame: async () => 'hello' }),
    );
    expect(out.result).toBe('hello');
    expect(out.frameIndex).toBe(1);
    expect(out.truncated).toBeUndefined();
  });
});
