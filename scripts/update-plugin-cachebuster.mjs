import fs from 'fs';
import path from 'path';

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/update-plugin-cachebuster.mjs <plugin-path>');
    process.exit(1);
  }

  const pluginPath = path.resolve(args[0]);
  const jsonPath = path.join(pluginPath, 'plugin.json');

  if (!fs.existsSync(jsonPath)) {
    console.error(`plugin.json not found at: ${jsonPath}`);
    process.exit(1);
  }

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    console.error(`Invalid JSON in plugin.json: ${e.message}`);
    process.exit(1);
  }

  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const timestamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const cachebuster = `+duya.local-${timestamp}`;

  const currentVersion = manifest.version || '0.1.0';
  const baseVersion = currentVersion.replace(/\+.*$/, '');
  const newVersion = `${baseVersion}${cachebuster}`;

  manifest.version = newVersion;

  fs.writeFileSync(jsonPath, JSON.stringify(manifest, null, 2), 'utf8');

  console.log(`Cachebuster updated:`);
  console.log(`  ${currentVersion} -> ${newVersion}`);
  console.log(`  File: ${jsonPath}`);
}

main();