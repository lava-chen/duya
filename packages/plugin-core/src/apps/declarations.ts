import { z } from 'zod';

const APP_ID_PATTERN = /^[a-z][a-z0-9_-]*$/;
const CAPABILITY_ID_PATTERN = /^[a-z][a-z0-9_.:-]*$/;

/** Maximum UTF-8 size accepted for an MCP-backed Plugin UI document. */
export const PLUGIN_UI_RESOURCE_MAX_BYTES = 8 * 1024 * 1024;

function isPluginUiResourceUri(value: string): boolean {
  if (!value.startsWith('ui://') || /[\s\u0000-\u001f]/.test(value)) return false;
  try {
    const uri = new URL(value);
    return uri.protocol === 'ui:' && uri.hostname.length > 0;
  } catch {
    return false;
  }
}

function isPackageRelativePosixPath(value: string): boolean {
  if (value.length > 512 || value.includes('\0') || value.includes('\\')) return false;
  if (value.startsWith('/') || /^[a-zA-Z]:/.test(value) || /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(value)) {
    return false;
  }

  const segments = value.split('/');
  return segments.every((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

/**
 * One MCP tool an App capability covers.
 *
 * `serverName` and `toolName` are the MCP protocol identities the plugin's
 * own manifest declares, not provider-visible display names. The Host
 * resolves them against the live catalog by canonical tool identity and
 * refuses a match that does not belong to the declaring plugin, so a
 * same-named tool from another plugin never satisfies a mapping.
 */
export const PluginAppCapabilityToolSchema = z
  .object({
    serverName: z.string().min(1).max(128),
    toolName: z.string().min(1).max(128),
  })
  .strict();

/**
 * Explicit mapping from an App capability to the MCP tools it covers.
 *
 * The mapping is declared, never derived: a capability ID is a plugin
 * contract, and inferring it from a server or tool name would let one
 * plugin's declaration silently claim another's tools.
 */
export const PluginAppCapabilityMappingSchema = z
  .object({
    capability: z.string().min(1).max(128).regex(CAPABILITY_ID_PATTERN),
    tools: z.array(PluginAppCapabilityToolSchema).max(256),
  })
  .strict();

/** An MCP resource-backed view that belongs to one Plugin App. */
export const PluginUiSurfaceSchema = z
  .object({
    id: z.string().min(1).max(64).regex(APP_ID_PATTERN),
    /** The desktop currently supports English and Chinese UI locales. */
    title: z
      .object({
        en: z.string().min(1).max(128),
        zh: z.string().min(1).max(128),
      })
      .strict(),
    /** An icon identifier resolved by the host's allowlisted icon map. */
    icon: z.string().min(1).max(64),
    server: z.string().min(1).max(128),
    resourceUri: z.string().min(1).max(2048).refine(isPluginUiResourceUri),
    availability: z.enum(['always', 'session']),
  })
  .strict();

export type PluginUiSurface = z.infer<typeof PluginUiSurfaceSchema>;

/**
 * The places an App may ask the host to render an entry for it.
 *
 * A closed set on purpose: a slot is a promise that something will actually be
 * rendered there, and accepting an unknown one would let a plugin declare an
 * entry that silently never appears. `project.tab` is deliberately absent
 * until the Project workspace has a host to render it — adding it now would
 * mean accepting a value nobody honours.
 */
export const PLUGIN_APP_PLACEMENT_SLOTS = ['sidebar.item', 'session.panel'] as const;

export type PluginAppPlacementSlot = (typeof PLUGIN_APP_PLACEMENT_SLOTS)[number];

/**
 * One declared entry point for an App.
 *
 * This is a *placement*, not a component: the host renders an entry that opens
 * the App in its sandboxed frame. Nothing from the plugin enters the host's
 * React tree.
 *
 * `surface` names which of the App's surfaces this entry opens. Omitting it
 * means "the package entry file", which only an App with `entry` can honour —
 * validated when the whole App is checked.
 */
export const PluginAppPlacementSchema = z
  .object({
    slot: z.enum(PLUGIN_APP_PLACEMENT_SLOTS),
    /**
     * `session` entries exist inside a chat; `global` entries exist without
     * one. The scope decides whether the App needs a chat session to open.
     */
    scope: z.enum(['session', 'global']),
    surface: z.string().min(1).max(64).regex(APP_ID_PATTERN).optional(),
  })
  .strict();

export type PluginAppPlacement = z.infer<typeof PluginAppPlacementSchema>;

/** Safe projection of one placement for the host directory. */
export interface PluginUiPlacementDirectoryEntry {
  pluginId: string;
  pluginName: string;
  appId: string;
  slot: PluginAppPlacementSlot;
  scope: PluginAppPlacement['scope'];
  /** Present when the entry opens a surface; absent for a package entry App. */
  surfaceId?: string;
  server?: string;
  availability: 'always' | 'session';
  title: { en: string; zh: string };
  icon: string;
}

/** Safe projection of an installed Plugin App surface for the host directory. */
export interface PluginUiSurfaceDirectoryEntry extends PluginUiSurface {
  pluginId: string;
  pluginName: string;
  appId: string;
}

/** Surface identifiers excluded because more than one installed App owns them. */
export interface PluginUiSurfaceDirectoryConflict {
  id: string;
  owners: Array<{ pluginId: string; pluginName: string; appId: string }>;
}

export interface PluginUiSurfaceDirectory {
  surfaces: PluginUiSurfaceDirectoryEntry[];
  conflicts: PluginUiSurfaceDirectoryConflict[];
  /** Enabled placement entries, ordered by slot then owner. */
  placements: PluginUiPlacementDirectoryEntry[];
}

/** A package-local App declaration; it describes metadata, not a grant. */
export const PluginAppDefinitionSchema = z
  .object({
    appId: z.string().min(1).max(64).regex(APP_ID_PATTERN),
    /** Legacy package-local static entry. Resource-only Apps may omit it. */
    entry: z.string().min(1).refine(isPackageRelativePosixPath).optional(),
    ui: z
      .object({
        /**
         * `surfaces` used to be required. A placement that opens the package
         * entry needs none, so the pair is now optional individually and the
         * object only has to carry at least one of them.
         */
        surfaces: z.array(PluginUiSurfaceSchema).min(1).max(64).optional(),
        placements: z.array(PluginAppPlacementSchema).min(1).max(16).optional(),
      })
      .strict()
      .refine((ui) => ui.surfaces !== undefined || ui.placements !== undefined, {
        message: 'ui requires surfaces or placements',
        path: ['surfaces'],
      })
      .optional(),
    /** Standalone Apps keep their own MCP session when no agent run is active. */
    runtime: z.enum(['agent-run', 'standalone']).optional(),
    requiredCapabilities: z
      .array(z.string().min(1).max(128).regex(CAPABILITY_ID_PATTERN))
      .max(64),
    stateSchemaVersion: z.number().int().positive(),
    /**
     * Which MCP tools each requested capability covers. Optional, because an
     * App may request a capability it does not exercise yet; when present it
     * must be unambiguous and must name only requested capabilities.
     */
    capabilityTools: z.array(PluginAppCapabilityMappingSchema).max(64).optional(),
  })
  .strict()
  .superRefine((app, ctx) => {
    const surfaceCount = app.ui?.surfaces?.length ?? 0;
    const placementCount = app.ui?.placements?.length ?? 0;
    if (app.entry === undefined && surfaceCount === 0 && placementCount === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'App requires a static entry, a UI surface, or a placement',
        path: ['entry'],
      });
    }
    // A placement with no `surface` opens the package entry, so it is only
    // launchable when the App has one. Caught here rather than at launch:
    // a broken entry point should not survive installation.
    app.ui?.placements?.forEach((placement, index) => {
      if (placement.surface !== undefined || app.entry !== undefined) return;
      ctx.addIssue({
        code: 'custom',
        message: 'Placement without a surface requires a static entry',
        path: ['ui', 'placements', index, 'surface'],
      });
    });
    app.ui?.placements?.forEach((placement, index) => {
      if (placement.surface === undefined) return;
      if (app.ui?.surfaces?.some((surface) => surface.id === placement.surface)) return;
      ctx.addIssue({
        code: 'custom',
        message: `Placement names unknown surface: ${placement.surface}`,
        path: ['ui', 'placements', index, 'surface'],
      });
    });
  });

export type PluginAppDefinition = z.infer<typeof PluginAppDefinitionSchema>;
export type PluginAppCapabilityTool = z.infer<typeof PluginAppCapabilityToolSchema>;
export type PluginAppCapabilityMapping = z.infer<typeof PluginAppCapabilityMappingSchema>;

export const PluginAppDefinitionsSchema = z
  .array(PluginAppDefinitionSchema)
  .max(64)
  .superRefine((apps, ctx) => {
    const seen = new Set<string>();
    apps.forEach((app, index) => {
      if (seen.has(app.appId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Duplicate appId: ${app.appId}`,
          path: [index, 'appId'],
        });
      }
      seen.add(app.appId);

      const requested = new Set(app.requiredCapabilities);
      const mappedCapabilities = new Set<string>();
      const toolOwners = new Map<string, string>();
      (app.capabilityTools ?? []).forEach((mapping, mappingIndex) => {
        const path = [index, 'capabilityTools', mappingIndex];
        if (!requested.has(mapping.capability)) {
          ctx.addIssue({
            code: 'custom',
            message: `Capability ${mapping.capability} is mapped but not requested`,
            path: [...path, 'capability'],
          });
        }
        if (mappedCapabilities.has(mapping.capability)) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate capability mapping: ${mapping.capability}`,
            path: [...path, 'capability'],
          });
        }
        mappedCapabilities.add(mapping.capability);
        mapping.tools.forEach((tool, toolIndex) => {
          const key = `${tool.serverName}\u0000${tool.toolName}`;
          const owner = toolOwners.get(key);
          if (owner !== undefined) {
            ctx.addIssue({
              code: 'custom',
              message: `Tool ${tool.serverName}/${tool.toolName} is mapped by both ${owner} and ${mapping.capability}`,
              path: [...path, 'tools', toolIndex],
            });
          }
          toolOwners.set(key, mapping.capability);
        });
      });
    });

    const surfaceOwners = new Map<string, { appIndex: number; surfaceIndex: number }>();
    apps.forEach((app, appIndex) => {
      app.ui?.surfaces?.forEach((surface, surfaceIndex) => {
        const owner = surfaceOwners.get(surface.id);
        if (owner !== undefined) {
          ctx.addIssue({
            code: 'custom',
            message: `Duplicate UI surface id: ${surface.id}`,
            path: [appIndex, 'ui', 'surfaces', surfaceIndex, 'id'],
          });
        } else {
          surfaceOwners.set(surface.id, { appIndex, surfaceIndex });
        }
      });
    });
  });

/** Bind the shared App schema to the MCP server names declared by one plugin. */
export function pluginAppDefinitionsSchemaForMcpServers(
  mcpServerNames: readonly string[],
) {
  const declaredServers = new Set(mcpServerNames);
  return PluginAppDefinitionsSchema.superRefine((apps, ctx) => {
    apps.forEach((app, appIndex) => {
      app.ui?.surfaces?.forEach((surface, surfaceIndex) => {
        if (!declaredServers.has(surface.server)) {
          ctx.addIssue({
            code: 'custom',
            message: `UI surface server ${surface.server} is not declared in this plugin's mcpServers`,
            path: [appIndex, 'ui', 'surfaces', surfaceIndex, 'server'],
          });
        }
      });
    });
  });
}

/** Stable identity of one mapped tool, independent of declaration order. */
export function pluginAppCapabilityToolKey(tool: PluginAppCapabilityTool): string {
  return `${tool.serverName}\u0000${tool.toolName}`;
}

/**
 * The tools a capability currently maps to, sorted for stable comparison.
 * Returns null when the App declares no mapping for that capability.
 */
export function pluginAppCapabilityTools(
  app: PluginAppDefinition,
  capability: string,
): PluginAppCapabilityTool[] | null {
  const mapping = (app.capabilityTools ?? []).find((entry) => entry.capability === capability);
  if (!mapping) return null;
  return mapping.tools
    .map((tool) => ({ serverName: tool.serverName, toolName: tool.toolName }))
    .sort((left, right) => pluginAppCapabilityToolKey(left).localeCompare(pluginAppCapabilityToolKey(right)));
}

/**
 * True when the declared mapping covers a tool the approved scope did not.
 *
 * A narrowed mapping stays covered by the existing grant; a widened one
 * needs a fresh approval, because the user consented to a smaller tool
 * scope than the plugin now asks for.
 */
export function pluginAppCapabilityMappingExpands(
  app: PluginAppDefinition,
  capability: string,
  approvedTools: readonly PluginAppCapabilityTool[],
): boolean {
  const declared = pluginAppCapabilityTools(app, capability);
  if (declared === null) return false;
  const approved = new Set(approvedTools.map((tool) => pluginAppCapabilityToolKey(tool)));
  return declared.some((tool) => !approved.has(pluginAppCapabilityToolKey(tool)));
}
