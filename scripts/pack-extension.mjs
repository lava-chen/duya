import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const extDir = path.join(rootDir, 'extension');
const outZip = path.join(rootDir, 'extension', 'duya-browser-bridge.zip');

// Required files for Chrome Web Store
const requiredFiles = ['privacy_policy.html'];
for (const file of requiredFiles) {
  if (!fs.existsSync(path.join(extDir, file))) {
    console.error(`ERROR: ${file} is missing! It is required for Chrome Web Store submission.`);
    process.exit(1);
  }
}

const manifest = JSON.parse(fs.readFileSync(path.join(extDir, 'manifest.json'), 'utf-8'));
console.log(`Packing ${manifest.name} v${manifest.version}...`);

if (fs.existsSync(outZip)) {
  fs.unlinkSync(outZip);
}

const isWin = process.platform === 'win32';

if (isWin) {
  execSync(
    `powershell -NoProfile -Command "Compress-Archive -Path '${extDir}\\*' -DestinationPath '${outZip}' -Force"`,
    { stdio: 'inherit', cwd: rootDir }
  );
} else {
  execSync(
    `cd "${extDir}" && zip -r "${outZip}" . -x "*.zip"`,
    { stdio: 'inherit', shell: true }
  );
}

const sizeKB = (fs.statSync(outZip).size / 1024).toFixed(1);
console.log(`Done: ${outZip} (${sizeKB} KB)`);