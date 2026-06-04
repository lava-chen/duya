/**
 * electron/cli/handlers/plugins.ts
 *
 * Read-only + Phase 7 write handlers for the CLI control plane.
 *
 * IMPORTANT: directly reuses `electron/plugins/PluginManager` — does NOT
 * create a new CLI-side wrapper service. Per audit, `listInstalled()` and
 * `getDetail(id)` already expose everything we need.
 *
 * Stable JSON contract (Phase 0):
 *   list  → 5 fields: name / version / enabled / capabilities / source
 *   info  → 7 fields: name / version / enabled / capabilities / source / description / permissions
 *
 * Phase 7 write contract (Plan 100):
 *   enable  → 3 fields: id / enabled: true  / changedAt (ISO8601)
 *   disable → 3 fields: id / enabled: false / changedAt (ISO8601)
 *   doctor  → { checks: [{ id, status, message, pluginId? }] }
 *
 * NEVER exposes: installPath (absolute path), raw manifest, env, lastError internals.
 *
 * Write endpoints reuse the unified `control-plane-audit.log.jsonl` recorder
 * (Plan 98 convention). `isManagedPluginLocked` from PolicyEngine is
 * enforced inside `PluginManager.setEnabled` — we do NOT bypass it.
 */

import { join } from 'node:path';
import { homedir } from 'node:os';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { getPluginManager } from '../../plugins/PluginManager';
import type { PluginCapabilityKind, PluginRegistryEntry, PluginCatalogEntry } from '../../plugins/types';
import { listCapabilityKinds, readPluginManifest } from '../../plugins/manifest';
import { appendAuditEvent, type AuditEvent } from '../../services/controlPlaneAudit';

interface PluginListItem {
  id: string;
  name: string;
  version: string;
  enabled: boolean;
  capabilities: PluginCapabilityKind[];
  source: string;
}

interface PluginInfoItem extends PluginListItem {
  description: string;
  permissions: string[];
}

function toListItem(entry: PluginRegistryEntry, catalogEntry: PluginCatalogEntry | null): PluginListItem {
  const capabilities: PluginCapabilityKind[] = catalogEntry
    ? listCapabilityKinds(catalogEntry.manifest)
    : (entry as unknown as { capabilityKinds?: PluginCapabilityKind[] }).capabilityKinds ?? [];

  return {
    id: entry.id,
    name: entry.name,
    version: entry.version,
    enabled: entry.enabled,
    capabilities,
    source: entry.source,
  };
}

function toInfoItem(entry: PluginRegistryEntry, catalogEntry: PluginCatalogEntry | null): PluginInfoItem {
  const list = toListItem(entry, catalogEntry);
  return {
    ...list,
    description: catalogEntry?.manifest?.description ?? '',
    permissions: (entry.grantedPermissions ?? []).map((p) => p.name),
  };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

/**
 * Probe plugin registry accessibility for the /v1/status endpoint.
 * Returns true if `listInstalled()` succeeds; false otherwise.
 * Catches errors silently — the caller reports pluginReady=false.
 */
export function probePluginRegistry(): boolean {
  try {
    getPluginManager().listInstalled();
    return true;
  } catch {
    return false;
  }
}

export function handleListPlugins(_req: IncomingMessage, res: ServerResponse): void {
  let entries: PluginRegistryEntry[];
  let catalogIndex: Map<string, PluginCatalogEntry>;
  try {
    const manager = getPluginManager();
    entries = manager.listInstalled();
    catalogIndex = new Map();
    for (const catalog of manager.listCatalog()) {
      catalogIndex.set(catalog.id, catalog);
    }
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'plugin_registry_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  const plugins: PluginListItem[] = entries.map((e) =>
    toListItem(e, catalogIndex.get(e.id) ?? null)
  );
  sendJson(res, 200, { plugins });
}

/**
 * Path: /v1/plugins/:id — `id` is the stable unique plugin id
 * (e.g. "com.duya.literature"). Display name lookup is intentionally NOT
 * supported; the CLI surface takes the id directly.
 */
export function handleGetPlugin(_req: IncomingMessage, res: ServerResponse, id: string): void {
  let entry: PluginRegistryEntry | null = null;
  let catalog: PluginCatalogEntry | null = null;
  try {
    const manager = getPluginManager();
    const detail = manager.getDetail(id);
    if (detail.entry) {
      entry = detail.entry;
      catalog = detail.catalog;
    }
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'plugin_registry_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  if (!entry) {
    sendJson(res, 404, {
      error: {
        code: 'plugin_not_found',
        message: `Plugin not found: ${id}`,
      },
    });
    return;
  }

  sendJson(res, 200, toInfoItem(entry, catalog));
}

// ============================================================================
// Phase 7 write operations (Plan 100)
// ============================================================================

/**
 * Resolve the userData dir for the audit log. Mirrors
 * `skillWrite.ts` convention: dev override via DUYA_CLI_USER_DATA_DIR,
 * otherwise Electron's `app.getPath('userData')`, otherwise `~/.duya`.
 */
function getUserDataDir(): string {
  const envOverride = process.env.DUYA_CLI_USER_DATA_DIR;
  if (envOverride && envOverride.trim().length > 0) return envOverride;
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') {
      return app.getPath('userData');
    }
  } catch {
    // not in electron context
  }
  return join(homedir(), '.duya');
}

/**
 * Map PluginError.type → HTTP status + error code for the write endpoints.
 * The shape mirrors `skillWrite.ts` / plan 98 cron handlers.
 */
function classifyPluginError(errType: string): { status: number; code: string } {
  switch (errType) {
    case 'plugin-not-found':
      return { status: 404, code: 'plugin_not_found' };
    case 'generic-error':
      // Policy lock and other generic errors surface as 409 Conflict.
      return { status: 409, code: 'plugin_managed_locked' };
    default:
      return { status: 500, code: 'plugin_registry_error' };
  }
}

interface PluginWriteDTO {
  id: string;
  enabled: boolean;
  changedAt: string;
}

async function applyEnabledChange(
  _req: IncomingMessage,
  res: ServerResponse,
  id: string,
  enabled: boolean,
  correlationId: string | undefined,
): Promise<void> {
  let result;
  try {
    result = await getPluginManager().setEnabled(id, enabled);
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'plugin_registry_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
    return;
  }

  if (!result.success) {
    const { status, code } = classifyPluginError(result.error.type);
    sendJson(res, status, {
      error: {
        code,
        message: getPluginErrorMessage(result.error),
      },
    });
    return;
  }

  const dto: PluginWriteDTO = {
    id: result.data.id,
    enabled: result.data.enabled,
    changedAt: result.data.updatedAt,
  };

  // Audit (best-effort; never throws into the caller).
  const event: AuditEvent = {
    kind: enabled ? 'plugin.enable' : 'plugin.disable',
    id,
    ts: Date.now(),
    invokedBy: 'cli',
    ...(correlationId ? { correlationId } : {}),
  };
  await appendAuditEvent(getUserDataDir(), event);

  sendJson(res, 200, { plugin: dto });
}

export async function handleEnablePlugin(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId: string | undefined,
): Promise<void> {
  return applyEnabledChange(req, res, id, true, correlationId);
}

export async function handleDisablePlugin(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId: string | undefined,
): Promise<void> {
  return applyEnabledChange(req, res, id, false, correlationId);
}

// ============================================================================
// Phase 2: GET /v1/plugins/doctor (Plan 100)
// ============================================================================

interface PluginDoctorCheck {
  id: string;
  status: 'ok' | 'warn' | 'error';
  message: string;
  pluginId?: string;
}

type PluginErrorLike = { type: string; message?: string; plugin?: string };

/**
 * Read the PluginError message without a hard import on the
 * (potentially large) shared `plugin-error-messages` module. Falls
 * back to a generic string when the field is missing.
 */
function getPluginErrorMessage(err: PluginErrorLike): string {
  if (typeof err.message === 'string' && err.message.length > 0) return err.message;
  return `${err.type}${err.plugin ? ` (${err.plugin})` : ''}`;
}

/**
 * Probe plugin load / manifest / registry health. Pure read-only;
 * no side effects. Returns a list of checks. Each check has a stable
 * `id` so the CLI and downstream scripts can filter on it.
 *
 * Check IDs (frozen for plan 100):
 *   - plugin_registry_accessible
 *   - plugin_manifest_valid
 *   - plugin_load_status
 *   - plugin_capability_consistent
 *   - plugin_source_path_exists
 */
export function handlePluginDoctor(
  _req: IncomingMessage,
  res: ServerResponse,
): void {
  const checks: PluginDoctorCheck[] = [];

  let entries: PluginRegistryEntry[] = [];
  let catalog: Map<string, PluginCatalogEntry> = new Map();
  try {
    const manager = getPluginManager();
    entries = manager.listInstalled();
    for (const c of manager.listCatalog()) {
      catalog.set(c.id, c);
    }
  } catch (err) {
    checks.push({
      id: 'plugin_registry_accessible',
      status: 'error',
      message: err instanceof Error ? err.message : String(err),
    });
    sendJson(res, 200, { checks });
    return;
  }

  checks.push({
    id: 'plugin_registry_accessible',
    status: 'ok',
    message: `OK (${entries.length} plugin${entries.length === 1 ? '' : 's'})`,
  });

  // Per-plugin checks
  for (const entry of entries) {
    const catalogEntry = catalog.get(entry.id) ?? null;

    // manifest_valid: catalog entry exists AND its manifest is parseable.
    if (!catalogEntry) {
      checks.push({
        id: 'plugin_manifest_valid',
        status: 'warn',
        message: 'No catalog entry found for installed plugin',
        pluginId: entry.id,
      });
    } else if (catalogEntry.manifest.id !== entry.id) {
      checks.push({
        id: 'plugin_manifest_valid',
        status: 'warn',
        message: `Manifest id mismatch (manifest=${catalogEntry.manifest.id})`,
        pluginId: entry.id,
      });
    } else {
      // Re-parse the manifest from the install path to verify the on-disk
      // file is still valid (catalog entry alone may be stale).
      try {
        const parsed = readPluginManifest(entry.installPath);
        if (parsed.id !== entry.id) {
          checks.push({
            id: 'plugin_manifest_valid',
            status: 'warn',
            message: `On-disk manifest id mismatch (manifest=${parsed.id})`,
            pluginId: entry.id,
          });
        }
      } catch (err) {
        checks.push({
          id: 'plugin_manifest_valid',
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
          pluginId: entry.id,
        });
      }
    }

    // load_status: health.status from registry entry
    const health = entry.health?.status;
    if (health === 'failed') {
      checks.push({
        id: 'plugin_load_status',
        status: 'error',
        message: entry.lastError?.message ?? 'load failed',
        pluginId: entry.id,
      });
    } else if (health === 'disabled') {
      checks.push({
        id: 'plugin_load_status',
        status: 'ok',
        message: 'disabled (by config)',
        pluginId: entry.id,
      });
    } else if (health === 'needs_setup') {
      checks.push({
        id: 'plugin_load_status',
        status: 'warn',
        message: 'needs setup',
        pluginId: entry.id,
      });
    } else if (health === 'ready') {
      checks.push({
        id: 'plugin_load_status',
        status: 'ok',
        message: 'ready',
        pluginId: entry.id,
      });
    } else {
      checks.push({
        id: 'plugin_load_status',
        status: 'warn',
        message: `unknown health state: ${String(health)}`,
        pluginId: entry.id,
      });
    }

    // capability_consistent: catalog-derived kinds match the entry's permission set
    if (catalogEntry) {
      const expectedKinds = listCapabilityKinds(catalogEntry.manifest);
      const hasAny = expectedKinds.length > 0;
      const hasPermissions = entry.grantedPermissions.length > 0;
      if (hasAny && !hasPermissions) {
        checks.push({
          id: 'plugin_capability_consistent',
          status: 'warn',
          message: 'Plugin declares capabilities but no permissions are granted',
          pluginId: entry.id,
        });
      } else {
        checks.push({
          id: 'plugin_capability_consistent',
          status: 'ok',
          message: hasAny ? expectedKinds.join(', ') : 'no capabilities',
          pluginId: entry.id,
        });
      }
    }

    // source_path_exists: installPath is on disk
    const installPath = entry.installPath;
    if (typeof installPath === 'string' && installPath.length > 0) {
      try {
        // Sync existence check via require to keep this handler self-contained
        // (the file check is cheap; not a hot path).
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const fs = require('node:fs') as typeof import('node:fs');
        if (!fs.existsSync(installPath)) {
          checks.push({
            id: 'plugin_source_path_exists',
            status: 'error',
            message: `installPath missing: ${installPath}`,
            pluginId: entry.id,
          });
        } else {
          checks.push({
            id: 'plugin_source_path_exists',
            status: 'ok',
            message: installPath,
            pluginId: entry.id,
          });
        }
      } catch (err) {
        checks.push({
          id: 'plugin_source_path_exists',
          status: 'warn',
          message: err instanceof Error ? err.message : String(err),
          pluginId: entry.id,
        });
      }
    } else {
      checks.push({
        id: 'plugin_source_path_exists',
        status: 'warn',
        message: 'no installPath recorded',
        pluginId: entry.id,
      });
    }
  }

  sendJson(res, 200, { checks });
}

// ============================================================================
// Phase 4: install / uninstall / update (Plan 200 P4)
// ============================================================================

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const MAX = 1024 * 1024;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (chunks.length === 0) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });
}

function asString(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 ? v : undefined;
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1 || v === '1';
}

function pluginErrorToResponse(err: unknown): { status: number; body: unknown } {
  const e = err as { type?: string; message?: string };
  const message = e?.message ?? (err instanceof Error ? err.message : String(err));
  const code = typeof e?.type === 'string' ? e.type : 'plugin_error';
  // Map common plugin error types to HTTP status codes.
  const status =
    code === 'plugin-not-found' || code === 'path-not-found'
      ? 404
      : code === 'marketplace-blocked-by-policy' || code === 'managed-plugin-locked'
        ? 403
        : 500;
  return { status, body: { error: { code, message } } };
}

export async function handleInstallPlugin(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId?: string,
): Promise<void> {
  try {
    const raw = (await readJsonBody(req)) as {
      pluginId?: unknown;
      fromPath?: unknown;
      scope?: unknown;
    };
    const pluginId = asString(raw.pluginId);
    const fromPath = asString(raw.fromPath);
    const scope = (asString(raw.scope) ?? 'user') as 'user' | 'system';
    if (!pluginId && !fromPath) {
      sendJson(res, 400, { error: { code: 'missing_arg', message: 'pluginId or fromPath required' } });
      return;
    }
    const manager = getPluginManager();
    const result = fromPath
      ? await manager.installFromPath(fromPath, scope)
      : await manager.installFromCatalog(pluginId!, scope);
    if (!result.ok) {
      const mapped = pluginErrorToResponse(result.error);
      sendJson(res, mapped.status, mapped.body);
      return;
    }
    const event: AuditEvent = {
      kind: 'plugin.install',
      id: result.value.id,
      ts: Date.now(),
      invokedBy: 'cli',
      ...(correlationId ? { correlationId } : {}),
    };
    await appendAuditEvent(getUserDataDir(), event);
    sendJson(res, 200, { plugin: result.value });
  } catch (err) {
    const mapped = pluginErrorToResponse(err);
    sendJson(res, mapped.status, mapped.body);
  }
}

export async function handleUninstallPlugin(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId?: string,
): Promise<void> {
  try {
    const raw = (await readJsonBody(req)) as { deleteData?: unknown };
    const manager = getPluginManager();
    const result = await manager.remove(id, asBool(raw.deleteData));
    if (!result.ok) {
      const mapped = pluginErrorToResponse(result.error);
      sendJson(res, mapped.status, mapped.body);
      return;
    }
    const event: AuditEvent = {
      kind: 'plugin.uninstall',
      id,
      ts: Date.now(),
      invokedBy: 'cli',
      ...(correlationId ? { correlationId } : {}),
      ...(asBool(raw.deleteData) ? { note: 'deleteData=true' } : {}),
    };
    await appendAuditEvent(getUserDataDir(), event);
    sendJson(res, 200, { id, removed: result.value.removed });
  } catch (err) {
    const mapped = pluginErrorToResponse(err);
    sendJson(res, mapped.status, mapped.body);
  }
}

export async function handleUpdatePlugin(
  req: IncomingMessage,
  res: ServerResponse,
  id: string,
  correlationId?: string,
): Promise<void> {
  try {
    const manager = getPluginManager();
    const detail = manager.getDetail(id);
    if (!detail.entry) {
      sendJson(res, 404, { error: { code: 'plugin-not-found', message: id } });
      return;
    }
    if (!detail.catalog) {
      sendJson(res, 400, {
        error: { code: 'not_in_catalog', message: `${id} is not in the catalog; cannot auto-update` },
      });
      return;
    }
    // `installFromCatalog` is idempotent — re-running it picks up the
    // newest cached version of the same catalog entry. The same audit
    // trail distinguishes install vs update via the `note` field.
    const result = await manager.installFromCatalog(id);
    if (!result.ok) {
      const mapped = pluginErrorToResponse(result.error);
      sendJson(res, mapped.status, mapped.body);
      return;
    }
    const event: AuditEvent = {
      kind: 'plugin.update',
      id,
      ts: Date.now(),
      invokedBy: 'cli',
      ...(correlationId ? { correlationId } : {}),
    };
    await appendAuditEvent(getUserDataDir(), event);
    sendJson(res, 200, { plugin: result.value });
  } catch (err) {
    const mapped = pluginErrorToResponse(err);
    sendJson(res, mapped.status, mapped.body);
  }
}
