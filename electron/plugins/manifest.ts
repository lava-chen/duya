// manifest.ts — plugin manifest reader.
//
// Two shapes coexist after the plugin-config-simplification refactor:
//
// 1. Minimal Codex-style `.duya-plugin/plugin.json` (builtin plugins).
//    On disk it carries only identity + optional `setup` + optional
//    `interface`. The reader resolves every capability (skills, MCP
//    servers, workflows, hooks), every permission, and the permission
//    policy from sibling directory files (`mcp/servers.json`,
//    `permissions/policy.json`, `skills/<n>/SKILL.md`, `workflows/*.yaml`)
//    and returns a fully-populated `PluginManifest` runtime view. This is
//    the unified framework: one reader, disk is truth.
//
// 2. Legacy v1/v2 root `plugin.json` (marketplace + local plugins, kept
//    for compatibility). The hand-written parser below reads the
//    declared `capabilities`/`permissions`/`permissionPolicy`/`components`
//    straight from the JSON. The shape is NOT zod-compatible (see the
//    historical note in `types.ts`); migrating marketplace storage to the
//    minimal shape is owned by Plan 86/311 and is out of scope here.
//
// `plugin.md` as a declaration layer is removed (Plan 86 override): the
// long-form content moved to `interface.longDescription` + `README.md`.

import fs from 'fs';
import path from 'path';
import type { PluginCapabilityKind, PluginInterface, PluginManifest } from './types';
import { discoverAllCapabilities } from '../../packages/plugin-core/src/plugins/loader/capability-discovery.js';

// ----------------------------------------------------------------------------
// Shared low-level helpers
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// Minimal `.duya-plugin/plugin.json` reader + disk resolution
// ----------------------------------------------------------------------------

const DOT_FOLDER_DIR = '.duya-plugin';
const DOT_FOLDER_MANIFEST = path.join(DOT_FOLDER_DIR, 'plugin.json');

/**
 * Agent Plugins 1.0.0 — canonical root `plugin.json` manifest schema
 * identifier. A root `plugin.json` whose `$schema` equals this exactly
 * (the schema declares it as a `const`) is treated as a standard Agent
 * Plugins package rather than a duya v1/v2 manifest.
 */
const AGENT_PLUGINS_PLUGIN_SCHEMA =
  'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';

const VALID_DEFAULT_MODES = ['read', 'draft', 'write', 'modify', 'dangerous'] as const;
type DefaultMode = (typeof VALID_DEFAULT_MODES)[number];

/**
 * Reverse-domain namespace a standard Agent Plugins package uses to carry
 * duya-specific fields that the standard `plugin.json` schema forbids at
 * the root (`additionalProperties: false`). The standard schema assigns no
 * semantics to namespace objects, so duya is free to read this one.
 */
const DUYA_EXTENSION_NAMESPACE = 'com.duya.client';

/**
 * Read `permissions/policy.json` and split it into the two manifest fields
 * it backs: `permissionPolicy` (the tier defaults) and `permissions` (the
 * capability request list). Absent file → no policy, no permissions. This
 * makes `permissions/policy.json` the single source of truth for everything
 * permission-related; `.duya-plugin/plugin.json` never touches permissions.
 */
function readPermissionsPolicy(pluginRoot: string): {
  permissionPolicy: PluginManifest['permissionPolicy'];
  permissions: PluginManifest['permissions'];
} {
  const policyPath = path.join(pluginRoot, 'permissions', 'policy.json');
  if (!fs.existsSync(policyPath)) {
    return { permissionPolicy: undefined, permissions: [] };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(policyPath, 'utf8'));
  } catch {
    return { permissionPolicy: undefined, permissions: [] };
  }
  if (!isObject(raw)) {
    return { permissionPolicy: undefined, permissions: [] };
  }

  const defaultModeRaw = raw.defaultMode;
  const permissionPolicy: PluginManifest['permissionPolicy'] = {
    defaultMode:
      typeof defaultModeRaw === 'string' && (VALID_DEFAULT_MODES as readonly string[]).includes(defaultModeRaw)
        ? (defaultModeRaw as DefaultMode)
        : undefined,
    writeActionsRequireApproval:
      typeof raw.writeActionsRequireApproval === 'boolean'
        ? raw.writeActionsRequireApproval
        : undefined,
    destructiveActionsRequireApproval:
      typeof raw.destructiveActionsRequireApproval === 'boolean'
        ? raw.destructiveActionsRequireApproval
        : undefined,
  };

  const permsRaw = raw.permissions;
  const permissions: PluginManifest['permissions'] = Array.isArray(permsRaw)
    ? permsRaw
        .filter((entry): entry is Record<string, unknown> => isObject(entry))
        .map((entry) => ({
          name: typeof entry.name === 'string' ? entry.name : '',
          scope: typeof entry.scope === 'string' ? entry.scope : undefined,
          domains: Array.isArray(entry.domains)
            ? entry.domains.filter((d): d is string => typeof d === 'string')
            : undefined,
        }))
        .filter((p) => p.name.length > 0)
    : [];

  return { permissionPolicy, permissions };
}

/**
 * Read the connection ids declared in `apps/connections.json` without
 * re-validating the provider (the app-connection manifest parser in
 * `electron/services/app-connections` owns provider validation and the
 * `SUPPORTED_PROVIDERS` list — Plan 312). Here we only need the id list
 * for the `components.appConnections` capability summary.
 */
function readAppConnectionIds(pluginRoot: string): string[] {
  const connsPath = path.join(pluginRoot, 'apps', 'connections.json');
  if (!fs.existsSync(connsPath)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(connsPath, 'utf8'));
    const list = Array.isArray(raw) ? raw : isObject(raw) && Array.isArray(raw.connections) ? raw.connections : [];
    return list
      .filter((entry): entry is Record<string, unknown> => isObject(entry))
      .map((entry) => (typeof entry.id === 'string' ? entry.id : ''))
      .filter((id) => id.length > 0);
  } catch {
    return [];
  }
}

function parseSetupField(
  item: unknown,
  index: number,
): PluginManifest['setup'][number] {
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
    connectionId:
      type === 'app-connection' && typeof item.connectionId === 'string' && item.connectionId.trim().length > 0
        ? item.connectionId
        : undefined,
  };
}

/**
 * Extract the Agent Plugins `extensions` block, keeping only object-valued
 * namespaces (spec `additionalProperties: { type: "object" }`). Returns `{}`
 * when absent or non-object at top level (aligned with spec §8.1).
 */
function parseExtensions(raw: unknown): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  if (isObject(raw)) {
    for (const [namespace, value] of Object.entries(raw)) {
      if (isObject(value)) out[namespace] = value;
    }
  }
  return out;
}

function parseInterfaceBlock(raw: unknown): PluginInterface | undefined {
  if (!isObject(raw)) return undefined;
  const block: PluginInterface = {};
  const displayName = asOptionalString(raw.displayName);
  if (displayName) block.displayName = displayName;
  const longDescription = asOptionalString(raw.longDescription);
  if (longDescription) block.longDescription = longDescription;
  const category = asOptionalString(raw.category);
  if (category) block.category = category as PluginInterface['category'];
  const brandColor = asOptionalString(raw.brandColor);
  if (brandColor) block.brandColor = brandColor;
  if (Array.isArray(raw.screenshots)) {
    block.screenshots = raw.screenshots.filter((s): s is string => typeof s === 'string');
  }
  return Object.keys(block).length > 0 ? block : undefined;
}

/**
 * Read a minimal `.duya-plugin/plugin.json` and resolve a full
 * `PluginManifest` runtime view from the plugin directory. Identity comes
 * from the JSON file; everything else comes from sibling directory files.
 */
function readMinimalManifest(pluginRoot: string, manifestPath: string): PluginManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!isObject(raw)) {
    throw new Error('Invalid plugin manifest root');
  }

  const name = asString(raw.name, 'name');
  const version = asString(raw.version, 'version');
  const description = asString(raw.description, 'description');
  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0 ? raw.id : `com.duya.${name}`;

  const authorRaw = raw.author;
  const author: PluginManifest['author'] = isObject(authorRaw)
    ? {
        name: asString(authorRaw.name, 'author.name'),
        url: typeof authorRaw.url === 'string' ? authorRaw.url : undefined,
        email: typeof authorRaw.email === 'string' ? authorRaw.email : undefined,
      }
    : { name: 'Unknown' };

  // Resolve capabilities from disk (single source of truth).
  const caps = discoverAllCapabilities(pluginRoot);
  const skillNames = caps.skills.map((s) => s.name);
  const mcpServers = caps.mcpServers;
  const workflowNames = caps.workflows.map((w) => w.name);
  const hooks = caps.hooks;

  const { permissionPolicy, permissions } = readPermissionsPolicy(pluginRoot);

  const setup: PluginManifest['setup'] = Array.isArray(raw.setup)
    ? raw.setup.map((item, index) => parseSetupField(item, index))
    : undefined;

  const interfaceBlock = parseInterfaceBlock(raw.interface);

  const manifest: PluginManifest = {
    schemaVersion: 'duya.plugin.v2',
    id,
    name,
    version,
    description,
    author,
    homepage: asOptionalString(raw.homepage) ?? undefined,
    repository: asOptionalString(raw.repository) ?? undefined,
    license: asOptionalString(raw.license) ?? undefined,
    keywords: asOptionalStringArray(raw.keywords) ?? undefined,
    interface: interfaceBlock,
    extensions: parseExtensions(raw.extensions),
    capabilities: {
      skills: skillNames.length ? skillNames : undefined,
      mcpServers: mcpServers.length ? mcpServers : undefined,
      hooks: hooks.length
        ? hooks.map((h) => ({ event: h.event, handler: h.handler }))
        : undefined,
      // cli/ui are not discovered from disk for builtin plugins.
    },
    components: {
      mcpServers: mcpServers.map((s) => s.name),
      appConnections: readAppConnectionIds(pluginRoot),
      skills: skillNames,
      workflows: workflowNames,
    },
    permissionPolicy,
    permissions,
    setup,
    // `engines` is not part of the minimal on-disk shape; default to the
    // current app floor. Marketplace plugins still declare it via the
    // legacy parser branch.
    engines: { duya: '>=0.1.0' },
  };

  return manifest;
}

// ----------------------------------------------------------------------------
// Legacy v1/v2 root `plugin.json` parser (marketplace / local compat)
// ----------------------------------------------------------------------------

function parseLegacyV1V2Manifest(raw: Record<string, unknown>): PluginManifest {
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
  // without a separate undefined-check.
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
      email: typeof authorRaw.email === 'string' ? authorRaw.email : undefined,
    },
    homepage: asOptionalString(raw.homepage) ?? undefined,
    repository: asOptionalString(raw.repository) ?? undefined,
    license: asOptionalString(raw.license) ?? undefined,
    keywords: asOptionalStringArray(raw.keywords) ?? undefined,
    interface: parseInterfaceBlock(raw.interface),
    extensions: parseExtensions(raw.extensions),
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
      ? raw.setup.map((item, index) => parseSetupField(item, index))
      : undefined,
    engines: {
      duya: asString(enginesRaw.duya, 'engines.duya'),
      node: typeof enginesRaw.node === 'string' ? enginesRaw.node : undefined,
    },
  };

  return manifest;
}

// ----------------------------------------------------------------------------
// Standard Agent Plugins package reader (root `plugin.json` + $schema)
// ----------------------------------------------------------------------------

/**
 * Read the duya-specific fields carried in a standard package's
 * `extensions["com.duya.client"]` block. These fields (engines, permissions,
 * permission policy, setup, cli, ui, interface) have no portable meaning, so
 * the standard schema forbids them at the root; duya namespaces them instead.
 * Absent or malformed block → lenient defaults so a third-party standard
 * package never fails to load.
 */
function parseDuyaClientExtension(raw: unknown): {
  permissions: PluginManifest['permissions'];
  setup: PluginManifest['setup'];
  engines: PluginManifest['engines'];
  permissionPolicy: PluginManifest['permissionPolicy'];
  interface: PluginInterface | undefined;
  cli: PluginManifest['capabilities']['cli'];
  ui: PluginManifest['capabilities']['ui'];
} {
  const empty: ReturnType<typeof parseDuyaClientExtension> = {
    permissions: [],
    setup: undefined,
    engines: { duya: '>=0.1.0' },
    permissionPolicy: undefined,
    interface: undefined,
    cli: undefined,
    ui: undefined,
  };
  if (!isObject(raw)) return empty;

  const permissions: PluginManifest['permissions'] = Array.isArray(raw.permissions)
    ? raw.permissions
        .filter((e): e is Record<string, unknown> => isObject(e))
        .map((e) => ({
          name: typeof e.name === 'string' ? e.name : '',
          scope: typeof e.scope === 'string' ? e.scope : undefined,
          domains: Array.isArray(e.domains)
            ? e.domains.filter((d): d is string => typeof d === 'string')
            : undefined,
        }))
        .filter((p) => p.name.length > 0)
    : [];

  const setup: PluginManifest['setup'] = Array.isArray(raw.setup)
    ? raw.setup.map((item, index) => parseSetupField(item, index))
    : undefined;

  const enginesRaw = isObject(raw.engines) ? (raw.engines as Record<string, unknown>) : undefined;
  const engines: PluginManifest['engines'] = {
    duya:
      typeof enginesRaw?.duya === 'string' && enginesRaw.duya.length > 0
        ? enginesRaw.duya
        : '>=0.1.0',
    node: typeof enginesRaw?.node === 'string' ? enginesRaw.node : undefined,
  };

  const policyRaw = isObject(raw.permissionPolicy)
    ? (raw.permissionPolicy as Record<string, unknown>)
    : undefined;
  const permissionPolicy: PluginManifest['permissionPolicy'] = policyRaw
    ? {
        defaultMode:
          typeof policyRaw.defaultMode === 'string' &&
          (VALID_DEFAULT_MODES as readonly string[]).includes(policyRaw.defaultMode)
            ? (policyRaw.defaultMode as DefaultMode)
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

  const cli: PluginManifest['capabilities']['cli'] = Array.isArray(raw.cli)
    ? raw.cli
        .filter((e): e is Record<string, unknown> => isObject(e))
        .map((e, index) => ({
          name: asString(e.name, `extensions.duya.cli[${index}].name`),
          command: asString(e.command, `extensions.duya.cli[${index}].command`),
          args: Array.isArray(e.args)
            ? e.args.filter((a): a is string => typeof a === 'string')
            : undefined,
        }))
    : undefined;

  const ui: PluginManifest['capabilities']['ui'] = Array.isArray(raw.ui)
    ? raw.ui
        .filter((e): e is Record<string, unknown> => isObject(e))
        .map((e, index) => ({
          id: asString(e.id, `extensions.duya.ui[${index}].id`),
          type: asString(e.type, `extensions.duya.ui[${index}].type`),
          entry: asString(e.entry, `extensions.duya.ui[${index}].entry`),
        }))
    : undefined;

  return {
    permissions,
    setup,
    engines,
    permissionPolicy,
    interface: parseInterfaceBlock(raw.interface),
    cli,
    ui,
  };
}

/**
 * Read a standard Agent Plugins 1.0.0 package (root `plugin.json` whose
 * `$schema` equals `AGENT_PLUGINS_PLUGIN_SCHEMA`). Skills and MCP servers
 * are resolved from disk via `discoverAllCapabilities` (the standard
 * `mcp.json` fallback applies), `extensions` is passed through, and
 * duya-specific fields are read from `extensions["com.duya.client"]`. The
 * package is projected onto the duya v2 runtime view; it has no duya id, so
 * one is derived from the package name.
 */
function readAgentPluginsManifest(pluginRoot: string, manifestPath: string): PluginManifest {
  const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as unknown;
  if (!isObject(raw)) {
    throw new Error('Invalid plugin manifest root');
  }

  const name = asString(raw.name, 'name');
  const version = asString(raw.version, 'version');
  const description = asString(raw.description, 'description');
  const id =
    typeof raw.id === 'string' && raw.id.trim().length > 0
      ? raw.id
      : `agent.${name}`;

  const authorRaw = raw.author;
  const author: PluginManifest['author'] = isObject(authorRaw)
    ? {
        name: asString(authorRaw.name, 'author.name'),
        url: typeof authorRaw.url === 'string' ? authorRaw.url : undefined,
        email: typeof authorRaw.email === 'string' ? authorRaw.email : undefined,
      }
    : { name: 'Unknown' };

  const caps = discoverAllCapabilities(pluginRoot);
  const skillNames = caps.skills.map((s) => s.name);
  const mcpServers = caps.mcpServers;
  const workflowNames = caps.workflows.map((w) => w.name);

  const duyaExt = parseDuyaClientExtension(
    isObject(raw.extensions) ? (raw.extensions as Record<string, unknown>)[DUYA_EXTENSION_NAMESPACE] : undefined,
  );

  return {
    schemaVersion: 'duya.plugin.v2',
    id,
    name,
    version,
    description,
    author,
    homepage: asOptionalString(raw.homepage) ?? undefined,
    repository: asOptionalString(raw.repository) ?? undefined,
    license: asOptionalString(raw.license) ?? undefined,
    keywords: asOptionalStringArray(raw.keywords) ?? undefined,
    interface: duyaExt.interface,
    extensions: parseExtensions(raw.extensions),
    capabilities: {
      skills: skillNames.length ? skillNames : undefined,
      mcpServers: mcpServers.length ? mcpServers : undefined,
      cli: duyaExt.cli,
      ui: duyaExt.ui,
    },
    components: {
      mcpServers: mcpServers.map((s) => s.name),
      skills: skillNames,
      workflows: workflowNames,
    },
    permissionPolicy: duyaExt.permissionPolicy,
    permissions: duyaExt.permissions,
    setup: duyaExt.setup,
    engines: duyaExt.engines,
  };
}

// ----------------------------------------------------------------------------
// Public API
// ----------------------------------------------------------------------------

/**
 * Read a plugin manifest from `pluginRoot`.
 *
 * Resolution order:
 *   1. `<root>/.duya-plugin/plugin.json` — minimal Codex-style shape; the
 *      reader resolves capabilities/permissions/policy from sibling
 *      directory files. This is the builtin path.
 *   2. `<root>/plugin.json` — legacy v1/v2 shape (marketplace/local).
 *
 * Throws when neither file is present.
 */
export function readPluginManifest(pluginRoot: string): PluginManifest {
  const dotPath = path.join(pluginRoot, DOT_FOLDER_MANIFEST);
  if (fs.existsSync(dotPath)) {
    return readMinimalManifest(pluginRoot, dotPath);
  }

  const rootPath = path.join(pluginRoot, 'plugin.json');
  if (fs.existsSync(rootPath)) {
    const raw = JSON.parse(fs.readFileSync(rootPath, 'utf8')) as unknown;
    if (!isObject(raw)) {
      throw new Error('Invalid plugin manifest root');
    }
    // Standard Agent Plugins package (root `plugin.json` + canonical
    // `$schema`) → disk-driven reader. Otherwise the legacy v1/v2 path.
    if (raw.$schema === AGENT_PLUGINS_PLUGIN_SCHEMA) {
      return readAgentPluginsManifest(pluginRoot, rootPath);
    }
    return parseLegacyV1V2Manifest(raw);
  }

  throw new Error(`plugin.json not found: ${pluginRoot}`);
}

export interface ManifestReadResult {
  manifest: Partial<PluginManifest>;
  agentContext: string;
  source: 'plugin.json';
  warnings: string[];
}

/**
 * Lenient manifest read — never throws. `plugin.md` is no longer a
 * supported declaration layer (Plan 86 override); only `plugin.json`
 * (minimal or legacy) is read. Parse failures return an empty manifest
 * + warnings so a stale/broken plugin never blocks catalog loading.
 */
export function readPluginManifestLenient(pluginRoot: string): ManifestReadResult {
  try {
    const manifest = readPluginManifest(pluginRoot);
    return {
      manifest,
      agentContext: manifest.interface?.longDescription ?? manifest.description,
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

export function listCapabilityKinds(manifest: PluginManifest): PluginCapabilityKind[] {
  const kinds: PluginCapabilityKind[] = [];
  // v2 manifests declare capabilities under `components` (string[] lists);
  // v1 manifests declare them under `capabilities` (typed objects). The
  // minimal-shape reader populates BOTH (components from disk names,
  // capabilities from disk objects), so the v2 branch is authoritative
  // for builtin plugins and the v1 branch covers legacy marketplace rows.
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
