/**
 * Plan 624 v2 G3 — production sink for prompt-section digests.
 *
 * `observer.ts` deliberately stayed opt-in and process-level: without a sink
 * the producers skip hashing entirely. But nothing ever installed one outside
 * tests, so the plan 619 Phase 0 observation seam produced no evidence in a
 * real worker.
 *
 * This module is the ONLY production installer. It is imported by the worker
 * process entry, not by the prompt modules, so the pure prompt layer keeps no
 * logger dependency. Digests contain names, short hashes, lengths and the
 * volatility flag — never prompt bodies.
 */
import { logger } from '@duya/host/worker-logger';

import { setPromptObserver } from './observer.js';

/** Explicit opt-in. The legacy dump switch also enables the sink. */
export const PROMPT_OBSERVE_ENV = 'DUYA_PROMPT_OBSERVE';

export function shouldInstallPromptObserver(env: NodeJS.ProcessEnv): boolean {
  return env[PROMPT_OBSERVE_ENV] === '1' || env.DUYA_DUMP_PROMPT_SECTIONS === '1';
}

/**
 * Install the structured-log sink when observation is enabled.
 *
 * Returns whether a sink was installed. Disabled installs are a no-op: they
 * do not clear a sink a test or an embedding host already installed.
 */
export function installProductionPromptObserver(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!shouldInstallPromptObserver(env)) return false;
  setPromptObserver((digests) => {
    logger.debug(
      '[prompt-sections] rendered section digests',
      {
        count: digests.length,
        sections: digests.map((digest) => ({
          name: digest.sectionName,
          hash: digest.hash.slice(0, 12),
          length: digest.length,
          volatile: digest.volatile,
        })),
      },
      'PromptAssembly',
    );
  });
  return true;
}
