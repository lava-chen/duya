/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * electron-builder afterPack hook.
 *
 * Rebuilds better-sqlite3 and node-pty for Electron ABI and copies them to
 * extraResources. The agent bundle is built with esbuild (bundle: true) so
 * runtime dependencies are inlined — no node_modules copying is needed.
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

/**
 * Detect the architecture of a Mach-O / ELF / PE binary.
 * Returns a normalized arch string ('arm64', 'x64', 'ia32') or 'unknown'.
 *
 * On macOS we use the `file` command which reports the Mach-O slice arch.
 * On Linux/Windows we fall back to 'unknown' (rebuild check is skipped).
 */
function getBinaryArch(filePath) {
  try {
    const output = execSync(`file -b "${filePath}"`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    if (output.includes('arm64') || output.includes('aarch64')) return 'arm64';
    if (output.includes('x86_64') || output.includes('x86-64')) return 'x64';
    if (output.includes('i386') || output.includes('i686')) return 'ia32';
    return 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Check if a native .node file's architecture matches the target arch.
 * On non-macOS platforms we can't easily detect, so return true (skip check).
 */
function isArchMatch(filePath, targetArch) {
  if (process.platform !== 'darwin') return true;
  const binaryArch = getBinaryArch(filePath);
  const match = binaryArch === targetArch;
  if (!match) {
    console.log(`[afterPack] Architecture mismatch: ${filePath} is ${binaryArch}, need ${targetArch}`);
  }
  return match;
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

  // Resolve the packaged resources directory in a platform-aware way.
  // On Windows/Linux electron-builder places resources at <appOutDir>/resources
  // (lowercase). On macOS the app is bundled as DUYA.app and resources live at
  // <appOutDir>/DUYA.app/Contents/Resources (capital R, inside the .app bundle).
  // Using the lowercase path on mac would write outside the .app, leaving the
  // native module inside the bundle stale.
  const productName = context.packager.appInfo.productName || 'DUYA';
  function getResourcesDir() {
    if (platform === 'mac' || platform === 'darwin') {
      return path.join(appOutDir, `${productName}.app`, 'Contents', 'Resources');
    }
    return path.join(appOutDir, 'resources');
  }
  const RESOURCES_DIR = getResourcesDir();
  console.log(`[afterPack] Resources directory: ${RESOURCES_DIR}`);
  // Ensure the resources directory exists before any file operation.
  if (!fs.existsSync(RESOURCES_DIR)) {
    throw new Error(
      `[afterPack] FATAL: Resources directory does not exist at ${RESOURCES_DIR}. ` +
      `platform=${platform}, appOutDir=${appOutDir}. ` +
      'This usually means the platform-aware path resolver is wrong.'
    );
  }

  // Step 1: Ensure better-sqlite3 is available for Electron ABI and correct arch
  console.log(`[afterPack] Step 1: Ensuring better-sqlite3 for Electron ABI (arch=${archName})...`);

  // Check if electron-builder already provided a prebuilt binary with the
  // CORRECT architecture. extraResources copies node_modules/better-sqlite3/
  // which contains the HOST machine's arch — if cross-compiling (e.g. building
  // x64 on an arm64 Mac), the copied binary will have the wrong arch and must
  // be rebuilt.
  let foundPrebuilt = false;
  function findPrebuiltNode(dir) {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        findPrebuiltNode(fullPath);
      } else if (entry.name === 'better_sqlite3.node') {
        const archOk = isArchMatch(fullPath, archName);
        if (archOk) {
          console.log(`[afterPack] Found prebuilt binary with correct arch: ${fullPath}`);
          foundPrebuilt = true;
        } else {
          console.log(`[afterPack] Found prebuilt binary but wrong arch, will rebuild: ${fullPath}`);
        }
      }
    }
  }
  findPrebuiltNode(RESOURCES_DIR);

  if (foundPrebuilt) {
    console.log('[afterPack] Prebuilt better-sqlite3 binary with correct arch exists, skipping rebuild');
  } else {
    console.log('[afterPack] No suitable prebuilt binary found, attempting rebuild...');
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

      const targetDir = path.join(RESOURCES_DIR, 'better-sqlite3', 'build', 'Release');
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
    RESOURCES_DIR, 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'
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
  const extraResourcesBetterSqlite3 = path.join(RESOURCES_DIR, 'better-sqlite3');
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

  // Step 2.5: Ensure node-pty native module has correct architecture
  // node-pty is a native module (like better-sqlite3) that must match the
  // target arch. extraResources copies node_modules/node-pty/ which contains
  // the HOST machine's arch — if cross-compiling, the copied binary will
  // have the wrong arch and the terminal feature will crash at runtime.
  console.log(`[afterPack] Step 2.5: Ensuring node-pty for correct arch (${archName})...`);
  const packagedNodePtyDir = path.join(RESOURCES_DIR, 'node-pty');
  if (fs.existsSync(packagedNodePtyDir)) {
    // Find all .node files under node-pty and check their arch
    let nodePtyArchOk = true;
    function findNodePtyBinaries(dir) {
      if (!fs.existsSync(dir)) return;
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          findNodePtyBinaries(fullPath);
        } else if (entry.name.endsWith('.node')) {
          const archOk = isArchMatch(fullPath, archName);
          if (!archOk) nodePtyArchOk = false;
        }
      }
    }
    findNodePtyBinaries(packagedNodePtyDir);

    if (!nodePtyArchOk) {
      console.log('[afterPack] node-pty binary has wrong arch, rebuilding...');
      try {
        const rebuildCmd = `npx electron-rebuild -f -o node-pty -v ${electronVersion} -a ${archName}`;
        console.log(`[afterPack] Running: ${rebuildCmd}`);
        execSync(rebuildCmd, {
          cwd: projectDir,
          stdio: 'inherit',
          timeout: 300000,
        });
        console.log('[afterPack] node-pty rebuild completed successfully');

        // Copy rebuilt .node files to packaged resources
        const rebuiltNodePtyDir = path.join(projectDir, 'node_modules', 'node-pty', 'build', 'Release');
        if (fs.existsSync(rebuiltNodePtyDir)) {
          const targetDir = path.join(packagedNodePtyDir, 'build', 'Release');
          if (!fs.existsSync(targetDir)) {
            fs.mkdirSync(targetDir, { recursive: true });
          }
          const nodeFiles = fs.readdirSync(rebuiltNodePtyDir).filter(f => f.endsWith('.node'));
          for (const nodeFile of nodeFiles) {
            const src = path.join(rebuiltNodePtyDir, nodeFile);
            const dst = path.join(targetDir, nodeFile);
            fs.copyFileSync(src, dst);
            console.log(`[afterPack] Copied rebuilt ${nodeFile} to ${dst}`);
          }
        }
      } catch (err) {
        console.error('[afterPack] Failed to rebuild node-pty:', err.message);
        // node-pty is not critical for app startup (terminal is lazy-loaded),
        // so we warn but don't fail the build
        console.warn('[afterPack] WARNING: node-pty rebuild failed — terminal feature may not work');
      }
    } else {
      console.log('[afterPack] node-pty binary arch is correct, skipping rebuild');
    }
  } else {
    console.log('[afterPack] node-pty not found in resources, skipping (terminal feature will be unavailable)');
  }

  // Step 3: Verify agent-bundle exists (esbuild should have inlined all dependencies)
  console.log('[afterPack] Step 3: Verifying agent-bundle...');
  const agentBundlePath = path.join(RESOURCES_DIR, 'agent-bundle', 'agent-process-entry.js');
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
    const packagedResourcesDir = RESOURCES_DIR;
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
  const bashWorkerPath = path.join(RESOURCES_DIR, 'agent-bundle', 'BashTool', 'BashWorker.js');
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
  const agentBundleNodeModules = path.join(RESOURCES_DIR, 'agent-bundle', 'node_modules');
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
  const documentParserTarget = path.join(RESOURCES_DIR, 'document-parser');
  if (fs.existsSync(documentParserTarget)) {
    console.log('[afterPack] document-parser resources present (legacy .doc fallback shipped)');
  } else {
    console.log('[afterPack] document-parser resources absent (NodeFileParser-only build)');
  }

  console.log('[afterPack] Done');
};
