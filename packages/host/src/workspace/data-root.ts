/**
 * The data root checkout paths are placed under.
 *
 * Kept apart from `paths.ts` so `settings.ts` can resolve `config.toml`
 * without importing the layout module, which itself reads those settings.
 * `DUYA_APP_DATA_PATH` stays the first override, matching the legacy module
 * and the Host tests that redirect checkout storage with it.
 */

import { resolveDataRoot } from '@duya/data/data-paths';

export function resolveCheckoutDataRoot(): string {
  return process.env.DUYA_APP_DATA_PATH?.trim() || resolveDataRoot();
}
