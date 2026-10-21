import * as fs from 'node:fs';
import * as path from 'node:path';

/** Resolve the Host worker entry used by both `duya serve` and `duya tui`. */
export function resolveHostWorkerPath(): string | undefined {
  const explicit = process.env.DUYA_HOST_WORKER_PATH;
  if (explicit !== undefined && explicit.trim().length > 0) return path.resolve(explicit.trim());

  const devBundle = path.join(process.cwd(), 'packages', 'host', 'bundle', 'worker-entry.js');
  return fs.existsSync(devBundle) ? devBundle : undefined;
}
