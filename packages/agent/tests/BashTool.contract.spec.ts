import { describe, expect, it } from 'vitest';
import { BashTool, validateBashInput } from '../src/tool/BashTool/BashTool.js';
import { BASH_DEFAULT_TIMEOUT_MS, BASH_MAX_TIMEOUT_MS } from '../src/tool/BashTool/constants.js';
import { getBashPrompt, getDefaultTimeoutMs, getMaxTimeoutMs } from '../src/tool/BashTool/prompt.js';
import { PowerShellTool } from '../src/tool/PowerShellTool/PowerShellTool.js';
import {
  formatWorkerFailureContent,
  normalizeWorkerInput,
} from '../src/tool/StreamingToolExecutor.js';

describe('BashTool contract', () => {
  it('keeps prompt timeout values aligned with runtime constants', () => {
    expect(getDefaultTimeoutMs()).toBe(BASH_DEFAULT_TIMEOUT_MS);
    expect(getMaxTimeoutMs()).toBe(BASH_MAX_TIMEOUT_MS);

    const prompt = getBashPrompt();
    expect(prompt).toContain(`Default timeout is ${BASH_DEFAULT_TIMEOUT_MS}ms`);
    expect(prompt).toContain(`up to ${BASH_MAX_TIMEOUT_MS}ms`);
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
