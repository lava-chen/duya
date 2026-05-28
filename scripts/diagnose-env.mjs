/**
 * diagnose-env.mjs — Environment diagnostic for dev/build/packaged modes
 *
 * Usage:
 *   node scripts/diagnose-env.mjs              # diagnose current environment
 *   node scripts/diagnose-env.mjs --json       # JSON output
 *   node scripts/diagnose-env.mjs --packaged   # simulate packaged paths
 *
 * Reports: entry points, paths, env vars, resource existence, key differences
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, '..');

const isSimulated = process.argv.includes('--packaged');
const jsonMode = process.argv.includes('--json');

const results = [];

function addResult(category, item, devValue, buildValue, packagedValue, status) {
  results.push({ category, item, devValue, buildValue, packagedValue, status });
}

function checkFile(filePath, label) {
  const exists = fs.existsSync(filePath);
  const status = exists ? 'ok' : 'missing';
  if (exists) {
    try {
      const stat = fs.statSync(filePath);
      return { status, detail: `${(stat.size / 1024).toFixed(1)} KB` };
    } catch {
      return { status, detail: 'exists (no stat)' };
    }
  }
  return { status, detail: 'not found' };
}

// =============================================================================
// Mode Detection
// =============================================================================

const simulatedResourcesPath = isSimulated
  ? path.join(PROJECT_ROOT, 'release', 'win-unpacked', 'resources')
  : null;

const modes = {
  dev: {
    label: 'Dev (electron .)',
    resourcesPath: PROJECT_ROOT,
    userData: path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA', 'duya-dev'),
    rendererUrl: 'http://localhost:3000',
    isPackaged: false,
  },
  build: {
    label: 'Build (production preview)',
    resourcesPath: path.join(PROJECT_ROOT, 'dist'),
    userData: path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA'),
    rendererUrl: `file://${path.join(PROJECT_ROOT, 'dist', 'index.html')}`,
    isPackaged: true,
  },
  packaged: {
    label: 'Packaged (installed)',
    resourcesPath: simulatedResourcesPath || path.join(PROJECT_ROOT, 'release', 'win-unpacked', 'resources'),
    userData: path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA'),
    rendererUrl: `file://${simulatedResourcesPath || 'RESOURCES'}/app.asar/dist/index.html`,
    isPackaged: true,
  },
};

// =============================================================================
// System Environment
// =============================================================================

function diagnoseSystem() {
  const cwd = process.cwd();
  const platform = os.platform();
  const arch = os.arch();
  const nodeVersion = process.version;
  const electronVersion = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, 'node_modules', 'electron', 'package.json'), 'utf-8'));
      return pkg.version;
    } catch { return 'unknown'; }
  })();

  addResult('System', 'Platform', platform, platform, platform, 'info');
  addResult('System', 'Architecture', arch, arch, arch, 'info');
  addResult('System', 'Node.js', nodeVersion, nodeVersion, nodeVersion, 'info');
  addResult('System', 'Electron', electronVersion, electronVersion, electronVersion, 'info');
  addResult('System', 'CWD', cwd, cwd, cwd, 'info');
  addResult('System', 'Project Root', PROJECT_ROOT, PROJECT_ROOT, PROJECT_ROOT, 'info');
}

// =============================================================================
// Entry Points
// =============================================================================

function diagnoseEntryPoints() {
  const devMain = path.join(PROJECT_ROOT, 'electron', 'main.ts');
  const buildMain = path.join(PROJECT_ROOT, 'dist-electron', 'main.js');
  const devPreload = path.join(PROJECT_ROOT, 'electron', 'preload.ts');
  const buildPreload = path.join(PROJECT_ROOT, 'dist-electron', 'preload.js');

  addResult('Entry Points', 'Main (ts source)', checkFile(devMain, 'main.ts').detail, '—', '—', checkFile(devMain, 'main.ts').status);
  addResult('Entry Points', 'Main (built)', '—', checkFile(buildMain, 'main.js').detail, `app.asar/dist-electron/main.js`, checkFile(buildMain, 'main.js').status);
  addResult('Entry Points', 'Preload (ts source)', checkFile(devPreload, 'preload.ts').detail, '—', '—', checkFile(devPreload, 'preload.ts').status);
  addResult('Entry Points', 'Preload (built)', '—', checkFile(buildPreload, 'preload.js').detail, `app.asar/dist-electron/preload.js`, checkFile(buildPreload, 'preload.js').status);
}

// =============================================================================
// Agent Bundle
// =============================================================================

function diagnoseAgentBundle() {
  const devAgentProcess = path.join(PROJECT_ROOT, 'packages', 'agent', 'dist', 'process', 'agent-process-entry.js');
  const bundleAgentProcess = path.join(PROJECT_ROOT, 'packages', 'agent', 'bundle', 'agent-process-entry.js');
  const bashWorker = path.join(PROJECT_ROOT, 'packages', 'agent', 'bundle', 'BashTool', 'BashWorker.js');

  addResult('Agent Bundle', 'Dev dist (tsc)', checkFile(devAgentProcess, 'agent-process-entry.js').detail, '—', '—', checkFile(devAgentProcess, 'agent-process-entry.js').status);
  addResult('Agent Bundle', 'Bundle (esbuild)', '—', checkFile(bundleAgentProcess, 'agent-process-entry.js').detail, `resources/agent-bundle/agent-process-entry.js`, checkFile(bundleAgentProcess, 'agent-process-entry.js').status);
  addResult('Agent Bundle', 'BashWorker.js', '—', checkFile(bashWorker, 'BashWorker.js').detail, `resources/agent-bundle/BashTool/BashWorker.js`, checkFile(bashWorker, 'BashWorker.js').status);
}

// =============================================================================
// Agent Server
// =============================================================================

function diagnoseAgentServer() {
  const buildServer = path.join(PROJECT_ROOT, 'dist-electron', 'agent-server.js');

  addResult('Agent Server', 'Built entry', '—', checkFile(buildServer, 'agent-server.js').detail, `app.asar/dist-electron/agent-server.js`, checkFile(buildServer, 'agent-server.js').status);
}

// =============================================================================
// Gateway Bundle
// =============================================================================

function diagnoseGatewayBundle() {
  const bundleGateway = path.join(PROJECT_ROOT, 'packages', 'gateway', 'bundle', 'gateway-process-entry.js');

  addResult('Gateway Bundle', 'Bundle (esbuild)', '—', checkFile(bundleGateway, 'gateway-process-entry.js').detail, `resources/gateway-bundle/gateway-process-entry.js`, checkFile(bundleGateway, 'gateway-process-entry.js').status);
}

// =============================================================================
// Frontend Build
// =============================================================================

function diagnoseFrontend() {
  const distIndex = path.join(PROJECT_ROOT, 'dist', 'index.html');
  const distAssets = path.join(PROJECT_ROOT, 'dist', 'assets');

  addResult('Frontend', 'dist/index.html', '—', checkFile(distIndex, 'index.html').detail, `app.asar/dist/index.html`, checkFile(distIndex, 'index.html').status);

  let assetFiles = 'empty';
  if (fs.existsSync(distAssets)) {
    const files = fs.readdirSync(distAssets).filter(f => f.startsWith('index-') || f.endsWith('.js') || f.endsWith('.css'));
    assetFiles = `${files.length} files`;
  }
  addResult('Frontend', 'dist/assets/', '—', assetFiles, `app.asar/dist/assets/`, fs.existsSync(distAssets) ? 'ok' : 'missing');
}

// =============================================================================
// Native Modules
// =============================================================================

function diagnoseNativeModules() {
  const nodeBetterSqlite3 = path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node');

  addResult('Native Modules', 'better-sqlite3.node', checkFile(nodeBetterSqlite3, '.node').detail, checkFile(nodeBetterSqlite3, '.node').detail, `resources/better-sqlite3/build/Release/better_sqlite3.node`, checkFile(nodeBetterSqlite3, '.node').status);
}

// =============================================================================
// Extra Resources (packaged)
// =============================================================================

function diagnoseExtraResources() {
  const resDir = modes.packaged.resourcesPath;
  const skillsDir = path.join(resDir, 'agent', 'skills');
  const publicDir = path.join(resDir, 'public');
  const extensionDir = path.join(resDir, 'extension');
  const assetsDir = path.join(resDir, 'assets');
  const docParserDir = path.join(resDir, 'document-parser');

  addResult('Extra Resources', 'agent/skills/', 'packages/agent/skills/', 'packages/agent/skills/', `resources/agent/skills/`, checkFile(skillsDir, 'skills').status);
  addResult('Extra Resources', 'public/', 'public/', 'public/', `resources/public/`, checkFile(publicDir, 'public').status);
  addResult('Extra Resources', 'assets/', 'assets/', 'assets/', `resources/assets/`, checkFile(assetsDir, 'assets').status);
  addResult('Extra Resources', 'document-parser/', 'build/document-parser/', 'build/document-parser/', `resources/document-parser/`, checkFile(docParserDir, 'doc-parser').status);

  if (fs.existsSync(extensionDir)) {
    addResult('Extra Resources', 'extension/', 'extension/', 'extension/', `resources/extension/`, 'ok');
  }
}

// =============================================================================
// Skills
// =============================================================================

function diagnoseSkills() {
  const bundledSkills = path.join(PROJECT_ROOT, 'packages', 'agent', 'skills');
  const userSkills = path.join(os.homedir(), '.duya', 'skills');

  let bundledCount = 0;
  if (fs.existsSync(bundledSkills)) {
    const dirs = fs.readdirSync(bundledSkills).filter(d => {
      const stat = fs.statSync(path.join(bundledSkills, d));
      return stat.isDirectory() && !d.startsWith('.');
    });
    bundledCount = dirs.length;
  }

  let userSkillDirs = 0;
  if (fs.existsSync(userSkills)) {
    userSkillDirs = fs.readdirSync(userSkills).filter(d => {
      try {
        const stat = fs.statSync(path.join(userSkills, d));
        return stat.isDirectory() && !d.startsWith('.');
      } catch { return false; }
    }).length;
  }

  addResult('Skills', 'Bundled (packages/agent/skills/)', `${bundledCount} categories`, `${bundledCount} categories`, `resources/agent/skills/ (${bundledCount} cats)`, bundledCount > 0 ? 'ok' : 'warning');
  addResult('Skills', 'User (~/.duya/skills/)', `${userSkillDirs} skills`, `${userSkillDirs} skills`, `${userSkillDirs} skills`, userSkillDirs >= 0 ? 'ok' : 'info');
}

// =============================================================================
// Path Resolution Simulation
// =============================================================================

function diagnosePathResolution() {
  const simulatedProcessResourcesPath = isSimulated
    ? path.join(PROJECT_ROOT, 'release', 'win-unpacked', 'resources')
    : '/INSTALLED_APP/resources';

  const paths = {
    AgentProcessPath: isSimulated
      ? path.join(simulatedProcessResourcesPath, 'agent-bundle', 'agent-process-entry.js')
      : path.join(PROJECT_ROOT, 'packages', 'agent', 'bundle', 'agent-process-entry.js'),
    AgentServerPath: isSimulated
      ? path.join(simulatedProcessResourcesPath, 'app.asar', 'dist-electron', 'agent-server.js')
      : path.join(PROJECT_ROOT, 'dist-electron', 'agent-server.js'),
    BetterSqlite3Path: isSimulated
      ? path.join(simulatedProcessResourcesPath, 'better-sqlite3')
      : path.join(PROJECT_ROOT, 'node_modules', 'better-sqlite3'),
    UserDataPath: isSimulated
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA')
      : path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA', 'duya-dev'),
    LogPath: isSimulated
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA', 'logs', 'app.log')
      : path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA', 'duya-dev', 'logs', 'app.log'),
    DatabasePath: isSimulated
      ? path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA', 'databases', 'duya-main.db')
      : path.join(os.homedir(), 'AppData', 'Roaming', 'DUYA', 'duya-dev', 'databases', 'duya-main.db'),
  };

  for (const [name, filePath] of Object.entries(paths)) {
    const exists = fs.existsSync(filePath);
    addResult('Path Resolution', name, paths[name] || '—', paths[name] || '—', filePath, exists ? 'exists' : 'not-exists');
  }
}

// =============================================================================
// Render Output
// =============================================================================

function renderText() {
  const categories = [...new Set(results.map(r => r.category))];

  const divider = '─'.repeat(98);

  console.log(`\n${divider}`);
  console.log(`  DUYA Environment Diagnostic`);
  console.log(`  Mode: ${isSimulated ? 'SIMULATED PACKAGED' : 'DEVELOPMENT'}`);
  console.log(`  Date: ${new Date().toISOString()}`);
  console.log(divider);

  for (const category of categories) {
    const items = results.filter(r => r.category === category);
    console.log(`\n  ▸ ${category}`);
    console.log(`  ${'─'.repeat(94)}`);

    for (const item of items) {
      const statusIcon = item.status === 'ok' ? '✓' : item.status === 'missing' ? '✗' : item.status === 'warning' ? '⚠' : item.status === 'info' ? 'ℹ' : '?';
      console.log(`  ${statusIcon} ${item.item.padEnd(28)} | dev: ${String(item.devValue).padEnd(24)} | build: ${String(item.buildValue).padEnd(24)} | pkg: ${String(item.packagedValue)}`);
    }
  }

  const issues = results.filter(r => r.status === 'missing' || r.status === 'warning');
  if (issues.length > 0) {
    console.log(`\n${divider}`);
    console.log(`  ISSUES FOUND: ${issues.length}`);
    console.log(divider);
    for (const issue of issues) {
      console.log(`  [${issue.status.toUpperCase()}] ${issue.category} > ${issue.item}`);
    }
  }

  console.log(`\n${divider}\n`);
}

function renderJson() {
  console.log(JSON.stringify(results, null, 2));
}

// =============================================================================
// Main
// =============================================================================

function main() {
  diagnoseSystem();
  diagnoseEntryPoints();
  diagnoseAgentBundle();
  diagnoseAgentServer();
  diagnoseGatewayBundle();
  diagnoseFrontend();
  diagnoseNativeModules();
  diagnoseExtraResources();
  diagnoseSkills();
  diagnosePathResolution();

  if (jsonMode) {
    renderJson();
  } else {
    renderText();
  }
}

main();