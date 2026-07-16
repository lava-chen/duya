import { describe, expect, it, vi } from 'vitest';
import { createHasPermissionsToUseTool } from '../../../src/permissions/permissions.js';
import type { ToolPermissionContext } from '../../../src/permissions/types.js';
import type { LLMClient } from '../../../src/llm/base.js';

function permissionContext(): ToolPermissionContext {
  return {
    mode: 'auto',
    additionalWorkingDirectories: new Map(),
    alwaysAllowRules: {},
    alwaysDenyRules: {},
    alwaysAskRules: {},
    isBypassPermissionsModeAvailable: false,
  };
}

function checkContext(llmClient?: LLMClient) {
  return {
    getAppState: () => ({
      toolPermissionContext: permissionContext(),
    }),
    abortController: new AbortController(),
    llmClient,
    classifierModel: llmClient ? 'classifier-model' : undefined,
    messages: [],
  };
}

describe('auto mode low-risk local permissions', () => {
  it('allows safe allowlisted tools without calling the classifier', async () => {
    const classifier = {
      generate: vi.fn(async () => {
        throw new Error('classifier should not be called');
      }),
    } as unknown as LLMClient;

    const decision = await createHasPermissionsToUseTool()(
      'Read',
      { file_path: 'README.md' },
      checkContext(classifier),
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.decisionReason?.type).toBe('safetyCheck');
    expect(classifier.generate).not.toHaveBeenCalled();
  });

  it('allows normal Bash inspection commands without calling the classifier', async () => {
    const classifier = {
      generate: vi.fn(async () => {
        throw new Error('classifier should not be called');
      }),
    } as unknown as LLMClient;

    const decision = await createHasPermissionsToUseTool()(
      'Bash',
      { command: 'ls -la' },
      checkContext(classifier),
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.decisionReason?.type).toBe('safetyCheck');
    expect(classifier.generate).not.toHaveBeenCalled();
  });

  it('allows normal PowerShell inspection commands without calling the classifier', async () => {
    const classifier = {
      generate: vi.fn(async () => {
        throw new Error('classifier should not be called');
      }),
    } as unknown as LLMClient;

    const decision = await createHasPermissionsToUseTool()(
      'powershell',
      { command: 'Get-ChildItem -Force' },
      checkContext(classifier),
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.decisionReason?.type).toBe('safetyCheck');
    expect(classifier.generate).not.toHaveBeenCalled();
  });

  it('allows low-risk browser navigation without calling the classifier', async () => {
    const classifier = {
      generate: vi.fn(async () => {
        throw new Error('classifier should not be called');
      }),
    } as unknown as LLMClient;

    const decision = await createHasPermissionsToUseTool()(
      'browser',
      { operation: 'navigate', url: 'https://example.com' },
      checkContext(classifier),
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.decisionReason?.type).toBe('safetyCheck');
    expect(classifier.generate).not.toHaveBeenCalled();
  });

  it('allows low-risk browser screenshots without calling the classifier', async () => {
    const classifier = {
      generate: vi.fn(async () => {
        throw new Error('classifier should not be called');
      }),
    } as unknown as LLMClient;

    const decision = await createHasPermissionsToUseTool()(
      'browser',
      { operation: 'screenshot', fullPage: true },
      checkContext(classifier),
    );

    expect(decision.behavior).toBe('allow');
    expect(decision.decisionReason?.type).toBe('safetyCheck');
    expect(classifier.generate).not.toHaveBeenCalled();
  });

  it('does not locally allow browser interactions with page side effects', async () => {
    const decision = await createHasPermissionsToUseTool()(
      'browser',
      { operation: 'click', ref: '@3' },
      checkContext(),
    );

    expect(decision.behavior).toBe('ask');
  });

  it('does not locally allow browser JavaScript evaluation', async () => {
    const decision = await createHasPermissionsToUseTool()(
      'browser',
      { operation: 'evaluate', script: 'document.querySelector("form")?.submit()' },
      checkContext(),
    );

    expect(decision.behavior).toBe('ask');
  });

  it('does not locally allow parallel fetch with page JavaScript evaluation', async () => {
    const decision = await createHasPermissionsToUseTool()(
      'browser',
      {
        operation: 'parallel_fetch',
        urls: ['https://example.com'],
        evaluate: 'localStorage.clear()',
      },
      checkContext(),
    );

    expect(decision.behavior).toBe('ask');
  });

  it('does not locally allow commands that read sensitive files', async () => {
    const decision = await createHasPermissionsToUseTool()(
      'Bash',
      { command: 'cat .env' },
      checkContext(),
    );

    expect(decision.behavior).toBe('ask');
  });

  it('does not locally allow mutating shell commands', async () => {
    const decision = await createHasPermissionsToUseTool()(
      'powershell',
      { command: 'Remove-Item ./tmp.txt' },
      checkContext(),
    );

    expect(decision.behavior).toBe('ask');
  });
});
