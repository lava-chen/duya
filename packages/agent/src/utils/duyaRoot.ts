/**
 * DUYA per-user root directory resolution.
 *
 * Canonical root is `~/.duya` (mirroring pi). The Electron host overrides it
 * via DUYA_APP_DATA_PATH when a test-namespaced directory is required.
 */

import { homedir } from 'os';
import { join, resolve } from 'path';
import { mkdirSync } from 'fs';

const TEST_NAMESPACE_PATTERN = /^[a-zA-Z0-9_-]+$/;

/** Legacy agent paths mirror the data root until these writers move behind Host. */
export function getDuyaRoot(): string {
  const legacyOverride = process.env.DUYA_APP_DATA_PATH?.trim();
  if (!process.env.DUYA_DATA_ROOT?.trim() && legacyOverride) return legacyOverride;

  if (process.env.DUYA_TEST === '1') {
    const args = process.argv;
    const inline = args.find((arg) => arg.startsWith('--duya-namespace='));
    const flagIndex = args.indexOf('--duya-namespace');
    const namespace = inline
      ? inline.slice('--duya-namespace='.length)
      : flagIndex >= 0
        ? args[flagIndex + 1]
        : process.env.DUYA_TEST_NAMESPACE;
    if (namespace && TEST_NAMESPACE_PATTERN.test(namespace)) {
      return join(homedir(), '.duya', 'test-namespaces', namespace);
    }
  }

  const explicitRoot = process.env.DUYA_DATA_ROOT?.trim();
  if (explicitRoot) return resolve(explicitRoot);
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
