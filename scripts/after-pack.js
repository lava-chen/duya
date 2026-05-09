/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder afterPack hook.
 *
 * Rebuilds better-sqlite3 for Electron ABI and copies it to extraResources.
 * The agent bundle is built with esbuild (bundle: true) so runtime dependencies
 * are inlined — no node_modules copying is needed.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

function copyDirRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  if (!fs.existsSync(dest)) {
    fs.mkdirSync(dest, { recursive: true });
  }
  const entries = fs.readdirSync(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

module.exports = async function afterPack(context) {
  const appOutDir = context.appOutDir;
  const arch = context.arch;
  const archName = arch === 3 ? 'arm64' : arch === 1 ? 'x64' : arch === 0 ? 'ia32' : String(arch);
  const platform = context.packager.platform.name;

  const electronVersion =
    context.electronVersion ||
    context.packager?.config?.electronVersion ||
    require(path.join(process.cwd(), 'node_modules', 'electron', 'package.json')).version;

  console.log(`[afterPack] Electron ${electronVersion}, arch=${archName}, platform=${platform}`);

  const projectDir = process.cwd();

  // Step 1: Rebuild better-sqlite3 for Electron ABI (main process)
  console.log('[afterPack] Step 1: Rebuilding better-sqlite3 for Electron ABI...');
  try {
    const rebuildCmd = `npx electron-rebuild -f -o better-sqlite3 -v ${electronVersion} -a ${archName}`;
    console.log(`[afterPack] Running: ${rebuildCmd}`);
    execSync(rebuildCmd, {
      cwd: projectDir,
      stdio: 'inherit',
      timeout: 300000,
    });
    console.log('[afterPack] Electron ABI rebuild completed successfully');
  } catch (err) {
    console.error('[afterPack] Failed to rebuild better-sqlite3 for Electron ABI:', err.message);
    try {
      const { rebuild } = require('@electron/rebuild');
      await rebuild({
        buildPath: projectDir,
        electronVersion: electronVersion,
        arch: archName,
        onlyModules: ['better-sqlite3'],
        force: true,
      });
      console.log('[afterPack] Rebuild via @electron/rebuild API succeeded');
    } catch (err2) {
      console.error('[afterPack] @electron/rebuild API also failed:', err2.message);
      throw new Error('Cannot rebuild better-sqlite3 for Electron ABI');
    }
  }

  const rebuiltSource = path.join(
    projectDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'
  );

  if (!fs.existsSync(rebuiltSource)) {
    throw new Error(`[afterPack] Rebuilt better_sqlite3.node not found at ${rebuiltSource}`);
  }

  console.log(`[afterPack] Rebuilt .node file: ${rebuiltSource}`);

  // Replace all better_sqlite3.node files in electron resources
  let replaced = 0;

  function walkAndReplace(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walkAndReplace(fullPath);
      } else if (entry.name === 'better_sqlite3.node') {
        fs.copyFileSync(rebuiltSource, fullPath);
        console.log(`[afterPack] Replaced ${fullPath}`);
        replaced++;
      }
    }
  }

  walkAndReplace(path.join(appOutDir, 'resources'));

  if (replaced > 0) {
    console.log(`[afterPack] Successfully replaced ${replaced} better_sqlite3.node file(s) with Electron ABI version`);
  } else {
    console.warn('[afterPack] WARNING: No better_sqlite3.node files found in resources!');
  }

  // Step 2: Copy bindings dependencies to extraResources better-sqlite3
  // The better-sqlite3 package needs bindings to load the native addon
  console.log('[afterPack] Step 2: Setting up bindings for extraResources better-sqlite3...');
  const extraResourcesBetterSqlite3 = path.join(appOutDir, 'resources', 'better-sqlite3');
  const extraResourcesBindings = path.join(extraResourcesBetterSqlite3, 'node_modules', 'bindings');
  const extraResourcesFileUriToPath = path.join(extraResourcesBetterSqlite3, 'node_modules', 'file-uri-to-path');

  if (fs.existsSync(extraResourcesBetterSqlite3)) {
    const nodeModulesDir = path.join(extraResourcesBetterSqlite3, 'node_modules');
    if (!fs.existsSync(nodeModulesDir)) {
      fs.mkdirSync(nodeModulesDir, { recursive: true });
    }

    const sourceBindings = path.join(projectDir, 'node_modules', 'bindings');
    if (fs.existsSync(sourceBindings)) {
      copyDirRecursive(sourceBindings, extraResourcesBindings);
      console.log('[afterPack] Copied bindings to extraResources/better-sqlite3/node_modules/');
    } else {
      console.warn('[afterPack] bindings not found in project node_modules, skipping...');
    }

    const sourceFileUriToPath = path.join(projectDir, 'node_modules', 'file-uri-to-path');
    if (fs.existsSync(sourceFileUriToPath)) {
      copyDirRecursive(sourceFileUriToPath, extraResourcesFileUriToPath);
      console.log('[afterPack] Copied file-uri-to-path to extraResources/better-sqlite3/node_modules/');
    } else {
      console.warn('[afterPack] file-uri-to-path not found in project node_modules, skipping...');
    }
  }

  // Step 3: Verify agent-bundle exists (esbuild should have inlined all dependencies)
  console.log('[afterPack] Step 3: Verifying agent-bundle...');
  const agentBundlePath = path.join(appOutDir, 'resources', 'agent-bundle', 'agent-process-entry.js');
  if (!fs.existsSync(agentBundlePath)) {
    console.warn(`[afterPack] WARNING: agent-bundle not found at ${agentBundlePath}`);
  } else {
    const stats = fs.statSync(agentBundlePath);
    console.log(`[afterPack] Agent bundle verified: ${agentBundlePath} (${(stats.size / 1024 / 1024).toFixed(2)} MB)`);
  }

  // Step 4: Copy playwright package to agent-bundle node_modules
  // Playwright is marked as external in esbuild config, so it needs to be available at runtime
  console.log('[afterPack] Step 4: Copying playwright to agent-bundle...');
  const agentBundleNodeModules = path.join(appOutDir, 'resources', 'agent-bundle', 'node_modules');
  const playwrightSource = path.join(projectDir, 'node_modules', 'playwright');
  const playwrightCoreSource = path.join(projectDir, 'node_modules', 'playwright-core');

  if (!fs.existsSync(agentBundleNodeModules)) {
    fs.mkdirSync(agentBundleNodeModules, { recursive: true });
  }

  if (fs.existsSync(playwrightSource)) {
    copyDirRecursive(playwrightSource, path.join(agentBundleNodeModules, 'playwright'));
    console.log('[afterPack] Copied playwright to agent-bundle/node_modules/');
  } else {
    console.warn('[afterPack] playwright not found in project node_modules, skipping...');
  }

  if (fs.existsSync(playwrightCoreSource)) {
    copyDirRecursive(playwrightCoreSource, path.join(agentBundleNodeModules, 'playwright-core'));
    console.log('[afterPack] Copied playwright-core to agent-bundle/node_modules/');
  } else {
    console.warn('[afterPack] playwright-core not found in project node_modules, skipping...');
  }

  console.log('[afterPack] Done');
};
