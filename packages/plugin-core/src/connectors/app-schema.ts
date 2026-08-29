/**
 * `.app.json` declaration schema — Plan 455 Phase B (D3).
 *
 * One file per plugin root declares the plugin's app-connector surface.
 * Reference and definition entries share one schema (455 D3):
 *   - reference subset: `{ id, category? }` (Plan 452) — depends on an
 *     existing connector without defining it;
 *   - definition subset: `interface` / `oauth` / `tools[]` (Plan 455) —
 *     declares a NEW connector. `tools[].invoke` REST templates are
 *     executed by Plan 460's generic invoker (`rest` binding).
 *
 * Codex parity: `codex-rs/connectors/src/plugin_config.rs` `PluginAppFile`
 * (`{ apps: { <name>: { id, category } } }`); duya uses an array with an
 * explicit `id` so partially-invalid entries can be dropped with a
 * warning instead of losing the whole file.
 *
 * Security invariants (455 D5):
 *   - the `oauth` section carries PUBLIC client data only — a declared
 *     secret field would be a vulnerability, so none exists in the schema;
 *   - every URL must be https, or empty (RFC 9728 discovery flows where
 *     the MCP SDK locates the authorization server itself).
 */

import { z } from 'zod';
import { isWellFormedConnectorId } from './app-connector-id.js';

/** https URL, or empty string for discovery-driven flows. */
const httpsUrl = z
  .string()
  .max(2048)
  .refine((v) => v === '' || /^https:\/\//i.test(v), {
    message: 'must be an https URL (or empty for discovery-driven flows)',
  });

/** https URL that must be present. */
const requiredHttpsUrl = z
  .string()
  .min(1)
  .max(2048)
  .refine((v) => /^https:\/\//i.test(v), { message: 'must be an https URL' });

export const OAuthClientDeclarationSchema = z
  .object({
    /** Authorization endpoint (browser consent). Empty for RFC 9728 flows. */
    authUrl: httpsUrl.default(''),
    /** Token endpoint (code exchange + refresh). Empty for RFC 9728 flows. */
    tokenUrl: httpsUrl.default(''),
    revokeUrl: httpsUrl.optional(),
    /** Loopback redirect path; the full URL is registered in the console. */
    redirectPath: z
      .string()
      .max(256)
      .regex(/^\/[A-Za-z0-9/_-]*$/, 'must be an absolute path')
      .optional(),
    defaultScopes: z.array(z.string().min(1).max(256)).max(32).default([]),
    userinfoUrl: httpsUrl.optional(),
    /** Official hosted MCP endpoint (RFC 9728 discovery + OAuth DCR). */
    remoteMcpUrl: requiredHttpsUrl.optional(),
    /** False → manual-credential connector; no OAuth client needed. */
    requiresOAuthClient: z.boolean().optional(),
    requiresClientSecret: z.boolean().default(false),
    supportsManualConfiguration: z.boolean().default(false),
    /**
     * Public client_id only (PKCE public client). Secrets are NEVER
     * declared here — they arrive via env var or user setup (Plan 312).
     */
    clientId: z.string().max(512).optional(),
  })
  .strict();

export const RestInvokeDeclarationSchema = z.object({
  method: z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']),
  url: requiredHttpsUrl,
  /** Values are Plan 460 template strings (`${args.x}` / `${accessToken}`). */
  headers: z.record(z.string().max(128), z.string().max(4096)).optional(),
  query: z.record(z.string().max(128), z.string().max(4096)).optional(),
  body: z.union([z.record(z.string().max(128), z.string().max(65536)), z.string().max(65536)]).optional(),
  response: z
    .object({
      /** Path whose truthiness marks success (e.g. Slack `body.ok`). */
      ok: z.string().max(256).optional(),
      /** Path projecting the result data; default = whole body. */
      dataPath: z.string().max(256).optional(),
      errorPath: z.string().max(256).optional(),
      errorTemplate: z.string().max(500).optional(),
      retryableStatus: z.array(z.number().int().min(100).max(599)).default([502, 503, 504]),
    })
    .optional(),
});

export const AppToolDeclarationSchema = z.object({
  name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[a-z][a-z0-9_]*$/, 'must be lowercase snake_case'),
  description: z.string().min(1).max(500),
  title: z.string().min(1).max(120).optional(),
  inputSchema: z.object({
    type: z.literal('object'),
    properties: z.record(z.string().max(128), z.unknown()),
    required: z.array(z.string().max(128)).optional(),
  }),
  inputSchemaSummary: z.string().min(1).max(2000),
  riskTier: z.enum(['read', 'draft', 'write', 'modify', 'destructive']),
  /** Stable dispatch key; defaults to the tool name. */
  action: z.string().min(1).max(128).optional(),
  /** REST template — the `rest` binding (Plan 460). */
  invoke: RestInvokeDeclarationSchema.optional(),
});

export const AppDeclarationSchema = z.object({
  /** Connector id; third-party definitions get namespaced at registration. */
  id: z
    .string()
    .min(1)
    .max(190)
    .refine(isWellFormedConnectorId, {
      message: 'must match ^[a-z][a-z0-9_-]*$',
    }),
  /** Display name (codex `AppDeclaration.name`). */
  name: z.string().min(1).max(120).optional(),
  category: z.string().min(1).max(64).optional(),
  interface: z
    .object({
      label: z.string().min(1).max(64),
      monogram: z.string().min(1).max(2).optional(),
      description: z.string().min(1).max(500).optional(),
    })
    .strict()
    .optional(),
  oauth: OAuthClientDeclarationSchema.optional(),
  tools: z.array(AppToolDeclarationSchema).max(64).default([]),
});

export const AppDeclarationFileSchema = z.object({
  apps: z.array(AppDeclarationSchema).max(64).default([]),
});

export type OAuthClientDeclaration = z.infer<typeof OAuthClientDeclarationSchema>;
export type RestInvokeDeclaration = z.infer<typeof RestInvokeDeclarationSchema>;
export type AppToolDeclaration = z.infer<typeof AppToolDeclarationSchema>;
export type AppDeclaration = z.infer<typeof AppDeclarationSchema>;

export type ParsedAppDeclarations =
  | { ok: true; apps: AppDeclaration[]; warnings: string[] }
  | { ok: false; reason: string };

/**
 * Lenient parse of a plugin's `.app.json`. Never throws; malformed
 * entries degrade to a structured failure with the first offending
 * path so plugin authors can fix their declaration.
 */
export function parseAppDeclarationFile(contents: string): ParsedAppDeclarations {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch (err) {
    return {
      ok: false,
      reason: `.app.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  const result = AppDeclarationFileSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const path = issue?.path.length ? `${issue.path.join('.')}: ` : '';
    return { ok: false, reason: `.app.json rejected — ${path}${issue?.message ?? 'invalid declaration'}` };
  }
  return { ok: true, apps: result.data.apps, warnings: [] };
}
