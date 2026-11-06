/**
 * Plan 624 v2 G3 — the production prompt-section sink.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';

import {
  PROMPT_OBSERVE_ENV,
  installProductionPromptObserver,
  shouldInstallPromptObserver,
} from '@duya/host/worker-prompts/production-observer';
import {
  hasPromptObserver,
  reportPromptDigests,
  sectionDigest,
  setPromptObserver,
} from '@duya/host/worker-prompts/observer';
import { logger } from '@duya/host/worker-logger';

afterEach(() => {
  setPromptObserver(undefined);
  vi.restoreAllMocks();
});

describe('plan 624 v2 — production prompt observer', () => {
  it('is off unless explicitly enabled', () => {
    expect(shouldInstallPromptObserver({})).toBe(false);
    expect(shouldInstallPromptObserver({ [PROMPT_OBSERVE_ENV]: '0' })).toBe(false);
    expect(shouldInstallPromptObserver({ [PROMPT_OBSERVE_ENV]: '1' })).toBe(true);
    expect(shouldInstallPromptObserver({ DUYA_DUMP_PROMPT_SECTIONS: '1' })).toBe(true);
  });

  it('does not install or clear a sink when disabled', () => {
    expect(installProductionPromptObserver({})).toBe(false);
    expect(hasPromptObserver()).toBe(false);

    const existing = vi.fn();
    setPromptObserver(existing);
    expect(installProductionPromptObserver({})).toBe(false);
    expect(hasPromptObserver()).toBe(true);
  });

  it('is installed by the worker process entry, not at import time', () => {
    const entry = readFileSync(
      new URL('../../src/worker-process-entry.ts', import.meta.url),
      'utf8',
    );
    expect(entry).toContain('installProductionPromptObserver();');
    const start = entry.indexOf('export async function startWorkerProcess');
    expect(entry.indexOf('installProductionPromptObserver();')).toBeGreaterThan(start);
  });

  it('logs digests without ever logging prompt bodies', () => {
    const debug = vi.spyOn(logger, 'debug').mockImplementation(() => undefined);
    expect(installProductionPromptObserver({ [PROMPT_OBSERVE_ENV]: '1' })).toBe(true);
    expect(hasPromptObserver()).toBe(true);

    const secret = 'THIS-SYSTEM-PROMPT-BODY-MUST-NOT-BE-LOGGED';
    reportPromptDigests([
      sectionDigest('identity', secret, false),
      sectionDigest('environment', 'cwd=/tmp', true),
    ]);

    expect(debug).toHaveBeenCalledTimes(1);
    const [message, context, component] = debug.mock.calls[0]!;
    expect(message).toContain('rendered section digests');
    expect(component).toBe('PromptAssembly');
    const payload = context as {
      count: number;
      sections: Array<{ name: string; hash: string; length: number; volatile: boolean }>;
    };
    expect(payload.count).toBe(2);
    expect(payload.sections.map((entry) => entry.name)).toEqual(['identity', 'environment']);
    expect(payload.sections[1]?.volatile).toBe(true);
    expect(payload.sections[0]?.hash).toHaveLength(12);
    expect(JSON.stringify(payload)).not.toContain(secret);
    expect(JSON.stringify(payload)).not.toContain('cwd=/tmp');
  });
});
