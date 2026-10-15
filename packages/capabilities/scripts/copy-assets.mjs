import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(packageRoot, 'src/AppConnectionTool/approval-templates.json');
const target = resolve(packageRoot, 'dist/AppConnectionTool/approval-templates.json');

// Optional templates retain the renderer's missing/malformed-file fallback.
if (existsSync(source)) {
  mkdirSync(dirname(target), { recursive: true });
  copyFileSync(source, target);
}
