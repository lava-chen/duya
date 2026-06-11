/**
 * electron/cli/handlers/config.ts
 *
 * Plan 102 — HTTP handlers for `duya config …` and the
 * `mcp add/remove/assign` write surface.
 *
 * The 14 new endpoints are thin wrappers over the existing
 * `ConfigManager` / `PairingStore` / agent-settings facade
 * (which `electron/agents/db-bridge.ts` exposes to the agent
 * process). The handlers are the desktop-side counterpart of
 * the agent-side `duya_config` tool — same DTO shape, same
 * field renames (`isActive` → `enabled` for vision), same
 * audit log rules.
 *
 * All write endpoints follow the Phase 7 contract:
 *   - `invokedBy` is read from `X-Duya-Invoked-By` and stamped
 *     onto the audit event.
 *   - `correlationId` is read from `X-Correlation-Id` for
 *     log correlation.
 *   - The unified `controlPlaneAudit` JSONL writer records
 *     `kind: 'config.<sub>.<verb>'`.
 *
 * Reads (`GET`) are not audited (Plan 99 §6.2 rule).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { getConfigManager } from '../../config/manager';
import { getPairingStore } from '../../gateway/pairing';
import { appendAuditEvent, type AuditEvent, type AuditEventKind } from '../../services/controlPlaneAudit';

// ---------------------------------------------------------------------------
// Error envelope helpers
// ---------------------------------------------------------------------------

interface ErrorBody {
  error: { code: string; message: string };
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(json),
  });
  res.end(json);
}

function sendError(
  res: ServerResponse,
  status: number,
  code: string,
  message: string,
): void {
  const body: ErrorBody = { error: { code, message } };
  sendJson(res, status, body);
}

function classify(err: unknown): { status: number; code: string; message: string } {
  if (err instanceof Error) {
    // Map common error patterns to stable HTTP codes.
    const msg = err.message;
    if (/not found|missing/i.test(msg)) {
      return { status: 404, code: 'not_found', message: msg };
    }
    if (/missing|required/i.test(msg)) {
      return { status: 400, code: 'invalid_request', message: msg };
    }
    if (/already exists/i.test(msg)) {
      return { status: 409, code: 'conflict', message: msg };
    }
    return { status: 500, code: 'internal_error', message: msg };
  }
  return { status: 500, code: 'internal_error', message: String(err) };
}

// ---------------------------------------------------------------------------
// Audit context
// ---------------------------------------------------------------------------

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

type InvokedBy = 'cli' | 'agent-tool' | `agent-tool:${string}`;

interface AuditContext {
  invokedBy: InvokedBy;
  correlationId?: string;
}

function readAuditContext(req: IncomingMessage): AuditContext {
  const invokedHeader = req.headers['x-duya-invoked-by'];
  const correlationHeader = req.headers['x-correlation-id'];
  const invokedByRaw = Array.isArray(invokedHeader) ? invokedHeader[0] : invokedHeader;
  const correlationIdRaw = Array.isArray(correlationHeader) ? correlationHeader[0] : correlationHeader;
  // Default to 'cli' for backwards compat (the original Phase 7 convention).
  const invokedBy: InvokedBy = (invokedByRaw as InvokedBy | undefined) ?? 'cli';
  return invokedBy
    ? { invokedBy, correlationId: typeof correlationIdRaw === 'string' ? correlationIdRaw : undefined }
    : { invokedBy: 'cli' };
}

async function audit(
  ctx: AuditContext,
  kind: AuditEventKind,
  id: string,
  note?: string,
): Promise<void> {
  const event: AuditEvent = {
    kind,
    id,
    ts: Date.now(),
    invokedBy: ctx.invokedBy,
    ...(ctx.correlationId ? { correlationId: ctx.correlationId } : {}),
    ...(note ? { note } : {}),
  };
  await appendAuditEvent(getUserDataDir(), event);
}

// ---------------------------------------------------------------------------
// Body reader
// ---------------------------------------------------------------------------

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf-8');
      if (text.length === 0) {
        resolve({});
        return;
      }
      try {
        const obj = JSON.parse(text) as unknown;
        if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
          resolve(obj as Record<string, unknown>);
        } else {
          reject(new Error('request body must be a JSON object'));
        }
      } catch (err) {
        reject(new Error(`malformed JSON body: ${err instanceof Error ? err.message : String(err)}`));
      }
    });
    req.on('error', reject);
  });
}

// ---------------------------------------------------------------------------
// Provider DTO mapping
// ---------------------------------------------------------------------------

interface ProviderListItem {
  id: string;
  name: string;
  providerType: string;
  isActive: boolean;
  hasKey: boolean;
  baseUrl?: string;
  model?: string;
}

interface ApiProvider {
  id: string;
  name: string;
  providerType: string;
  baseUrl?: string;
  apiKey?: string;
  isActive?: boolean;
  model?: string;
}

function toProviderListItem(p: ApiProvider): ProviderListItem {
  return {
    id: p.id,
    name: p.name,
    providerType: p.providerType,
    isActive: p.isActive === true,
    hasKey: typeof p.apiKey === 'string' && p.apiKey.length > 0,
    ...(p.baseUrl ? { baseUrl: p.baseUrl } : {}),
    ...(p.model ? { model: p.model } : {}),
  };
}

function toProviderInfoItem(p: ApiProvider): ProviderListItem & { headers: Record<string, string>; extraEnvKeys: string[] } {
  return {
    ...toProviderListItem(p),
    headers: {},
    extraEnvKeys: [],
  };
}

// ---------------------------------------------------------------------------
// GET /v1/config/providers
// ---------------------------------------------------------------------------

export function handleListConfigProviders(_req: IncomingMessage, res: ServerResponse): void {
  try {
    const cm = getConfigManager();
    const all = cm.getAllProviders();
    const providers: ProviderListItem[] = Object.values(all).map(toProviderListItem);
    sendJson(res, 200, { providers });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/config/providers/:id
// ---------------------------------------------------------------------------

export function handleGetConfigProvider(_req: IncomingMessage, res: ServerResponse, id: string): void {
  try {
    const cm = getConfigManager();
    const all = cm.getAllProviders();
    const found = all[id];
    if (!found) {
      sendError(res, 404, 'provider_not_found', `Provider '${id}' not found`);
      return;
    }
    sendJson(res, 200, { provider: toProviderInfoItem(found) });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/config/providers
// ---------------------------------------------------------------------------

export async function handleAddConfigProvider(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  const id = typeof body.id === 'string' ? body.id : '';
  const name = typeof body.name === 'string' ? body.name : '';
  const providerType = typeof body.providerType === 'string' ? body.providerType : '';
  if (!id || !name || !providerType) {
    sendError(res, 400, 'invalid_request', 'id, name, and providerType are required');
    return;
  }
  const baseUrl = typeof body.baseUrl === 'string' ? body.baseUrl : '';
  const apiKey = typeof body.apiKey === 'string' ? body.apiKey : '';
  const isActive = body.isActive === true;
  try {
    const cm = getConfigManager();
    // Cast to the ApiProvider union — the wire body uses the same
    // enum but the TS type for `providerType` is a strict literal
    // union. Validate at the wire boundary; the manager rejects
    // unknown types.
    cm.upsertProvider({ id, name, providerType, baseUrl, apiKey, isActive } as unknown as Parameters<typeof cm.upsertProvider>[0]);
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.provider.add', id, `providerType=${providerType}`);
    const stored = cm.getAllProviders()[id];
    sendJson(res, 200, { ok: true, provider: toProviderListItem(stored) });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// DELETE /v1/config/providers/:id
// ---------------------------------------------------------------------------

export async function handleRemoveConfigProvider(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  try {
    const cm = getConfigManager();
    const ok = cm.deleteProvider(id);
    if (!ok) {
      sendError(res, 404, 'provider_not_found', `Provider '${id}' not found`);
      return;
    }
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.provider.remove', id);
    sendJson(res, 200, { ok: true, removed: id });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// POST /v1/config/providers/:id/activate
// ---------------------------------------------------------------------------

/**
 * @deprecated Use `set-default` instead. The single-active concept is gone;
 * we now track a soft `defaultProviderId`. This handler delegates to
 * `setDefaultProvider` so the legacy CLI command keeps working.
 */
export async function handleActivateConfigProvider(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  try {
    const cm = getConfigManager();
    const ok = cm.activateProvider(id);
    if (!ok) {
      sendError(res, 404, 'provider_not_found', `Provider '${id}' not found`);
      return;
    }
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.provider.activate', id);
    sendJson(res, 200, { ok: true, active: id });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// PUT /v1/config/providers/:id/default
// ---------------------------------------------------------------------------

/**
 * Set the soft default provider (multi-provider model). The body is
 * `{}` to set the default to the given id, or `{ clear: true }` to
 * drop the default. Returns the resulting `defaultProviderId`.
 */
export async function handleSetDefaultConfigProvider(req: IncomingMessage, res: ServerResponse, id: string): Promise<void> {
  let body: Record<string, unknown> = {};
  try {
    if (req.headers['content-length'] && Number(req.headers['content-length']) > 0) {
      body = (await readBody(req)) as Record<string, unknown>;
    }
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  try {
    const cm = getConfigManager();
    const clear = body.clear === true;
    if (clear) {
      const ok = cm.setDefaultProvider(null);
      if (!ok) {
        sendError(res, 500, 'set_default_failed', 'Could not clear defaultProviderId');
        return;
      }
    } else {
      const ok = cm.setDefaultProvider(id);
      if (!ok) {
        sendError(res, 404, 'provider_not_found', `Provider '${id}' not found`);
        return;
      }
    }
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.provider.setDefault', id, clear ? 'clear' : 'set');
    sendJson(res, 200, { ok: true, defaultProviderId: clear ? null : id });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// GET / PATCH /v1/config/settings/agent
// ---------------------------------------------------------------------------

export function handleGetAgentSettings(_req: IncomingMessage, res: ServerResponse): void {
  try {
    const cm = getConfigManager();
    const settings = cm.getAgentSettings();
    sendJson(res, 200, { settings });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

export async function handleSetAgentSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  // Allowlist: only fields the legacy `duya_config settings_set` could set.
  const allow = ['model', 'maxTokens', 'temperature', 'topP', 'topK', 'enableThinking', 'thinkingBudget'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    sendError(
      res,
      400,
      'invalid_request',
      `At least one field required: ${allow.join(', ')}`,
    );
    return;
  }
  try {
    const cm = getConfigManager();
    const current = cm.getAgentSettings();
    const merged = { ...(current as unknown as Record<string, unknown>), ...patch };
    cm.setConfig('agentSettings', merged, 'agent');
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.settings.set', 'agent', Object.keys(patch).join(','));
    sendJson(res, 200, { ok: true, changes: patch });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// GET / PATCH /v1/config/settings/vision
// ---------------------------------------------------------------------------

interface VisionSettings {
  provider?: string;
  model?: string;
  baseUrl?: string;
  apiKey?: string;
  enabled?: boolean;
}

/** DTO returned to the CLI — adds the derived `hasKey` flag. */
interface VisionSettingsDTO extends VisionSettings {
  hasKey?: boolean;
}

export function handleGetVisionSettings(_req: IncomingMessage, res: ServerResponse): void {
  try {
    const cm = getConfigManager();
    const settings = cm.getVisionSettings() as VisionSettings;
    const dto: VisionSettingsDTO = {
      provider: settings.provider,
      model: settings.model,
      baseUrl: settings.baseUrl,
      enabled: settings.enabled,
      hasKey: typeof settings.apiKey === 'string' && settings.apiKey.length > 0,
    };
    sendJson(res, 200, { settings: dto });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

export async function handleSetVisionSettings(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  // Plan 102: `enabled` is the canonical wire name (the legacy
  // `isActive` field is mapped at the boundary in the agent tool,
  // not here — this handler is the new boundary). We still accept
  // `isActive` from the wire for forward compat with the old
  // `duya_config` callers during the migration window.
  const allow = ['provider', 'model', 'baseUrl', 'apiKey', 'enabled', 'isActive'];
  const patch: Record<string, unknown> = {};
  for (const k of allow) {
    if (body[k] !== undefined) patch[k] = body[k];
  }
  if (Object.keys(patch).length === 0) {
    sendError(
      res,
      400,
      'invalid_request',
      `At least one field required: ${allow.filter((k) => k !== 'isActive').join(', ')}`,
    );
    return;
  }
  if (patch.isActive !== undefined) {
    patch.enabled = patch.isActive === true;
    delete patch.isActive;
  }
  try {
    const cm = getConfigManager();
    const current = cm.getVisionSettings() as VisionSettings;
    const merged = { ...current, ...patch };
    cm.setConfig('visionSettings', merged, 'agent');
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.vision.set', 'vision', Object.keys(patch).join(','));
    sendJson(res, 200, { ok: true, changes: patch });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// GET / POST /v1/config/output-styles
// ---------------------------------------------------------------------------

interface OutputStyle {
  id?: string;
  name?: string;
  description?: string;
}

export function handleListOutputStyles(_req: IncomingMessage, res: ServerResponse): void {
  try {
    const cm = getConfigManager();
    const styles = cm.getOutputStyles();
    const list = Object.entries(styles).map(([id, s]) => {
      const item: OutputStyle = { id, name: s.name ?? id };
      if (s.description) item.description = s.description;
      return item;
    });
    sendJson(res, 200, { styles: list });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

export async function handleSetOutputStyle(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  const styleId = typeof body.styleId === 'string' ? body.styleId : '';
  if (!styleId) {
    sendError(res, 400, 'invalid_request', 'styleId is required');
    return;
  }
  try {
    const cm = getConfigManager();
    const styles = cm.getOutputStyles();
    if (!styles[styleId]) {
      sendError(res, 404, 'output_style_not_found', `Output style not found: ${styleId}`);
      return;
    }
    // Mark the style as active. The activeStyleId is stored on
    // the agent settings (legacy `duya_config style_set` did the
    // same thing via `outputStylesSet({ styleId })`).
    const current = cm.getAgentSettings() as unknown as Record<string, unknown>;
    const merged = { ...current, activeStyleId: styleId };
    cm.setConfig('agentSettings', merged, 'agent');
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.style.set', styleId);
    sendJson(res, 200, { ok: true, styleId });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ---------------------------------------------------------------------------
// GET /v1/config/pairing
// POST /v1/config/pairing/approve
// POST /v1/config/pairing/revoke
// GET /v1/config/pairing/check
// ---------------------------------------------------------------------------

interface PairingEntry {
  platform: string;
  code?: string;
  platformUserId?: string;
  approvedAt?: number;
  expiresAt?: number;
}

export function handleListPairing(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  const qIdx = url.indexOf('?');
  let include: string | undefined;
  if (qIdx >= 0) {
    for (const part of url.slice(qIdx + 1).split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq);
      const v = decodeURIComponent(part.slice(eq + 1));
      if (k === 'include') include = v;
    }
  }
  try {
    const store = getPairingStore();
    const pending = store.listAllPending() as PairingEntry[];
    const approved = store.listApproved() as PairingEntry[];
    const out: { pending: PairingEntry[]; approved: PairingEntry[] } = { pending: [], approved: [] };
    if (include === 'approved') out.approved = approved;
    else if (include === 'pending') out.pending = pending;
    else {
      out.pending = pending;
      out.approved = approved;
    }
    sendJson(res, 200, out);
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

export async function handleApprovePairing(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  const platform = typeof body.platform === 'string' ? body.platform : '';
  const code = typeof body.code === 'string' ? body.code : '';
  if (!platform || !code) {
    sendError(res, 400, 'invalid_request', 'platform and code are required');
    return;
  }
  try {
    const store = getPairingStore();
    const result = store.approve(platform, code);
    if (!result.approved) {
      sendError(res, 404, 'pairing_not_found', result.error ?? 'Pairing code not found or expired');
      return;
    }
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.pairing.approve', `${platform}:${code}`);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

export async function handleRevokePairing(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  const platform = typeof body.platform === 'string' ? body.platform : '';
  const platformUserId = typeof body.platformUserId === 'string' ? body.platformUserId : '';
  if (!platform || !platformUserId) {
    sendError(res, 400, 'invalid_request', 'platform and platformUserId are required');
    return;
  }
  try {
    const store = getPairingStore();
    const revoked = store.revoke(platform, platformUserId);
    if (!revoked) {
      sendError(res, 404, 'pairing_not_found', `No approved pairing for ${platform}:${platformUserId}`);
      return;
    }
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.pairing.revoke', `${platform}:${platformUserId}`);
    sendJson(res, 200, { ok: true });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

export function handleCheckPairing(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '';
  const qIdx = url.indexOf('?');
  const params = new Map<string, string>();
  if (qIdx >= 0) {
    for (const part of url.slice(qIdx + 1).split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      params.set(part.slice(0, eq), decodeURIComponent(part.slice(eq + 1)));
    }
  }
  const platform = params.get('platform') ?? '';
  const user = params.get('user') ?? '';
  if (!platform || !user) {
    sendError(res, 400, 'invalid_request', 'platform and user query params are required');
    return;
  }
  try {
    const store = getPairingStore();
    const approved = store.isApproved(platform, user);
    sendJson(res, 200, { approved });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

// ============================================================================
// Phase 4.2: generic KV set / get / unset / validate (Plan 200 P4)
// ============================================================================

type GenericConfigKey =
  | 'agentSettings'
  | 'uiPreferences'
  | 'visionSettings'
  | 'outputStyles'
  | 'apiProviders';

const ALLOWED_GENERIC_KEYS: readonly GenericConfigKey[] = [
  'agentSettings',
  'uiPreferences',
  'visionSettings',
  'outputStyles',
  'apiProviders',
];

function isGenericKey(v: unknown): v is GenericConfigKey {
  return typeof v === 'string' && (ALLOWED_GENERIC_KEYS as readonly string[]).includes(v);
}

function deepClone<T>(v: T): T {
  if (typeof structuredClone === 'function') return structuredClone(v);
  return JSON.parse(JSON.stringify(v)) as T;
}

/**
 * POST /v1/config/kv/set
 * body: { key, value } — merges `value` into the top-level key.
 * Records an audit event of kind `config.kv.set`.
 */
export async function handleConfigKvSet(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  if (!isGenericKey(body.key)) {
    sendError(res, 400, 'invalid_key', `key must be one of: ${ALLOWED_GENERIC_KEYS.join(', ')}`);
    return;
  }
  if (typeof body.value !== 'object' || body.value === null || Array.isArray(body.value)) {
    sendError(res, 400, 'invalid_value', 'value must be a JSON object');
    return;
  }
  try {
    const cm = getConfigManager();
    const current = cm.getConfig();
    const merged = {
      ...(current[body.key] as Record<string, unknown>),
      ...(body.value as Record<string, unknown>),
    };
    const ok = cm.setConfig(body.key, merged, 'agent');
    if (!ok) {
      sendError(res, 400, 'validation_failed', 'config validation failed for the merged value');
      return;
    }
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.kv.set', body.key, Object.keys(body.value as object).join(','));
    sendJson(res, 200, { ok: true, key: body.key, value: merged });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

/**
 * GET /v1/config/kv/get?key=...
 * Returns the value at the top-level key (the whole record).
 */
export function handleConfigKvGet(req: IncomingMessage, res: ServerResponse): void {
  const url = req.url ?? '/';
  const qIdx = url.indexOf('?');
  let key: string | undefined;
  if (qIdx >= 0) {
    for (const part of url.slice(qIdx + 1).split('&')) {
      const eq = part.indexOf('=');
      if (eq < 0) continue;
      const k = part.slice(0, eq);
      const v = part.slice(eq + 1);
      if (k === 'key') key = decodeURIComponent(v);
    }
  }
  if (!isGenericKey(key)) {
    sendError(res, 400, 'invalid_key', `key must be one of: ${ALLOWED_GENERIC_KEYS.join(', ')}`);
    return;
  }
  try {
    const cm = getConfigManager();
    const value = (cm.getConfig() as Record<string, unknown>)[key];
    sendJson(res, 200, { key, value });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

/**
 * POST /v1/config/kv/unset
 * body: { key, path? } — drops the key (or the path under it) back
 * to its default. Without `path` this is destructive: it restores
 * the entire key to the empty default. The CLI gates this behind
 * --yes (Phase 7).
 */
export async function handleConfigKvUnset(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  if (!isGenericKey(body.key)) {
    sendError(res, 400, 'invalid_key', `key must be one of: ${ALLOWED_GENERIC_KEYS.join(', ')}`);
    return;
  }
  const pathRaw = body.path;
  const path =
    typeof pathRaw === 'string' && pathRaw.length > 0
      ? pathRaw.split('.').filter((s) => s.length > 0)
      : [];
  try {
    const cm = getConfigManager();
    const cfg = cm.getConfig();
    const current = deepClone(cfg[body.key] as Record<string, unknown>);
    if (path.length === 0) {
      const defaults: Record<GenericConfigKey, unknown> = {
        agentSettings: {},
        uiPreferences: {},
        visionSettings: { provider: '', model: '', baseUrl: '', apiKey: '', enabled: false },
        outputStyles: {},
        apiProviders: {},
      };
      const ok = cm.setConfig(body.key, defaults[body.key], 'agent');
      if (!ok) {
        sendError(res, 400, 'validation_failed', 'config validation failed for the default value');
        return;
      }
      const ctx = readAuditContext(req);
      await audit(ctx, 'config.kv.unset', body.key, 'whole-key');
      sendJson(res, 200, { ok: true, key: body.key, value: defaults[body.key] });
      return;
    }
    let cursor: Record<string, unknown> = current;
    for (let i = 0; i < path.length - 1; i++) {
      const seg = path[i];
      const next = cursor[seg];
      if (typeof next !== 'object' || next === null) {
        sendError(res, 404, 'path_not_found', `path not found: ${path.join('.')}`);
        return;
      }
      cursor = next as Record<string, unknown>;
    }
    const last = path[path.length - 1];
    if (!(last in cursor)) {
      sendError(res, 404, 'path_not_found', `path not found: ${path.join('.')}`);
      return;
    }
    delete cursor[last];
    const ok = cm.setConfig(body.key, current, 'agent');
    if (!ok) {
      sendError(res, 400, 'validation_failed', 'config validation failed after unset');
      return;
    }
    const ctx = readAuditContext(req);
    await audit(ctx, 'config.kv.unset', body.key, path.join('.'));
    sendJson(res, 200, { ok: true, key: body.key, path: path.join('.'), value: current });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}

/**
 * POST /v1/config/validate
 * body: { key, value } — runs the same validator the manager uses
 * for `setConfig`, but does NOT write. Returns { valid, error? }.
 *
 * Note: the manager's setConfig writes when valid, so we restore the
 * prior value after the validation probe. This keeps the call
 * effectively read-only from the caller's perspective.
 */
export async function handleConfigValidate(
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  let body: Record<string, unknown>;
  try {
    body = await readBody(req);
  } catch (err) {
    sendError(res, 400, 'invalid_request', err instanceof Error ? err.message : String(err));
    return;
  }
  if (!isGenericKey(body.key)) {
    sendError(res, 400, 'invalid_key', `key must be one of: ${ALLOWED_GENERIC_KEYS.join(', ')}`);
    return;
  }
  try {
    const cm = getConfigManager();
    const cfg = cm.getConfig();
    const before = deepClone((cfg as Record<string, unknown>)[body.key]);
    const merged =
      typeof body.value === 'object' && body.value !== null && !Array.isArray(body.value)
        ? { ...(before as Record<string, unknown>), ...(body.value as Record<string, unknown>) }
        : body.value;
    const ok = cm.setConfig(body.key, merged, 'agent');
    // Restore the original value so validate is effectively read-only.
    cm.setConfig(body.key, before, 'agent');
    sendJson(res, 200, {
      valid: ok,
      ...(ok ? {} : { error: 'validation failed; check field types and required keys' }),
    });
  } catch (err) {
    const c = classify(err);
    sendError(res, c.status, c.code, c.message);
  }
}
