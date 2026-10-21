import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveDataRoot } from '@duya/data/data-paths';

/** Match the legacy Agent override while keeping the canonical Host data root. */
export function getManagedShellDataRoot(): string {
  const legacyRoot = process.env.DUYA_APP_DATA_PATH?.trim();
  if (!process.env.DUYA_DATA_ROOT?.trim() && legacyRoot) return resolve(legacyRoot);

  // `resolveDataRoot` owns test namespace and DUYA_DATA_ROOT handling.
  return resolveDataRoot();
}

export function getManagedShellOutputDirectory(dataRoot = getManagedShellDataRoot()): string {
  const directory = join(dataRoot, 'bash-outputs');
  mkdirSync(directory, { recursive: true });
  return directory;
}
