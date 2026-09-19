/**
 * Tests for BashTool's foreground soft-yield auto-promotion behaviour.
 *
 * Verifies the contract documented in `BashTool/constants.ts`:
 *   - Default foreground timeout stays at BASH_DEFAULT_TIMEOUT_MS (120s).
 *   - Foreground ceiling is BASH_MAX_FOREGROUND_TIMEOUT_MS (300s, 5 min).
 *   - Background ceiling stays at BASH_MAX_TIMEOUT_MS (600s, 10 min).
 *   - The soft-yield window is BASH_SOFT_YIELD_MS (15s).
 *
 * We exercise `validateBashInput` (pure) and `BashTool.input_schema` (model-
 * facing contract) but skip live subprocess execution — the BashWorker
 * tests cover the spawn path.
 */

import { describe, expect, it } from 'vitest';

import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_FOREGROUND_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  BASH_SOFT_YIELD_MS,
} from '../../../src/tool/BashTool/constants.js';
import {
  BashTool,
  validateBashInput,
} from '../../../src/tool/BashTool/BashTool.js';
import {
  getBashPrompt,
  getMaxForegroundTimeoutMs,
  getSoftYieldMs,
} from '../../../src/tool/BashTool/prompt.js';

describe('BashTool — soft-yield constants', () => {
  it('keeps the soft-yield window at 15s', () => {
    expect(BASH_SOFT_YIELD_MS).toBe(15_000);
    expect(getSoftYieldMs()).toBe(BASH_SOFT_YIELD_MS);
  });

  it('caps foreground timeout at 5 minutes', () => {
    expect(BASH_MAX_FOREGROUND_TIMEOUT_MS).toBe(300_000);
    expect(getMaxForegroundTimeoutMs()).toBe(BASH_MAX_FOREGROUND_TIMEOUT_MS);
  });

  it('keeps the default foreground timeout at 120s', () => {
    expect(BASH_DEFAULT_TIMEOUT_MS).toBe(120_000);
  });

  it('keeps the background ceiling at the historical 10 minutes', () => {
    expect(BASH_MAX_TIMEOUT_MS).toBe(600_000);
  });
});

describe('BashTool — foreground timeout validation', () => {
  it('accepts the foreground ceiling exactly', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      timeout: BASH_MAX_FOREGROUND_TIMEOUT_MS,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a foreground timeout above the ceiling with a hint to use background', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      timeout: BASH_MAX_FOREGROUND_TIMEOUT_MS + 1,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain('foreground');
      expect(result.error).toContain('run_in_background');
    }
  });

  it('still accepts the historical 10-min ceiling when background is requested', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      run_in_background: true,
      timeout: BASH_MAX_TIMEOUT_MS,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects background timeouts above the absolute maximum', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      run_in_background: true,
      timeout: BASH_MAX_TIMEOUT_MS + 1,
    });
    expect(result.valid).toBe(false);
  });

  it('accepts the legacy background alias and applies the background ceiling', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      background: true,
      timeout: BASH_MAX_TIMEOUT_MS,
    });
    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.background).toBe(true);
      expect(result.data.run_in_background).toBeUndefined();
    }
  });
});

describe('BashTool — schema advertises soft-yield', () => {
  it('mentions the foreground ceiling and soft-yield window in timeout description', () => {
    const tool = new BashTool();
    const schema = JSON.stringify(tool.input_schema);
    expect(schema).toContain(String(BASH_MAX_FOREGROUND_TIMEOUT_MS));
    expect(schema).toContain(String(BASH_SOFT_YIELD_MS));
  });

  it('tells the model a foreground command may return a task id after 15s', () => {
    const tool = new BashTool();
    const schema = JSON.stringify(tool.input_schema);
    expect(schema).toContain('task id');
    expect(schema).toContain(String(BASH_SOFT_YIELD_MS));
  });
});

describe('BashTool — prompt advertises soft-yield', () => {
  it('mentions the soft-yield window and the foreground ceiling', () => {
    const prompt = getBashPrompt();
    expect(prompt).toContain(String(BASH_SOFT_YIELD_MS));
    expect(prompt).toContain(String(BASH_MAX_FOREGROUND_TIMEOUT_MS));
    expect(prompt).toContain('auto-promoted');
  });

  it('warns against inflating timeout to mask hung commands', () => {
    const prompt = getBashPrompt();
    expect(prompt.toLowerCase()).toContain('do not increase');
  });
});