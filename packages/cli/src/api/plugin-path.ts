import path from 'node:path';
import os from 'node:os';

/** Resolve user-selected local sources on the client, before crossing to a long-lived Host. */
export function resolveLocalPluginPath(value: string, cwd: string): string {
  const expanded = value === '~' ? os.homedir() : /^~[\\/]/u.test(value) ? path.join(os.homedir(), value.slice(2)) : value;
  return path.resolve(cwd, expanded);
}
