/**
 * Tests for BashTool's timeout contract (foreground/background ceilings).
 *
 * Verifies the contract documented in `BashTool/constants.ts`:
 *   - Default foreground timeout stays at BASH_DEFAULT_TIMEOUT_MS (120s).
 *   - Foreground ceiling is BASH_MAX_FOREGROUND_TIMEOUT_MS (300s, 5 min).
 *   - Background ceiling stays at BASH_MAX_TIMEOUT_MS (600s, 10 min).
 *   - A foreground command still running after BASH_SOFT_YIELD_MS is
 *     auto-promoted to a background task (behavior covered end-to-end in
 *     soft-yield.test.ts; this file locks the model-facing wording).
 *
 * We exercise `validateBashInput` (pure) and `BashTool.input_schema` (model-
 * facing contract) but skip live subprocess execution.
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
  getDefaultTimeoutMs,
  getMaxForegroundTimeoutMs,
  getMaxTimeoutMs,
} from '../../../src/tool/BashTool/prompt.js';

describe('BashTool — timeout constants', () => {
  it('caps foreground timeout at 5 minutes', () => {
    expect(BASH_MAX_FOREGROUND_TIMEOUT_MS).toBe(300_000);
    expect(getMaxForegroundTimeoutMs()).toBe(BASH_MAX_FOREGROUND_TIMEOUT_MS);
  });

  it('keeps the default foreground timeout at 120s', () => {
    expect(BASH_DEFAULT_TIMEOUT_MS).toBe(120_000);
    expect(getDefaultTimeoutMs()).toBe(BASH_DEFAULT_TIMEOUT_MS);
  });

  it('keeps the background ceiling at the historical 10 minutes', () => {
    expect(BASH_MAX_TIMEOUT_MS).toBe(600_000);
    expect(getMaxTimeoutMs()).toBe(BASH_MAX_TIMEOUT_MS);
  });

  it('keeps the soft-yield window at 15s and below the foreground ceiling', () => {
    expect(BASH_SOFT_YIELD_MS).toBe(15_000);
    expect(BASH_SOFT_YIELD_MS).toBeLessThan(BASH_DEFAULT_TIMEOUT_MS);
  });
});

describe('BashTool — timeout validation', () => {
  it('accepts the foreground ceiling exactly', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      timeout: BASH_MAX_FOREGROUND_TIMEOUT_MS,
    });
    expect(result.valid).toBe(true);
  });

  it('rejects a foreground timeout above the ceiling', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      timeout: BASH_MAX_FOREGROUND_TIMEOUT_MS + 1,
    });
    expect(result.valid).toBe(false);
    if (!result.valid) {
      expect(result.error).toContain(String(BASH_MAX_FOREGROUND_TIMEOUT_MS));
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

describe('BashTool — schema advertises the timeout contract', () => {
  it('mentions the foreground and background ceilings in timeout description', () => {
    const tool = new BashTool();
    const schema = JSON.stringify(tool.input_schema);
    expect(schema).toContain(String(BASH_MAX_FOREGROUND_TIMEOUT_MS));
    expect(schema).toContain(String(BASH_MAX_TIMEOUT_MS));
  });

  it('tells the model an explicit run_in_background returns a task id', () => {
    const tool = new BashTool();
    const schema = JSON.stringify(tool.input_schema);
    expect(schema).toContain('task id');
  });

  it('advertises foreground soft-yield auto-promotion in the timeout field', () => {
    const tool = new BashTool();
    const schema = JSON.stringify(tool.input_schema);
    expect(schema).toContain('auto-promoted');
    expect(schema).toContain(String(BASH_SOFT_YIELD_MS));
  });
});

describe('BashTool — prompt timeout guidance', () => {
  it('mentions the foreground and background ceilings', () => {
    const prompt = getBashPrompt();
    expect(prompt).toContain(String(BASH_MAX_FOREGROUND_TIMEOUT_MS));
    expect(prompt).toContain(String(BASH_MAX_TIMEOUT_MS));
  });

  it('explains soft-yield auto-promotion in the prompt', () => {
    const prompt = getBashPrompt();
    expect(prompt).toContain('auto-promoted');
    expect(prompt).toContain(String(BASH_SOFT_YIELD_MS));
    expect(prompt).toContain('Do not re-run');
  });

  it('warns against inflating timeout to mask hung commands', () => {
    const prompt = getBashPrompt();
    expect(prompt.toLowerCase()).toContain('do not increase');
  });
});
