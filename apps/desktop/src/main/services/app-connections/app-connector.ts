/**
 * Unified AppConnector model — Plan 455 Phase B (D2).
 *
 * One abstraction answers "how does the ConnectorService execute the
 * tool surface of connector X?" via a single {@link AppConnectorRegistry}
 * resolution instead of per-provider special cases:
 *
 *   - `mcp-remote` — the connector is a hosted/declared MCP endpoint;
 *     execution goes through {@link RemoteMcpConnector} (RFC 9728 + DCR).
 *   - `rest`       — tools are declared REST templates (`.app.json`
 *     `tools[].invoke`); execution goes through Plan 460's generic invoker.
 *   - `custom`     — a first-party TS module (escape hatch for token
 *     handling / binary transfer / CLI subprocesses that declarations
 *     cannot express). ONLY first-party code may register here (455 D4):
 *     plugin declaration data can never execute local code.
 *
 * Declaration-driven entries come from plugin `.app.json` files parsed by
 * plugin-core's `parseAppDeclarationFile` (455 D3). A bare `{ id }` entry
 * is a pure reference (Plan 452 subset) and falls through to the host
 * catalog instead of shadowing it.
 */

import type {
  AppDeclaration,
  AppToolDeclaration,
} from '@duya/plugin-core/src/connectors/app-schema.js';
import {
  asAppConnectorId,
  isBuiltinConnectorId,
  type AppConnectorId,
} from '@duya/plugin-core/src/connectors/app-connector-id.js';
import type { ConnectorModule, ConnectorToolDescriptor } from './connector-types.js';
import type { RiskTier } from './types.js';
import { getProviderConfig } from './providers/registry.js';

export type AppConnectorBinding = 'mcp-remote' | 'rest' | 'custom';

/** Display data stamped onto descriptors (declarative connectors only). */
export interface AppConnectorMeta {
  label?: string;
  monogram?: string;
  description?: string;
  category?: string;
}

/** How the ConnectorService executes one connector id. */
export interface AppConnectorResolution {
  provider: AppConnectorId;
  binding: AppConnectorBinding;
  /** Display data from the declaring `.app.json` (declarative only). */
  meta?: AppConnectorMeta;
  /** The declaring entry, when resolved declaratively. */
  declaration?: AppDeclaration;
}

/** Deps handed to first-party custom connector factories. */
export interface CustomConnectorDeps {
  fetchImpl: typeof fetch;
}

export type CustomConnectorFactory = (deps: CustomConnectorDeps) => ConnectorModule;

const customConnectorImplementations = new Map<AppConnectorId, CustomConnectorFactory>();

/** First-party only (455 D4) — never call from data-driven paths. */
export function registerCustomConnector(id: AppConnectorId, factory: CustomConnectorFactory): void {
  customConnectorImplementations.set(id, factory);
}

export function getCustomConnectorFactory(id: AppConnectorId): CustomConnectorFactory | undefined {
  return customConnectorImplementations.get(id);
}

export function _resetCustomConnectorImplementations(): void {
  customConnectorImplementations.clear();
}

function metaOf(declaration: AppDeclaration): AppConnectorMeta {
  const label = declaration.interface?.label ?? declaration.name;
  return {
    ...(label ? { label } : {}),
    ...(declaration.interface?.monogram ? { monogram: declaration.interface.monogram } : {}),
    ...(declaration.interface?.description
      ? { description: declaration.interface.description }
      : {}),
    ...(declaration.category ? { category: declaration.category } : {}),
  };
}

/**
 * Project declared tools onto the LLM-facing descriptor shape. Static
 * data — no tokens, no network. `action` defaults to the tool name so
 * the rest binding dispatches without an explicit key.
 */
export function declarativeDescriptors(
  declaration: AppDeclaration,
  connectionId: string,
): ConnectorToolDescriptor[] {
  return declaration.tools.map((tool: AppToolDeclaration) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: {
      type: 'object' as const,
      properties: tool.inputSchema.properties,
      ...(tool.inputSchema.required ? { required: tool.inputSchema.required } : {}),
    },
    inputSchemaSummary: tool.inputSchemaSummary,
    riskTier: tool.riskTier as RiskTier,
    ...(tool.title ? { title: tool.title } : {}),
    provider: asAppConnectorId(declaration.id),
    connectionId,
    action: tool.action ?? tool.name,
  }));
}

/**
 * Resolution source of truth for the connector catalog: plugin
 * declarations + first-party custom implementations + the builtin
 * provider registry, in that order. Reference entries never shadow the
 * host catalog; definitions are rejected when they collide.
 */
export class AppConnectorRegistry {
  private readonly declarations = new Map<
    AppConnectorId,
    { declaration: AppDeclaration; source: string }
  >();

  /**
   * Register one `.app.json` entry. Definition entries (oauth/tools
   * present) may not collide with builtin ids or earlier declarations;
   * bare references always pass (they only alias an existing connector).
   */
  registerDeclaration(declaration: AppDeclaration, source: string): { ok: boolean; reason?: string } {
    const isDefinition = Boolean(declaration.oauth?.remoteMcpUrl) || declaration.tools.length > 0;
    if (isDefinition && isBuiltinConnectorId(declaration.id)) {
      return { ok: false, reason: `connector id '${declaration.id}' is reserved for builtins` };
    }
    const existing = this.declarations.get(asAppConnectorId(declaration.id));
    if (existing) {
      return {
        ok: false,
        reason: `connector id '${declaration.id}' is already declared by ${existing.source}`,
      };
    }
    this.declarations.set(asAppConnectorId(declaration.id), { declaration, source });
    return { ok: true };
  }

  /** Remove every declaration contributed by `source` (plugin unload). */
  unregisterSource(source: string): number {
    let removed = 0;
    for (const [id, entry] of this.declarations) {
      if (entry.source === source) {
        this.declarations.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  listDeclared(): AppConnectorId[] {
    return Array.from(this.declarations.keys());
  }

  resolve(provider: AppConnectorId): AppConnectorResolution | undefined {
    const entry = this.declarations.get(provider);
    if (entry) {
      const { declaration } = entry;
      if (declaration.oauth?.remoteMcpUrl) {
        return { provider, binding: 'mcp-remote', meta: metaOf(declaration), declaration };
      }
      if (declaration.tools.length > 0) {
        // Plan 460 wires the `rest` invoker; descriptors are static data.
        return { provider, binding: 'rest', meta: metaOf(declaration), declaration };
      }
      // Bare reference (Plan 452 subset) — fall through to the host catalog.
    }
    if (customConnectorImplementations.has(provider)) {
      return { provider, binding: 'custom' };
    }
    if (getProviderConfig(provider)?.remoteMcpUrl) {
      return { provider, binding: 'mcp-remote' };
    }
    return undefined;
  }
}
