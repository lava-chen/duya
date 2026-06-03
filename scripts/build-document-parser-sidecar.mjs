import { spawnSync } from 'child_process';
import path from 'path';
import process from 'process';

if (process.platform !== 'win32') {
  console.log('[docparser] Skipping sidecar build on non-Windows platform');
  process.exit(0);
}

const scriptPath = path.join(process.cwd(), 'scripts', 'build-document-parser-sidecar.ps1');
const result = spawnSync(
  'powershell',
  ['-ExecutionPolicy', 'Bypass', '-File', scriptPath],
  {
    stdio: 'inherit',
    cwd: process.cwd(),
  },
);

if (result.error) {
  console.error('[docparser] Failed to start PowerShell sidecar build:', result.error.message);
  process.exit(1);
}

process.exit(result.status ?? 1);
