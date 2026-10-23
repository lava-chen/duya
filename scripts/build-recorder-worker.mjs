import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tsc = require.resolve('typescript/bin/tsc');
const config = path.join(root, 'apps/desktop/tsconfig.recorder-worker.json');
const result = spawnSync(process.execPath, [tsc, '--project', config], {
  cwd: root,
  stdio: 'inherit',
});

if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
