/**
 * Build DUYA Browser Bridge Extension
 * Creates a zip file for manual installation
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');
const extensionDir = path.join(rootDir, 'extension');
const distDir = path.join(rootDir, 'dist-extension');

function buildExtension() {
  console.log('Building DUYA Browser Bridge Extension...');

  // Clean and create dist directory
  if (fs.existsSync(distDir)) {
    fs.rmSync(distDir, { recursive: true });
  }
  fs.mkdirSync(distDir, { recursive: true });

  // Copy extension files
  const files = [
    'manifest.json',
    'background.js',
    'popup.html',
    'popup.js',
    'icon16.png',
    'icon48.png',
    'icon128.png',
  ];

  for (const file of files) {
    const src = path.join(extensionDir, file);
    const dest = path.join(distDir, file);
    if (fs.existsSync(src)) {
      fs.copyFileSync(src, dest);
      console.log(`  ✓ ${file}`);
    } else {
      console.log(`  ⚠ ${file} not found, skipping`);
    }
  }

  // Create zip file
  const zipPath = path.join(rootDir, 'duya-browser-bridge.zip');
  createZip(distDir, zipPath);

  console.log(`\nExtension built successfully!`);
  console.log(`  Location: ${distDir}`);
  console.log(`  Zip: ${zipPath}`);
  console.log(`\nInstall instructions:`);
  console.log(`  1. Open Chrome and navigate to chrome://extensions/`);
  console.log(`  2. Enable "Developer mode" (toggle in top right)`);
  console.log(`  3. Click "Load unpacked" and select the "dist-extension" folder`);
  console.log(`  4. Or drag and drop the .zip file`);
}

function createZip(sourceDir, outPath) {
  // Simple zip creation using Node.js built-in modules
  // In production, use a proper zip library like adm-zip
  const archiver = tryImport('archiver');
  if (archiver) {
    const output = fs.createWriteStream(outPath);
    const archive = archiver('zip', { zlib: { level: 9 } });
    archive.pipe(output);
    archive.directory(sourceDir, false);
    archive.finalize();
  } else {
    console.log('  Note: Install "archiver" package to create zip files automatically');
    console.log('  npm install --save-dev archiver');
  }
}

function tryImport(moduleName) {
  try {
    return require(moduleName);
  } catch {
    return null;
  }
}

buildExtension();
