import { describe, expect, it } from 'vitest';
import { BashTool, validateBashInput } from '../src/tool/BashTool/BashTool.js';
import {
  BASH_DEFAULT_TIMEOUT_MS,
  BASH_MAX_FOREGROUND_TIMEOUT_MS,
  BASH_MAX_TIMEOUT_MS,
  BASH_SOFT_YIELD_MS,
} from '../src/tool/BashTool/constants.js';
import {
  getBashPrompt,
  getDefaultTimeoutMs,
  getMaxForegroundTimeoutMs,
  getMaxTimeoutMs,
  getSoftYieldMs,
} from '../src/tool/BashTool/prompt.js';
import { PowerShellTool } from '../src/tool/PowerShellTool/PowerShellTool.js';
import {
  formatWorkerFailureContent,
  normalizeWorkerInput,
} from '../src/tool/StreamingToolExecutor.js';

describe('BashTool contract', () => {
  it('keeps prompt timeout values aligned with runtime constants', () => {
    expect(getDefaultTimeoutMs()).toBe(BASH_DEFAULT_TIMEOUT_MS);
    expect(getMaxTimeoutMs()).toBe(BASH_MAX_TIMEOUT_MS);
    expect(getMaxForegroundTimeoutMs()).toBe(BASH_MAX_FOREGROUND_TIMEOUT_MS);
    expect(getSoftYieldMs()).toBe(BASH_SOFT_YIELD_MS);

    const prompt = getBashPrompt();
    expect(prompt).toContain(`default ${BASH_DEFAULT_TIMEOUT_MS}ms`);
    expect(prompt).toContain(`ceiling ${BASH_MAX_FOREGROUND_TIMEOUT_MS}ms`);
    expect(prompt).toContain(`up to ${BASH_MAX_TIMEOUT_MS}ms`);
    expect(prompt).toContain(`${BASH_SOFT_YIELD_MS}ms`);
  });

  it('advertises the new soft-yield and foreground ceiling in input_schema', () => {
    const tool = new BashTool();

    expect(tool.input_schema).toMatchObject({
      properties: {
        run_in_background: {
          type: 'boolean',
        },
        timeout: {
          type: 'number',
        },
      },
    });

    const schemaJson = JSON.stringify(tool.input_schema);
    expect(schemaJson).toContain(String(BASH_MAX_FOREGROUND_TIMEOUT_MS));
    expect(schemaJson).toContain(String(BASH_SOFT_YIELD_MS));
  });

  it('caps foreground timeout at the foreground ceiling', () => {
    const toolLong = validateBashInput({
      command: 'npm run dev',
      timeout: BASH_MAX_FOREGROUND_TIMEOUT_MS + 1,
    });
    expect(toolLong.valid).toBe(false);
    if (!toolLong.valid) {
      expect(toolLong.error).toContain('foreground');
    }

    const toolOk = validateBashInput({
      command: 'npm run dev',
      timeout: BASH_MAX_FOREGROUND_TIMEOUT_MS,
    });
    expect(toolOk.valid).toBe(true);
  });

  it('keeps the historical 10-min ceiling for background commands', () => {
    const toolBgOk = validateBashInput({
      command: 'npm run dev',
      run_in_background: true,
      timeout: BASH_MAX_TIMEOUT_MS,
    });
    expect(toolBgOk.valid).toBe(true);

    const toolBgTooLong = validateBashInput({
      command: 'npm run dev',
      run_in_background: true,
      timeout: BASH_MAX_TIMEOUT_MS + 1,
    });
    expect(toolBgTooLong.valid).toBe(false);
  });

  it('advertises and validates run_in_background consistently', () => {
    const tool = new BashTool();

    expect(tool.input_schema).toMatchObject({
      properties: {
        run_in_background: {
          type: 'boolean',
        },
      },
    });

    const result = validateBashInput({
      command: 'npm run dev',
      run_in_background: true,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.run_in_background).toBe(true);
      expect(result.data.background).toBe(true);
    }
  });

  it('accepts the legacy background alias without breaking callers', () => {
    const result = validateBashInput({
      command: 'npm run dev',
      background: true,
    });

    expect(result.valid).toBe(true);
    if (result.valid) {
      expect(result.data.background).toBe(true);
    }
  });

  it('exposes powershell as a first-class shell tool', () => {
    const tool = new PowerShellTool();

    expect(tool.name).toBe('powershell');
    expect(tool.description).toContain('PowerShell');
    expect(tool.input_schema).toMatchObject({
      properties: {
        command: {
          type: 'string',
        },
        run_in_background: {
          type: 'boolean',
        },
      },
    });
  });

  it('normalizes worker aliases before dispatching to BashWorker', () => {
    const { input, normalizationNote } = normalizeWorkerInput('bash', {
      cmd: 'echo hello',
      run_in_background: true,
    });

    expect(input.command).toBe('echo hello');
    expect(input.background).toBe(true);
    expect(normalizationNote).toContain('normalized cmd -> command');
    expect(normalizationNote).toContain('normalized run_in_background -> background');
  });

  it('normalizes powershell worker aliases with the same contract', () => {
    const { input, normalizationNote } = normalizeWorkerInput('powershell', {
      script: 'Write-Output hello',
      run_in_background: true,
    });

    expect(input.command).toBe('Write-Output hello');
    expect(input.background).toBe(true);
    expect(normalizationNote).toContain('normalized script -> command');
    expect(normalizationNote).toContain('normalized run_in_background -> background');
  });

  it('preserves command output when formatting worker failures', () => {
    const content = formatWorkerFailureContent({
      error: 'Exit code: 1',
      exitCode: 1,
      result: 'SyntaxError: unterminated string literal',
    });

    expect(content).toContain('<tool_use_error>Exit code: 1 exitCode=1</tool_use_error>');
    expect(content).toContain('Command output:');
    expect(content).toContain('SyntaxError: unterminated string literal');
  });
});
