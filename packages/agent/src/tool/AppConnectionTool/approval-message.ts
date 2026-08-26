/**
 * Connector approval message templates (Plan 449 + Plan 450 Phase D).
 *
 * Codex parity: versioned template table
 *   (`core/src/consequential_tool_message_templates.json` schema_version 4)
 * renders human-readable approval questions per connector instead of a
 * bare tool name. Duya's remote connectors are third-party hosted MCP
 * servers, so the table keys on `provider` (curated intro line). An
 * unknown provider falls back to a generic renderer built from
 * descriptor metadata (title / description).
 *
 * Plan 450 Phase D adds the `toolParamsDisplay` field: a structured
 * label:value listing of the top scalar arguments so the permission
 * card can render a tidy summary instead of raw JSON.
 *
 * Storage: `approval-templates.json` is the curated asset (can be
 * edited independently of the build). If the asset is missing or
 * malformed the module falls back to an embedded default table so
 * approval flows never break because of a templating bug.
 */

import type { AppConnectionToolDescriptor } from './index.js';

export const APPROVAL_TEMPLATE_SCHEMA_VERSION = 1;

interface ProviderTemplate {
  label: string;
  scope: string;
  verb_read: string;
  verb_write: string;
  verb_default: string;
}

interface TemplatesAsset {
  schema_version: number;
  providers: Record<string, ProviderTemplate>;
}

const FALLBACK_TEMPLATES: TemplatesAsset = {
  schema_version: APPROVAL_TEMPLATE_SCHEMA_VERSION,
  providers: {
    github: { label: 'GitHub', scope: 'your GitHub repositories', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    notion: { label: 'Notion', scope: 'your Notion workspace', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    linear: { label: 'Linear', scope: 'your Linear workspace', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    figma: { label: 'Figma', scope: 'your Figma files', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    supabase: { label: 'Supabase', scope: 'your Supabase projects', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    sentry: { label: 'Sentry', scope: 'your Sentry projects', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    vercel: { label: 'Vercel', scope: 'your Vercel projects', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    google: { label: 'Google Drive', scope: 'your Google Drive', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    slack: { label: 'Slack', scope: 'your Slack workspace', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    microsoft365: { label: 'Microsoft 365', scope: 'your Microsoft 365 account', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
    wecom: { label: 'WeCom', scope: 'your WeCom organization', verb_read: 'read from', verb_write: 'make changes in', verb_default: 'access' },
  },
};

function loadTemplates(): TemplatesAsset {
  try {
    // Synchronous import of a sibling JSON asset. Bundlers (tsc + esbuild)
    // both expose the parsed object via `import` for `.json` files.
    // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires
    const asset = require('./approval-templates.json') as TemplatesAsset;
    if (
      asset &&
      typeof asset === 'object' &&
      asset.schema_version === APPROVAL_TEMPLATE_SCHEMA_VERSION &&
      asset.providers &&
      typeof asset.providers === 'object'
    ) {
      return asset;
    }
  } catch {
    // Missing or unreadable asset → fall back to embedded defaults.
  }
  return FALLBACK_TEMPLATES;
}

const TEMPLATES = loadTemplates();

/** Pick the verb phrase for a given risk tier (mirrors codex's templates). */
function pickVerb(template: ProviderTemplate, riskTier: string | undefined): string {
  if (riskTier === 'read') return template.verb_read;
  if (riskTier === 'write' || riskTier === 'modify') return template.verb_write;
  return template.verb_default;
}

/** Summarize the primary input argument for the approval question. */
function summarizeInput(input: Record<string, unknown> | undefined): string {
  if (!input) return '';
  const firstString = Object.values(input).find((v) => typeof v === 'string' && v.trim());
  if (!firstString) return '';
  const value = String(firstString).trim();
  return value.length > 80 ? `${value.slice(0, 77)}…` : value;
}

export interface RenderedApproval {
  /** Version of the template schema that produced this rendering. */
  schemaVersion: number;
  /** Full approval message shown in the permission card. */
  message: string;
  /**
   * Plan 450 Phase D: structured parameter display. The first three
   * scalar-shaped arguments, each truncated to 120 chars, with labels
   * drawn from the inputSchema's `properties.<key>.title` when
   * available and a humanized key otherwise.
   */
  toolParamsDisplay: Array<{ name: string; label: string; value: string }>;
}

const PARAM_LABEL_LIMIT = 120;
const PARAM_MAX_COUNT = 3;

function camelToLabel(key: string): string {
  return key
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/^./, (c) => c.toUpperCase());
}

function truncate(value: string): string {
  return value.length > PARAM_LABEL_LIMIT ? `${value.slice(0, PARAM_LABEL_LIMIT - 1)}…` : value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Build a structured parameter display for the approval card.
 * Returns an empty array when the tool was invoked with no arguments.
 */
export function buildToolParamsDisplay(
  input: Record<string, unknown> | undefined,
  schema: { properties?: Record<string, unknown> } | undefined,
): Array<{ name: string; label: string; value: string }> {
  if (!input) return [];
  const props = schema?.properties;
  const out: Array<{ name: string; label: string; value: string }> = [];
  for (const [name, value] of Object.entries(input)) {
    if (out.length >= PARAM_MAX_COUNT) break;
    if (value === undefined) continue;
    let displayValue: string;
    if (value === null) {
      displayValue = 'null';
    } else if (typeof value === 'string') {
      displayValue = truncate(value);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      displayValue = String(value);
    } else if (Array.isArray(value)) {
      displayValue = `${value.length} item${value.length === 1 ? '' : 's'}`;
    } else if (isPlainObject(value)) {
      try {
        displayValue = truncate(JSON.stringify(value));
      } catch {
        displayValue = '[object]';
      }
    } else {
      displayValue = String(value);
    }
    const propMeta = isPlainObject(props?.[name]) ? (props![name] as Record<string, unknown>) : undefined;
    const label = typeof propMeta?.title === 'string' ? propMeta.title : camelToLabel(name);
    out.push({ name, label, value: displayValue });
  }
  return out;
}

interface RenderApprovalInput {
  toolName: string;
  connector?: { provider: string; riskTier: string };
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
  inputSchema?: { properties?: Record<string, unknown> };
}

export function renderConnectorApprovalMessage(params: RenderApprovalInput): RenderedApproval {
  const { toolName, connector, input } = params;
  const template = connector ? TEMPLATES.providers[connector.provider] : undefined;
  const displayName = params.title || toolName;
  const argSummary = summarizeInput(input);
  const argSuffix = argSummary ? ` (“${argSummary}”)` : '';

  let message: string;
  if (template) {
    const verb = pickVerb(template, connector?.riskTier);
    message = `Allow ${template.label} (${displayName}) to ${verb} ${template.scope}${argSuffix}?`;
  } else {
    const source = params.description ? `\n\n${params.description}` : '';
    message = `Allow the connected app to run ${displayName}${argSuffix}?${source}`;
  }

  return {
    schemaVersion: APPROVAL_TEMPLATE_SCHEMA_VERSION,
    message,
    toolParamsDisplay: buildToolParamsDisplay(input, params.inputSchema),
  };
}

export function renderConnectorApprovalFromDescriptor(
  descriptor: AppConnectionToolDescriptor,
  input: Record<string, unknown> | undefined,
): RenderedApproval {
  return renderConnectorApprovalMessage({
    toolName: descriptor.name,
    connector: { provider: descriptor.provider, riskTier: descriptor.riskTier },
    ...(descriptor.title ? { title: descriptor.title } : {}),
    description: descriptor.description,
    input,
    inputSchema: descriptor.inputSchema,
  });
}