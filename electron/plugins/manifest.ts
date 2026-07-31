// manifest.ts — hand-written manifest parser.
//
// This parser cannot switch to `PluginManifestSchema.parse` (zod, in
// src/lib/plugin-types.ts) because it must return the handwritten
// `PluginManifest` shape from ./types.ts, which is NOT shape-compatible
// with the zod-inferred manifest:
//  - zod models `capabilities.skills` as `Array<{ path, description? }>`;
//    the main-process view (and the bundled catalog / on-disk v1 loader)
//    emits plain skill-name strings.
//  - zod has no `setup` field; this parser reads and preserves it.
//  - zod makes `capabilities.mcpServers.args` required-with-default and
//    adds `env`; the main-process view treats `args` as optional and
//    omits `env`.
// Switching to zod parse would therefore break `readPluginManifest`
// consumers (catalog.ts inline manifests, capability-counts.ts, and the
// tests in manifest.test.ts / catalog.test.ts). Migrating the loader and
// the inline manifests to the zod shape is owned by Plan 311 (v1/v2
// compat) and is out of scope for the type convergence pass.

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

function asOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    return undefined;
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
  if (schemaVersion !== 'duya.plugin.v1' && schemaVersion !== 'duya.plugin.v2') {
    throw new Error(`Unsupported schemaVersion: ${schemaVersion}`);
  }

  const authorRaw = raw.author;
  if (!isObject(authorRaw)) {
    throw new Error('Invalid plugin manifest field: author');
  }

  // v1 requires `capabilities`; v2 makes it optional (v2 prefers
  // `components`). When v2 omits `capabilities` we still synthesize an
  // empty object so the `PluginManifest.capabilities` field stays
  // present and downstream code can read `manifest.capabilities.*`
  // without a separate undefined-check. The synthesised shape is
  // equivalent to v1's "all-undefined" capabilities.
  const capabilitiesRaw = raw.capabilities;
  if (schemaVersion === 'duya.plugin.v1' && !isObject(capabilitiesRaw)) {
    throw new Error('Invalid plugin manifest field: capabilities');
  }
  const capsRaw = isObject(capabilitiesRaw) ? capabilitiesRaw : {};

  const permissionsRaw = raw.permissions;
  if (!Array.isArray(permissionsRaw)) {
    throw new Error('Invalid plugin manifest field: permissions');
  }

  const enginesRaw = raw.engines;
  if (!isObject(enginesRaw)) {
    throw new Error('Invalid plugin manifest field: engines');
  }

  // Plan 311 — v2 components & permissionPolicy. Both optional from
  // the type-system perspective (the v1 path leaves them undefined),
  // but v2 manifests are expected to populate `components`.
  const componentsRaw = raw.components;
  const components = isObject(componentsRaw)
    ? {
        mcpServers: asOptionalStringArray(componentsRaw.mcpServers),
        appConnections: asOptionalStringArray(componentsRaw.appConnections),
        skills: asOptionalStringArray(componentsRaw.skills),
        workflows: asOptionalStringArray(componentsRaw.workflows),
      }
    : undefined;

  const policyRaw = raw.permissionPolicy;
  const permissionPolicy = isObject(policyRaw)
    ? {
        defaultMode:
          typeof policyRaw.defaultMode === 'string' &&
          ['read', 'draft', 'write', 'modify', 'dangerous'].includes(policyRaw.defaultMode)
            ? (policyRaw.defaultMode as 'read' | 'draft' | 'write' | 'modify' | 'dangerous')
            : undefined,
        writeActionsRequireApproval:
          typeof policyRaw.writeActionsRequireApproval === 'boolean'
            ? policyRaw.writeActionsRequireApproval
            : undefined,
        destructiveActionsRequireApproval:
          typeof policyRaw.destructiveActionsRequireApproval === 'boolean'
            ? policyRaw.destructiveActionsRequireApproval
            : undefined,
      }
    : undefined;

  const publisherRaw = raw.publisher;
  const publisher = isObject(publisherRaw)
    ? {
        name: asString(publisherRaw.name, 'publisher.name'),
        url: typeof publisherRaw.url === 'string' ? publisherRaw.url : undefined,
        verified: typeof publisherRaw.verified === 'boolean' ? publisherRaw.verified : undefined,
      }
    : undefined;

  const manifest: PluginManifest = {
    schemaVersion,
    id: asString(raw.id, 'id'),
    name: asString(raw.name, 'name'),
    version: asString(raw.version, 'version'),
    description: asString(raw.description, 'description'),
    author: {
      name: asString(authorRaw.name, 'author.name'),
      url: typeof authorRaw.url === 'string' ? authorRaw.url : undefined,
    },
    capabilities: {
      skills: capsRaw.skills ? asStringArray(capsRaw.skills, 'capabilities.skills') : undefined,
      mcpServers: Array.isArray(capsRaw.mcpServers)
        ? capsRaw.mcpServers.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.mcpServers[${index}]`);
            return {
              name: asString(item.name, `capabilities.mcpServers[${index}].name`),
              command: asString(item.command, `capabilities.mcpServers[${index}].command`),
              args: item.args ? asStringArray(item.args, `capabilities.mcpServers[${index}].args`) : undefined,
            };
          })
        : undefined,
      cli: Array.isArray(capsRaw.cli)
        ? capsRaw.cli.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.cli[${index}]`);
            return {
              name: asString(item.name, `capabilities.cli[${index}].name`),
              command: asString(item.command, `capabilities.cli[${index}].command`),
              args: item.args ? asStringArray(item.args, `capabilities.cli[${index}].args`) : undefined,
            };
          })
        : undefined,
      hooks: Array.isArray(capsRaw.hooks)
        ? capsRaw.hooks.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.hooks[${index}]`);
            return {
              event: asString(item.event, `capabilities.hooks[${index}].event`),
              handler: asString(item.handler, `capabilities.hooks[${index}].handler`),
            };
          })
        : undefined,
      ui: Array.isArray(capsRaw.ui)
        ? capsRaw.ui.map((item, index) => {
            if (!isObject(item)) throw new Error(`Invalid capabilities.ui[${index}]`);
            return {
              id: asString(item.id, `capabilities.ui[${index}].id`),
              type: asString(item.type, `capabilities.ui[${index}].type`),
              entry: asString(item.entry, `capabilities.ui[${index}].entry`),
            };
          })
        : undefined,
    },
    components,
    permissionPolicy,
    publisher,
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
          if (!['text', 'secret', 'path', 'url', 'app-connection'].includes(type)) {
            throw new Error(`Invalid setup[${index}].type`);
          }
          return {
            id: asString(item.id, `setup[${index}].id`),
            label: asString(item.label, `setup[${index}].label`),
            type: type as 'text' | 'secret' | 'path' | 'url' | 'app-connection',
            required: item.required === true,
            // Plan 312 — only read for app-connection fields; the loader
            // in PluginManager later pairs this with the connections.json
            // declaration to compute the needs_setup health state.
            connectionId:
              type === 'app-connection' && typeof item.connectionId === 'string' && item.connectionId.trim().length > 0
                ? item.connectionId
                : undefined,
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
  // v2 manifests declare capabilities under `components` (string[] lists);
  // v1 manifests declare them under `capabilities` (typed objects). Inline
  // v2 catalog entries (e.g. bundled skill entries in catalog.ts) omit
  // `capabilities` entirely, so reading `manifest.capabilities.*` without
  // a v2 branch would crash with "Cannot read properties of undefined".
  if (manifest.schemaVersion === 'duya.plugin.v2') {
    const components = manifest.components;
    if (components?.skills?.length) kinds.push('skills');
    if (components?.mcpServers?.length) kinds.push('mcp');
    // v2 `components` has no cli/ui/hooks — those kinds are v1-only.
    return kinds;
  }
  const caps = manifest.capabilities;
  if (caps?.skills?.length) kinds.push('skills');
  if (caps?.mcpServers?.length) kinds.push('mcp');
  if (caps?.cli?.length) kinds.push('cli');
  if (caps?.ui?.length) kinds.push('ui');
  if (caps?.hooks?.length) kinds.push('hooks');
  return kinds;
}

