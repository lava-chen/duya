import fs from 'fs';
import path from 'path';

const errors = [];
const warnings = [];

function logError(msg) {
  errors.push(msg);
  console.error(`  ERROR: ${msg}`);
}

function logWarning(msg) {
  warnings.push(msg);
  console.warn(`  WARN: ${msg}`);
}

function validatePluginManifest(pluginRoot) {
  const jsonPath = path.join(pluginRoot, 'plugin.json');
  const mdPath = path.join(pluginRoot, 'plugin.md');

  if (fs.existsSync(jsonPath)) {
    return validateJsonManifest(pluginRoot, jsonPath);
  }
  if (fs.existsSync(mdPath)) {
    return validateMdManifest(pluginRoot, mdPath);
  }
  logError('No plugin.json or plugin.md found in plugin root');
  return null;
}

function validateJsonManifest(pluginRoot, jsonPath) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
  } catch (e) {
    logError(`Invalid JSON in plugin.json: ${e.message}`);
    return null;
  }

  if (typeof raw !== 'object' || raw === null) {
    logError('plugin.json root must be an object');
    return null;
  }

  if (raw.schemaVersion !== 'duya.plugin.v1') {
    logError(`schemaVersion must be "duya.plugin.v1", got "${raw.schemaVersion}"`);
    return null;
  }

  if (!raw.id || typeof raw.id !== 'string') {
    logError('id is required and must be a string');
  } else if (!raw.id.includes('.')) {
    logWarning(`id "${raw.id}" should follow reverse-domain format (e.g. com.duya.my-plugin)`);
  }

  if (!raw.name || typeof raw.name !== 'string') {
    logError('name is required and must be a string');
  }

  if (!raw.version || typeof raw.version !== 'string') {
    logError('version is required and must be a string');
  } else if (!/^\d+\.\d+\.\d+/.test(raw.version)) {
    logWarning(`version "${raw.version}" should be strict semver (e.g. 0.1.0)`);
  }

  if (!raw.description || typeof raw.description !== 'string') {
    logError('description is required and must be a string');
  }

  if (typeof raw.author !== 'object' || raw.author === null || !raw.author.name) {
    logError('author.name is required');
  }

  if (typeof raw.capabilities !== 'object' || raw.capabilities === null || Array.isArray(raw.capabilities)) {
    logError('capabilities must be an object');
  } else {
    validateCapabilities(pluginRoot, raw.capabilities);
  }

  if (!Array.isArray(raw.permissions)) {
    logError('permissions must be an array');
  }

  if (typeof raw.engines !== 'object' || raw.engines === null || !raw.engines.duya) {
    logError('engines.duya is required');
  }

  if (JSON.stringify(raw).includes('[TODO')) {
    logError('Found [TODO] placeholder in manifest - replace with actual values');
  }

  return raw;
}

function validateCapabilities(pluginRoot, capabilities) {
  if (capabilities.skills) {
    if (!Array.isArray(capabilities.skills)) {
      logError('capabilities.skills must be an array of strings');
    } else {
      for (const skillPath of capabilities.skills) {
        if (typeof skillPath !== 'string') {
          logError(`capabilities.skills contains non-string entry: ${JSON.stringify(skillPath)}`);
          continue;
        }
        const resolved = path.resolve(pluginRoot, skillPath);
        if (!fs.existsSync(resolved)) {
          logError(`Skill path not found: ${skillPath}`);
        }
      }
    }
  }

  if (capabilities.mcpServers) {
    if (!Array.isArray(capabilities.mcpServers)) {
      logError('capabilities.mcpServers must be an array');
    } else {
      for (const server of capabilities.mcpServers) {
        if (!server.name || !server.command) {
          logError(`MCP server missing name or command: ${JSON.stringify(server)}`);
        }
      }
    }
  }

  if (capabilities.cli) {
    if (!Array.isArray(capabilities.cli)) {
      logError('capabilities.cli must be an array');
    } else {
      for (const cli of capabilities.cli) {
        if (!cli.name || !cli.command) {
          logError(`CLI entry missing name or command: ${JSON.stringify(cli)}`);
        }
      }
    }
  }

  if (capabilities.hooks) {
    if (!Array.isArray(capabilities.hooks)) {
      logError('capabilities.hooks must be an array');
    } else {
      for (const hook of capabilities.hooks) {
        if (!hook.event || !hook.handler) {
          logError(`Hook missing event or handler: ${JSON.stringify(hook)}`);
        } else {
          const resolved = path.resolve(pluginRoot, hook.handler);
          if (!fs.existsSync(resolved)) {
            logError(`Hook handler not found: ${hook.handler}`);
          }
        }
      }
    }
  }

  if (capabilities.ui) {
    if (!Array.isArray(capabilities.ui)) {
      logError('capabilities.ui must be an array');
    } else {
      for (const ui of capabilities.ui) {
        if (!ui.id || !ui.type || !ui.entry) {
          logError(`UI entry missing id/type/entry: ${JSON.stringify(ui)}`);
        }
        if (ui.type && !['sidebar', 'panel', 'settings'].includes(ui.type)) {
          logError(`UI type must be sidebar/panel/settings, got "${ui.type}"`);
        }
      }
    }
  }
}

function validateMdManifest(pluginRoot, mdPath) {
  const content = fs.readFileSync(mdPath, 'utf8');
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) {
    logError('plugin.md must start with YAML frontmatter (---)');
    return null;
  }

  const endIdx = trimmed.indexOf('\n---', 3);
  let yaml;
  if (endIdx === -1) {
    const closingIdx = trimmed.indexOf('---', 3);
    if (closingIdx === -1) {
      logError('plugin.md YAML frontmatter not closed');
      return null;
    }
    yaml = trimmed.slice(3, closingIdx).trim();
  } else {
    yaml = trimmed.slice(3, endIdx).trim();
  }

  const fields = {};
  for (const line of yaml.split('\n')) {
    const match = line.match(/^(\w[\w_-]*):\s*(.*)$/);
    if (match) {
      fields[match[1]] = match[2].trim();
    }
  }

  if (!fields.name) {
    logError('Missing name in plugin.md frontmatter');
  }
  if (!fields.description) {
    logError('Missing description in plugin.md frontmatter');
  }

  return fields;
}

function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error('Usage: node scripts/validate-plugin.mjs <plugin-path>');
    process.exit(1);
  }

  const pluginPath = path.resolve(args[0]);
  if (!fs.existsSync(pluginPath)) {
    console.error(`Plugin path not found: ${pluginPath}`);
    process.exit(1);
  }

  if (!fs.statSync(pluginPath).isDirectory()) {
    console.error(`Plugin path is not a directory: ${pluginPath}`);
    process.exit(1);
  }

  console.log(`Validating plugin: ${pluginPath}`);

  const manifest = validatePluginManifest(pluginPath);

  if (errors.length > 0) {
    console.error(`\nValidation FAILED: ${errors.length} error(s), ${warnings.length} warning(s)`);
    process.exit(1);
  }

  if (warnings.length > 0) {
    console.log(`\nValidation PASSED with ${warnings.length} warning(s)`);
  } else {
    console.log('\nValidation PASSED');
  }

  if (manifest) {
    console.log(`  Name: ${manifest.name || '(unknown)'}`);
    console.log(`  Schema: ${manifest.schemaVersion || '(unknown)'}`);
  }
  process.exit(0);
}

main();