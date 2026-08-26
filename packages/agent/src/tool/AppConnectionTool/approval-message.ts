/**
 * Connector approval message templates (Plan 449 Phase C).
 *
 * Codex parity: versioned template table (`core/src/mcp_tool_approval_templates.rs`)
 * renders human-readable approval questions per connector instead of a bare
 * tool name. Duya's remote connectors are third-party hosted MCP servers, so
 * the table keys on `provider` (curated intro line) and falls back to a
 * generic renderer built from descriptor metadata (title / description).
 *
 * The schema version guards against stale cached renderings if the table
 * format ever changes.
 */

import type { AppConnectionToolDescriptor } from './index.js';

export const APPROVAL_TEMPLATE_SCHEMA_VERSION = 1;

interface ProviderTemplate {
  /** Curated provider display name used in rendered questions. */
  label: string;
  /** Intro clause, e.g. "the user's Notion workspace". */
  scope: string;
}

/**
 * Provider-keyed static table. Unknown providers fall back to the generic
 * renderer — never fail because a template is missing.
 */
const PROVIDER_TEMPLATES: Record<string, ProviderTemplate> = {
  github: { label: 'GitHub', scope: 'your GitHub repositories' },
  notion: { label: 'Notion', scope: 'your Notion workspace' },
  linear: { label: 'Linear', scope: 'your Linear workspace' },
  figma: { label: 'Figma', scope: 'your Figma files' },
  supabase: { label: 'Supabase', scope: 'your Supabase projects' },
  sentry: { label: 'Sentry', scope: 'your Sentry projects' },
  vercel: { label: 'Vercel', scope: 'your Vercel projects' },
  google: { label: 'Google Drive', scope: 'your Google Drive' },
  slack: { label: 'Slack', scope: 'your Slack workspace' },
  microsoft365: { label: 'Microsoft 365', scope: 'your Microsoft 365 account' },
  wecom: { label: 'WeCom', scope: 'your WeCom organization' },
};

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
}

interface RenderApprovalInput {
  toolName: string;
  connector?: { provider: string; riskTier: string };
  title?: string;
  description?: string;
  input?: Record<string, unknown>;
}

/**
 * Render an approval message for an app-connection tool. Template hit uses
 * the curated provider wording; anything unknown falls back to a generic
 * but still human-readable question. Never throws.
 */
export function renderConnectorApprovalMessage(params: RenderApprovalInput): RenderedApproval {
  const { toolName, connector, input } = params;
  const template = connector ? PROVIDER_TEMPLATES[connector.provider] : undefined;
  const displayName = params.title || toolName;
  const argSummary = summarizeInput(input);
  const argSuffix = argSummary ? ` (“${argSummary}”)` : '';

  let message: string;
  if (template) {
    const verb =
      connector?.riskTier === 'read'
        ? 'read from'
        : connector?.riskTier === 'write' || connector?.riskTier === 'modify'
          ? 'make changes in'
          : 'access';
    message = `Allow ${template.label} (${displayName}) to ${verb} ${template.scope}${argSuffix}?`;
  } else {
    const source = params.description ? `\n\n${params.description}` : '';
    message = `Allow the connected app to run ${displayName}${argSuffix}?${source}`;
  }

  return { schemaVersion: APPROVAL_TEMPLATE_SCHEMA_VERSION, message };
}

/**
 * Convenience overload used by the permission gate: build render params from
 * a cached descriptor plus the raw tool input.
 */
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
  });
}
