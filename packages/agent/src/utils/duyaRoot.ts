/**
 * DUYA per-user root directory resolution.
 *
 * Canonical root is `~/.duya` (mirroring pi). The Electron host overrides it
 * via DUYA_APP_DATA_PATH when a test-namespaced directory is required.
 */

import { homedir } from 'os';
import { join } from 'path';
import { mkdirSync } from 'fs';

export function getDuyaRoot(): string {
  const envPath = process.env.DUYA_APP_DATA_PATH;
  if (envPath) return envPath;
  return join(homedir(), '.duya');
}

/**
 * Directory for spilled BashTool output (background-task logs and
 * truncation spill files). Created lazily on first use.
 */
export function getBashOutputDir(): string {
  const dir = join(getDuyaRoot(), 'bash-outputs');
  mkdirSync(dir, { recursive: true });
  return dir;
}
