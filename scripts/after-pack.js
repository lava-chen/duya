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

  // Step 1: Ensure better-sqlite3 is available for Electron ABI
  console.log('[afterPack] Step 1: Ensuring better-sqlite3 for Electron ABI...');

  // Check if electron-builder already provided a prebuilt binary
  let foundPrebuilt = false;
  function findPrebuiltNode(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findPrebuiltNode(fullPath);
      } else if (entry.name === 'better_sqlite3.node') {
        console.log(`[afterPack] Found prebuilt binary: ${fullPath}`);
        foundPrebuilt = true;
      }
    }
  }
  findPrebuiltNode(path.join(appOutDir, 'resources'));

  if (foundPrebuilt) {
    console.log('[afterPack] Prebuilt better-sqlite3 binary already exists, skipping rebuild');
  } else {
    console.log('[afterPack] No prebuilt binary found, attempting rebuild...');
    let rebuildSucceeded = false;
    try {
      const rebuildCmd = `npx electron-rebuild -f -o better-sqlite3 -v ${electronVersion} -a ${archName}`;
      console.log(`[afterPack] Running: ${rebuildCmd}`);
      execSync(rebuildCmd, {
        cwd: projectDir,
        stdio: 'inherit',
        timeout: 300000,
      });
      console.log('[afterPack] Electron ABI rebuild completed successfully');
      rebuildSucceeded = true;
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
        rebuildSucceeded = true;
      } catch (err2) {
        console.error('[afterPack] @electron/rebuild API also failed:', err2.message);
      }
    }

    if (!rebuildSucceeded) {
      // FAIL THE BUILD — a packaged app without a working better-sqlite3
      // native module will crash at runtime when the agent or main process
      // tries to open the SQLite database. Silent failure here leads to
      // broken releases that pass CI but crash on first user interaction.
      throw new Error(
        '[afterPack] FATAL: Could not rebuild better-sqlite3 for Electron ABI. ' +
        'Both npx electron-rebuild and @electron/rebuild API failed. ' +
        'The packaged app would crash at runtime when opening the database.'
      );
    }

    const rebuiltSource = path.join(
      projectDir, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'
    );

    if (fs.existsSync(rebuiltSource)) {
      console.log(`[afterPack] Rebuilt .node file: ${rebuiltSource}`);

      const targetDir = path.join(appOutDir, 'resources', 'better-sqlite3', 'build', 'Release');
      if (!fs.existsSync(targetDir)) {
        fs.mkdirSync(targetDir, { recursive: true });
      }
      const targetNode = path.join(targetDir, 'better_sqlite3.node');
      fs.copyFileSync(rebuiltSource, targetNode);
      console.log(`[afterPack] Copied rebuilt .node to ${targetNode}`);
    } else {
      throw new Error(
        `[afterPack] FATAL: Rebuild reported success but .node file not found at ${rebuiltSource}. ` +
        'The native module may not have been compiled correctly.'
      );
    }
  }

  // Verify better-sqlite3 native module exists in the packaged output.
  // AGENTS.md pre-release checklist requires:
  //   release/win-unpacked/resources/better-sqlite3/build/Release/better_sqlite3.node
  const packagedNativeModule = path.join(
    appOutDir, 'resources', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'
  );
  if (!fs.existsSync(packagedNativeModule)) {
    throw new Error(
      `[afterPack] FATAL: better_sqlite3.node not found at ${packagedNativeModule}. ` +
      'The packaged app cannot open its SQLite database without this native module.'
    );
  }
  console.log(`[afterPack] Verified better_sqlite3.node at ${packagedNativeModule}`);

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
    // Diagnose: was the source bundle present in the workspace at all?
    // extraResources copies from packages/agent/bundle/ → release/<platform>/resources/agent-bundle/.
    // If the source is missing, electron-builder silently skips the copy and
    // emits a 'file source doesn't exist' warning — that is the most common
    // reason this FATAL fires after a successful-looking `npm run electron:build`.
    const sourceBundleDir = path.join(projectDir, 'packages', 'agent', 'bundle');
    const sourceBundleEntry = path.join(sourceBundleDir, 'agent-process-entry.js');
    let sourceDiagnostic = 'not present';
    if (fs.existsSync(sourceBundleEntry)) {
      const stats = fs.statSync(sourceBundleEntry);
      sourceDiagnostic = `present (${(stats.size / 1024 / 1024).toFixed(2)} MB)`;
    } else if (fs.existsSync(sourceBundleDir)) {
      sourceDiagnostic = `directory exists, entry missing — dir contents: ${fs.readdirSync(sourceBundleDir).join(', ')}`;
    }
    let packagedResourcesDiagnostic = 'missing';
    const packagedResourcesDir = path.join(appOutDir, 'resources');
    if (fs.existsSync(packagedResourcesDir)) {
      packagedResourcesDiagnostic = `present — subdirs: ${fs.readdirSync(packagedResourcesDir).join(', ')}`;
    }
    throw new Error(
      `[afterPack] FATAL: agent-process-entry.js not found at ${agentBundlePath}.\n` +
      `  Source packages/agent/bundle/agent-process-entry.js: ${sourceDiagnostic}\n` +
      `  ${packagedResourcesDir}: ${packagedResourcesDiagnostic}\n` +
      'Run `npm run bundle:agent` before packaging. The agent core cannot start without this entry file.'
    );
  }
  const agentBundleStats = fs.statSync(agentBundlePath);
  console.log(`[afterPack] Agent bundle verified: ${agentBundlePath} (${(agentBundleStats.size / 1024 / 1024).toFixed(2)} MB)`);

  // Verify BashWorker.js exists — AGENTS.md pre-release checklist requires:
  //   release/win-unpacked/resources/agent-bundle/BashTool/BashWorker.js
  const bashWorkerPath = path.join(appOutDir, 'resources', 'agent-bundle', 'BashTool', 'BashWorker.js');
  if (!fs.existsSync(bashWorkerPath)) {
    throw new Error(
      `[afterPack] FATAL: BashWorker.js not found at ${bashWorkerPath}. ` +
      'The Bash tool cannot execute commands without this worker file. ' +
      'Run `npm run bundle:agent` before packaging.'
    );
  }
  console.log(`[afterPack] BashWorker.js verified at ${bashWorkerPath}`);

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

  // Step 5: Document parser payload is OPTIONAL as of plan 106.
  // The main path uses NodeFileParser (in-process) — no sidecar needed.
  // The Python sidecar remains available as an opt-in fallback for
  // legacy .doc parsing, but it is no longer built or shipped by
  // default. We only verify presence here, never copy.
  console.log('[afterPack] Step 5: Checking document-parser resources (optional)...');
  const documentParserTarget = path.join(appOutDir, 'resources', 'document-parser');
  if (fs.existsSync(documentParserTarget)) {
    console.log('[afterPack] document-parser resources present (legacy .doc fallback shipped)');
  } else {
    console.log('[afterPack] document-parser resources absent (NodeFileParser-only build)');
  }

  console.log('[afterPack] Done');
};
