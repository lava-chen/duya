import type {
  BestEffortManifest,
  LenientValidationResult,
  LenientValidationWarning,
  ValidatedCapabilities,
  ValidatedCapability,
  ValidatedHook,
} from './types.js';

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | null {
  if (typeof value !== 'string' || value.trim().length === 0) return null;
  return value;
}

function parseAuthor(raw: unknown): { name: string; url?: string } | null | undefined {
  if (!isObject(raw)) return undefined;
  const name = asString(raw.name);
  if (!name) return null;
  return {
    name,
    url: typeof raw.url === 'string' ? raw.url : undefined,
  };
}

function parseCapabilityItem(
  item: unknown,
  index: number,
  kind: string
): ValidatedCapability | null {
  if (!isObject(item)) return null;
  const name = asString(item.name);
  if (!name) return null;
  return {
    name,
    file: asString(item.file) ?? asString(item.path) ?? `${kind}/${name}.md`,
    description: typeof item.description === 'string' ? item.description : undefined,
  };
}

function parseHookItem(
  item: unknown,
  index: number
): ValidatedHook | null {
  if (!isObject(item)) return null;
  const event = asString(item.event);
  const handler = asString(item.handler);
  if (!event || !handler) return null;
  return { event, handler };
}

export function validatePluginManifestLenient(
  raw: unknown
): LenientValidationResult {
  const warnings: LenientValidationWarning[] = [];
  const manifest: BestEffortManifest = {};
  const capabilities: ValidatedCapabilities = {
    commands: [],
    skills: [],
    agents: [],
    hooks: [],
  };
  let agentContext = '';
  let complete = true;

  if (!isObject(raw)) {
    return {
      valid: false,
      warnings: [{ field: 'root', message: 'Manifest must be an object' }],
      manifest,
      capabilities,
      agentContext: '',
      complete: false,
    };
  }

  const schemaVersion = asString(raw.schemaVersion);
  if (!schemaVersion) {
    warnings.push({ field: 'schemaVersion', message: 'Missing schemaVersion, assuming duya.plugin.v1' });
    complete = false;
  } else if (schemaVersion !== 'duya.plugin.v1') {
    warnings.push({ field: 'schemaVersion', message: `Unknown schemaVersion: ${schemaVersion}, treating as best-effort` });
    complete = false;
  }
  manifest.schemaVersion = schemaVersion ?? 'duya.plugin.v1';

  const id = asString(raw.id);
  if (id) {
    manifest.id = id;
  } else {
    warnings.push({ field: 'id', message: 'Missing plugin id' });
    complete = false;
  }

  const name = asString(raw.name);
  if (name) {
    manifest.name = name;
  } else {
    warnings.push({ field: 'name', message: 'Missing plugin name' });
    complete = false;
  }

  const version = asString(raw.version);
  if (version) {
    manifest.version = version;
  } else {
    warnings.push({ field: 'version', message: 'Missing version' });
    complete = false;
  }

  const description = asString(raw.description);
  if (description) {
    manifest.description = description;
  } else {
    warnings.push({ field: 'description', message: 'Missing description' });
    complete = false;
  }

  const author = parseAuthor(raw.author);
  if (author === undefined) {
  } else if (author === null) {
    warnings.push({ field: 'author', message: 'Invalid author object, missing name' });
    complete = false;
  } else {
    manifest.author = author;
  }

  if (isObject(raw.entry)) {
    const main = asString(raw.entry.main);
    const entryType = asString(raw.entry.type);
    if (main) {
      manifest.entry = {
        type: entryType ?? 'node',
        main,
      };
    } else {
      warnings.push({ field: 'entry.main', message: 'Missing entry.main' });
      complete = false;
    }
  }

  if (isObject(raw.engines)) {
    manifest.engines = {};
    const duyaVer = asString(raw.engines.duya);
    if (duyaVer) {
      manifest.engines.duya = duyaVer;
    }
    const nodeVer = asString(raw.engines.node);
    if (nodeVer) {
      manifest.engines.node = nodeVer;
    }
  }

  if (Array.isArray(raw.permissions)) {
    manifest.permissions = [];
    for (let i = 0; i < raw.permissions.length; i++) {
      const item = raw.permissions[i];
      if (isObject(item)) {
        const permName = asString(item.name);
        if (permName) {
          manifest.permissions.push({
            name: permName,
            scope: typeof item.scope === 'string' ? item.scope : undefined,
            domains: Array.isArray(item.domains)
              ? item.domains.filter((d): d is string => typeof d === 'string')
              : undefined,
          });
        } else {
          warnings.push({ field: `permissions[${i}]`, message: 'Missing permission name' });
        }
      }
    }
  }

  if (isObject(raw.capabilities)) {
    manifest.capabilities = raw.capabilities;
  }

  for (const kind of ['commands', 'skills', 'agents'] as const) {
    const rawItems = isObject(raw) && Array.isArray(raw[kind]) ? raw[kind] : null;
    if (rawItems) {
      for (let i = 0; i < rawItems.length; i++) {
        const parsed = parseCapabilityItem(rawItems[i], i, kind);
        if (parsed) {
          capabilities[kind].push(parsed);
        } else {
          warnings.push({ field: `${kind}[${i}]`, message: `Invalid ${kind} item` });
          complete = false;
        }
      }
    }
  }

  if (isObject(raw) && Array.isArray(raw.hooks)) {
    for (let i = 0; i < raw.hooks.length; i++) {
      const parsed = parseHookItem(raw.hooks[i], i);
      if (parsed) {
        capabilities.hooks.push(parsed);
      } else {
        warnings.push({ field: `hooks[${i}]`, message: 'Invalid hook item' });
        complete = false;
      }
    }
  }

  agentContext = typeof (raw as Record<string, unknown>).agent_context === 'string'
    ? (raw as Record<string, unknown>).agent_context as string
    : '';

  const valid = warnings.length === 0 || manifest.name !== undefined;

  return {
    valid,
    warnings,
    manifest,
    capabilities,
    agentContext,
    complete: complete && warnings.length === 0,
  };
}