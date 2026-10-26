/**
 * The duya root (test-namespace aware).
 *
 * The duya root owns the memory tree (`<root>/memory`) and the agent /
 * project shard layout (`<root>/agents`, `<root>/projects`). Under
 * `DUYA_TEST=1` the whole tree is namespaced, so the memory-tier writer,
 * the forget ledger and the forget repair all have to resolve the same
 * root.
 */

import * as os from 'os';
import * as path from 'path';

/** Resolve the duya root (~/.duya, test-namespace aware). */
export function resolveDuyaRoot(): string {
  const base = path.join(os.homedir(), '.duya');
  if (process.env.DUYA_TEST === '1') {
    const ns = process.env.DUYA_TEST_NAMESPACE;
    if (ns && /^[a-zA-Z0-9_-]+$/.test(ns)) return path.join(base, 'test-namespaces', ns);
  }
  return base;
}
