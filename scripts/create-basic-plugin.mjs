import fs from 'fs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function kebabCase(str) {
  return str
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 64);
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
}

function atomicWriteJson(targetPath, payload) {
  const tempPath = `${targetPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(payload, null, 2), 'utf8');
  fs.renameSync(tempPath, targetPath);
}

function parseArgs(args) {
  const flags = {
    withSkills: false,
    withHooks: false,
    withMcp: false,
    withCli: false,
    withUi: false,
    withMarketplace: false,
    devMode: false,
    parentDir: null,
    pluginName: null,
  };

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--with-skills':
        flags.withSkills = true;
        break;
      case '--with-hooks':
        flags.withHooks = true;
        break;
      case '--with-mcp':
        flags.withMcp = true;
        break;
      case '--with-cli':
        flags.withCli = true;
        break;
      case '--with-ui':
        flags.withUi = true;
        break;
      case '--with-marketplace':
        flags.withMarketplace = true;
        break;
      case '--dev':
        flags.devMode = true;
        break;
      case '--parent-dir':
        flags.parentDir = args[++i];
        break;
      default:
        if (!arg.startsWith('--') && !flags.pluginName) {
          flags.pluginName = arg;
        }
        break;
    }
    i++;
  }

  return flags;
}

function generatePluginJson(pluginName, flags) {
  const author = process.env.USER || process.env.USERNAME || 'Unknown';
  const capabilities = {};

  if (flags.withSkills) {
    capabilities.skills = [`./skills/${pluginName}/SKILL.md`];
  }
  if (flags.withMcp) {
    capabilities.mcpServers = [];
  }
  if (flags.withCli) {
    capabilities.cli = [];
  }
  if (flags.withHooks) {
    capabilities.hooks = [];
  }
  if (flags.withUi) {
    capabilities.ui = [];
  }

  return {
    schemaVersion: 'duya.plugin.v1',
    id: `com.duya.${pluginName}`,
    name: pluginName,
    version: '0.1.0',
    description: `Plugin: ${pluginName}`,
    author: { name: author },
    capabilities,
    permissions: [],
    engines: { duya: '>=0.9.0' },
  };
}

function createSkillTemplate(pluginName, pluginDir) {
  const skillDir = path.join(pluginDir, 'skills', pluginName);
  ensureDir(skillDir);

  const skillMd = `---
name: ${pluginName}
description: "Skill: ${pluginName}"
---

# ${pluginName}

## When to Apply

Describe when the agent should use this skill.

## Best Practices

1. Practice one
2. Practice two

## Examples

### Example: Basic Usage
Describe how this skill applies.
`;

  fs.writeFileSync(path.join(skillDir, 'SKILL.md'), skillMd, 'utf8');
  console.log(`  Created skills/${pluginName}/SKILL.md`);
}

function createHooksTemplate(pluginDir) {
  const hooksDir = path.join(pluginDir, 'hooks');
  ensureDir(hooksDir);

  const hooksJson = {
    hooks: [
      {
        event: 'PreToolUse',
        matcher: 'Bash(*)',
        command: {
          type: 'command',
          command: 'echo "Hook triggered"',
          timeout: 5000,
        },
      },
    ],
  };

  fs.writeFileSync(path.join(hooksDir, 'hooks.json'), JSON.stringify(hooksJson, null, 2), 'utf8');
  console.log('  Created hooks/hooks.json');
}

function createMcpTemplate(pluginDir) {
  const mcpJson = {
    mcpServers: {},
  };

  fs.writeFileSync(path.join(pluginDir, '.mcp.json'), JSON.stringify(mcpJson, null, 2), 'utf8');
  console.log('  Created .mcp.json');
}

function createCliTemplate(pluginDir, pluginName) {
  const commandsDir = path.join(pluginDir, 'commands');
  ensureDir(commandsDir);
  console.log('  Created commands/ directory');
}

function createUiTemplate(pluginDir) {
  const uiDir = path.join(pluginDir, 'ui');
  ensureDir(uiDir);
  console.log('  Created ui/ directory');
}

function getDuyaUserDataPath(devMode = false) {
  const platform = process.platform;
  let basePath;

  if (platform === 'win32') {
    basePath = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'duya');
  } else if (platform === 'darwin') {
    basePath = path.join(os.homedir(), 'Library', 'Application Support', 'duya');
  } else {
    const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
    basePath = path.join(xdgConfig, 'duya');
  }

  if (devMode) {
    basePath = path.join(basePath, 'duya-dev');
  }

  return basePath;
}

function getDuyaPluginsDir(devMode = false) {
  return path.join(getDuyaUserDataPath(devMode), 'plugins');
}

function getDefaultParentDir(devMode = false) {
  return getDuyaPluginsDir(devMode);
}

function getMarketplacePath(devMode = false) {
  return path.join(getDuyaPluginsDir(devMode), 'marketplace.json');
}

function readMarketplaceFile(marketplacePath) {
  if (!fs.existsSync(marketplacePath)) {
    return { name: 'personal', plugins: [] };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(marketplacePath, 'utf8'));
    if (typeof raw !== 'object' || raw === null || !Array.isArray(raw.plugins)) {
      return { name: 'personal', plugins: [] };
    }
    return raw;
  } catch {
    return { name: 'personal', plugins: [] };
  }
}

function addMarketplaceEntry(pluginName, pluginDir, devMode = false) {
  const marketplacePath = getMarketplacePath(devMode);
  ensureDir(path.dirname(marketplacePath));

  const marketplace = readMarketplaceFile(marketplacePath);

  const existingIndex = marketplace.plugins.findIndex((p) => p.name === pluginName);
  const entry = {
    name: pluginName,
    source: {
      source: 'local',
      path: pluginDir,
    },
    policy: {
      installation: 'AVAILABLE',
      authentication: 'ON_INSTALL',
    },
    category: 'other',
  };

  if (existingIndex >= 0) {
    marketplace.plugins[existingIndex] = entry;
    console.log(`  Updated marketplace entry for "${pluginName}"`);
  } else {
    marketplace.plugins.push(entry);
    console.log(`  Added marketplace entry for "${pluginName}"`);
  }

  atomicWriteJson(marketplacePath, marketplace);
  console.log(`  marketplace.json: ${marketplacePath}`);
}

function main() {
  const args = process.argv.slice(2);
  const flags = parseArgs(args);

  if (!flags.pluginName) {
    console.error('Usage: node scripts/create-basic-plugin.mjs <plugin-name> [flags]');
    console.error('');
    console.error('Flags:');
    console.error('  --with-skills        Create skills/ directory with SKILL.md template');
    console.error('  --with-hooks         Create hooks/hooks.json template');
    console.error('  --with-mcp           Create .mcp.json template');
    console.error('  --with-cli           Create commands/ directory');
    console.error('  --with-ui            Create ui/ directory');
    console.error('  --with-marketplace   Add entry to marketplace.json in DUYA userData');
    console.error('  --dev                Target DUYA dev-mode userData directory');
    console.error('  --parent-dir <path>  Parent directory for plugin (default: DUYA userData/plugins)');
    console.error('');
    console.error('Default userData paths:');
    console.error(`  Regular: ${getDuyaUserDataPath(false)}`);
    console.error(`  Dev:     ${getDuyaUserDataPath(true)}`);
    process.exit(1);
  }

  const pluginName = kebabCase(flags.pluginName);
  const parentDir = flags.parentDir || getDefaultParentDir(flags.devMode);
  const pluginDir = path.join(parentDir, pluginName);

  if (fs.existsSync(pluginDir)) {
    console.log(`Plugin directory already exists: ${pluginDir}`);
    console.log('Use --with-marketplace to update marketplace entry for existing plugin.');
  } else {
    ensureDir(pluginDir);
  }

  const manifest = generatePluginJson(pluginName, flags);
  fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify(manifest, null, 2), 'utf8');
  console.log(`Created plugin.json`);

  if (flags.withSkills) {
    createSkillTemplate(pluginName, pluginDir);
  }
  if (flags.withHooks) {
    createHooksTemplate(pluginDir);
  }
  if (flags.withMcp) {
    createMcpTemplate(pluginDir);
  }
  if (flags.withCli) {
    createCliTemplate(pluginDir, pluginName);
  }
  if (flags.withUi) {
    createUiTemplate(pluginDir);
  }

  if (flags.withMarketplace) {
    addMarketplaceEntry(pluginName, pluginDir, flags.devMode);
  }

  console.log(`\nPlugin created at: ${pluginDir}`);
  console.log('To install in DUYA, restart DUYA and install from the catalog UI.');
}

main();