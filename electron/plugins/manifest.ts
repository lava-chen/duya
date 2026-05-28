import fs from 'fs';
import path from 'path';
import type { PluginCapabilityKind, PluginManifest } from './types';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Invalid plugin manifest field: ${field}`);
  }
  return value;
}

function asStringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid plugin manifest field: ${field}`);
  }
  return value as string[];
}

function asOptionalString(value: unknown): string | null {
  if (typeof value === 'string' && value.trim().length > 0) return value;
  return null;
}

function extractMarkdownFrontmatter(content: string): { yaml: string; body: string } {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith('---')) return { yaml: '', body: content };
  const endIdx = trimmed.indexOf('\n---', 3);
  if (endIdx === -1) {
    const closingIdx = trimmed.indexOf('---', 3);
    if (closingIdx === -1) return { yaml: '', body: content };
    return { yaml: trimmed.slice(3, closingIdx).trim(), body: trimmed.slice(closingIdx + 3).trim() };
  }
  return { yaml: trimmed.slice(3, endIdx).trim(), body: trimmed.slice(endIdx + 4).trim() };
}

function parseSimpleYamlLine(line: string): { key: string; value: string } | null {
  const match = line.match(/^(\w[\w_-]*):\s*(.*)$/);
  if (!match) return null;
  return { key: match[1], value: match[2].trim() };
}

function parseSimpleYaml(yaml: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of yaml.split('\n')) {
    const parsed = parseSimpleYamlLine(line);
    if (parsed) {
      result[parsed.key] = parsed.value;
    }
  }
  return result;
}

export function readPluginManifest(pluginRoot: string): PluginManifest {
  const manifestPath = path.join(pluginRoot, 'plugin.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`plugin.json not found: ${manifestPath}`);
  }

  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!isObject(raw)) {
    throw new Error('Invalid plugin manifest root');
  }

  const schemaVersion = asString(raw.schemaVersion, 'schemaVersion');
  if (schemaVersion !== 'duya.plugin.v1') {
    throw new Error(`Unsupported schemaVersion: ${schemaVersion}`);
  }

  const authorRaw = raw.author;
  if (!isObject(authorRaw)) {
    throw new Error('Invalid plugin manifest field: author');
  }

  const capabilitiesRaw = raw.capabilities;
  if (!isObject(capabilitiesRaw)) {
    throw new Error('Invalid plugin manifest field: capabilities');
  }

  const permissionsRaw = raw.permissions;
  if (!Array.isArray(permissionsRaw)) {
    throw new Error('Invalid plugin manifest field: permissions');
  }

  const enginesRaw = raw.engines;
  if (!isObject(enginesRaw)) {
    throw new Error('Invalid plugin manifest field: engines');
  }

  const manifest: PluginManifest = {
    schemaVersion: 'duya.plugin.v1',
    id: asString(raw.id, 'id'),
    name: asString(raw.name, 'name'),
    version: asString(raw.version, 'version'),
    description: asString(raw.description, 'description'),
    author: {
      name: asString(authorRaw.name, 'author.name'),
      url: typeof authorRaw.url === 'string' ? authorRaw.url : undefined,
    },
    capabilities: {
      skills: capabilitiesRaw.skills ? asStringArray(capabilitiesRaw.skills, 'capabilities.skills') : undefined,
      mcpServers: Array.isArray(capabilitiesRaw.mcpServers)
        ? capabilitiesRaw.mcpServers.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.mcpServers[${index}]`);
            return {
              name: asString(item.name, `capabilities.mcpServers[${index}].name`),
              command: asString(item.command, `capabilities.mcpServers[${index}].command`),
              args: item.args ? asStringArray(item.args, `capabilities.mcpServers[${index}].args`) : undefined,
            };
          })
        : undefined,
      cli: Array.isArray(capabilitiesRaw.cli)
        ? capabilitiesRaw.cli.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.cli[${index}]`);
            return {
              name: asString(item.name, `capabilities.cli[${index}].name`),
              command: asString(item.command, `capabilities.cli[${index}].command`),
              args: item.args ? asStringArray(item.args, `capabilities.cli[${index}].args`) : undefined,
            };
          })
        : undefined,
      hooks: Array.isArray(capabilitiesRaw.hooks)
        ? capabilitiesRaw.hooks.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.hooks[${index}]`);
            return {
              event: asString(item.event, `capabilities.hooks[${index}].event`),
              handler: asString(item.handler, `capabilities.hooks[${index}].handler`),
            };
          })
        : undefined,
      ui: Array.isArray(capabilitiesRaw.ui)
        ? capabilitiesRaw.ui.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.ui[${index}]`);
            return {
              id: asString(item.id, `capabilities.ui[${index}].id`),
              type: asString(item.type, `capabilities.ui[${index}].type`),
              entry: asString(item.entry, `capabilities.ui[${index}].entry`),
            };
          })
        : undefined,
    },
    permissions: permissionsRaw.map((item, index) => {
      if (!isObject(item)) {
        throw new Error(`Invalid permissions[${index}]`);
      }
      return {
        name: asString(item.name, `permissions[${index}].name`),
        scope: typeof item.scope === 'string' ? item.scope : undefined,
        domains: item.domains ? asStringArray(item.domains, `permissions[${index}].domains`) : undefined,
      };
    }),
    setup: Array.isArray(raw.setup)
      ? raw.setup.map((item, index) => {
          if (!isObject(item)) {
            throw new Error(`Invalid setup[${index}]`);
          }
          const type = asString(item.type, `setup[${index}].type`);
          if (!['text', 'secret', 'path', 'url'].includes(type)) {
            throw new Error(`Invalid setup[${index}].type`);
          }
          return {
            id: asString(item.id, `setup[${index}].id`),
            label: asString(item.label, `setup[${index}].label`),
            type: type as 'text' | 'secret' | 'path' | 'url',
            required: item.required === true,
          };
        })
      : undefined,
    engines: {
      duya: asString(enginesRaw.duya, 'engines.duya'),
      node: typeof enginesRaw.node === 'string' ? enginesRaw.node : undefined,
    },
  };

  return manifest;
}

export interface ManifestReadResult {
  manifest: Partial<PluginManifest>;
  agentContext: string;
  source: 'plugin.json' | 'plugin.md';
  warnings: string[];
}

export function readPluginManifestLenient(pluginRoot: string): ManifestReadResult {
  const mdPath = path.join(pluginRoot, 'plugin.md');
  const jsonPath = path.join(pluginRoot, 'plugin.json');

  if (fs.existsSync(mdPath)) {
    const content = fs.readFileSync(mdPath, 'utf-8');
    const { yaml, body } = extractMarkdownFrontmatter(content);
    const frontmatter = parseSimpleYaml(yaml);
    const warnings: string[] = [];

    const name = asOptionalString(frontmatter.name);
    const version = asOptionalString(frontmatter.version);
    const description = asOptionalString(frontmatter.description);
    const id = name ? `com.duya.${name}` : undefined;

    if (!name) warnings.push('Missing name in plugin.md frontmatter');
    if (!description) warnings.push('Missing description in plugin.md frontmatter');

    return {
      manifest: {
        schemaVersion: 'duya.plugin.v1',
        id,
        name: name ?? undefined,
        version: version ?? undefined,
        description: description ?? undefined,
        author: { name: frontmatter.author ?? 'Unknown' },
        capabilities: {},
        permissions: [],
        engines: { duya: '>=0.1.0' },
      },
      agentContext: body || description || '',
      source: 'plugin.md',
      warnings,
    };
  }

  if (fs.existsSync(jsonPath)) {
    try {
      const manifest = readPluginManifest(pluginRoot);
      return {
        manifest,
        agentContext: manifest.description,
        source: 'plugin.json',
        warnings: [],
      };
    } catch (err) {
      return {
        manifest: {},
        agentContext: '',
        source: 'plugin.json',
        warnings: [err instanceof Error ? err.message : String(err)],
      };
    }
  }

  throw new Error(`No plugin.md or plugin.json found in: ${pluginRoot}`);
}

export function listCapabilityKinds(manifest: PluginManifest): PluginCapabilityKind[] {
  const kinds: PluginCapabilityKind[] = [];
  if (manifest.capabilities.skills?.length) kinds.push('skills');
  if (manifest.capabilities.mcpServers?.length) kinds.push('mcp');
  if (manifest.capabilities.cli?.length) kinds.push('cli');
  if (manifest.capabilities.ui?.length) kinds.push('ui');
  if (manifest.capabilities.hooks?.length) kinds.push('hooks');
  return kinds;
}

