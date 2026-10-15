/**
 * PlanTool — unified plan management tool with multiple actions.
 *
 * Single tool that handles three operations:
 * - plan_status:  list a project's active or all plans
 * - plan_search:  keyword search across projects
 * - plan_complete: archive an active plan (move to completed/)
 *
 * Returns markdown-formatted results for human readability.
 */

import { randomUUID } from 'node:crypto';
import { BaseTool } from '../BaseTool.js';
import type { ToolExecutor, ToolResult, ToolUseContext } from '../contracts/tool.js';
import type {
  PlanCompleteResult,
  PlanSearchResult,
  PlanStatusResult,
  PlanStoragePort,
} from './ports.js';

export const PLAN_TOOL_NAME = 'plan';

type PlanAction = 'status' | 'search' | 'complete';

function toResult(name: string, markdown: string, error?: boolean): ToolResult {
  return {
    id: randomUUID(),
    name,
    result: markdown,
    ...(error ? { error: true } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters — each returns a markdown string
// ─────────────────────────────────────────────────────────────────────────────

function formatStatus(result: PlanStatusResult, filter: 'active' | 'all', port: PlanStoragePort): string {
  const { projectId, plans, idHealth } = result;
  const label = filter === 'active' ? 'Active' : 'All';
  const lines: string[] = [];

  lines.push(`## Plans — ${projectId}  \n${plans.length} ${label.toLowerCase()} plan${plans.length !== 1 ? 's' : ''}`);

  if (plans.length === 0) {
    lines.push('\n_No plans found._');
    return lines.join('\n');
  }

  // Table header
  lines.push('');
  lines.push('| ID | Title | Status | Priority | Tags |');
  lines.push('|---|---|---|---|---|');

  for (const plan of plans) {
    const id = plan.id !== null ? String(plan.id) : '—';
    const title = escapeMd(plan.title);
    const status = plan.status === 'done' ? 'completed' : plan.status;
    const priority = plan.priority ? escapeMd(plan.priority) : '—';
    const tags = plan.tags && plan.tags.length > 0 ? plan.tags.map(escapeMd).join(', ') : '—';
    lines.push(`| ${id} | ${title} | ${status} | ${priority} | ${tags} |`);
  }

  // ID health warning
  if (idHealth?.hasIssues) {
    lines.push('');
    lines.push('> ⚠️ ' + idHealth.warning);
  }

  lines.push('');
  lines.push(`> Plans directory: \`${port.getPlansDirectory(result.projectId)}\``);
  return lines.join('\n');
}

function formatSearch(result: PlanSearchResult, query: string, port: PlanStoragePort): string {
  const { results } = result;
  const lines: string[] = [];

  lines.push(`## Search — "${escapeMd(query)}"  \n${results.length} result${results.length !== 1 ? 's' : ''}`);

  if (results.length === 0) {
    lines.push('\n_No matching plans found._');
    return lines.join('\n');
  }

  lines.push('');
  lines.push('| Project | ID | Title | Status | File |');
  lines.push('|---|---|---|---|---|');

  for (const r of results) {
    const projectId = escapeMd(r.projectId);
    const id = r.id !== null ? String(r.id) : '—';
    const title = escapeMd(r.title);
    const status = r.status === 'done' ? 'completed' : r.status;
    const file = escapeMd(r.file);
    lines.push(`| ${projectId} | ${id} | ${title} | ${status} | ${file} |`);
  }

  lines.push('');
  lines.push(`_Showing up to 50 results. Refine your query to narrow results._`);

  lines.push('');
  const projectIds = [...new Set(results.map((r) => r.projectId))];
  lines.push(`> Plans directories:\n${projectIds.map((p) => `>   \`${port.getPlansDirectory(p)}\``).join('\n')}`);
  return lines.join('\n');
}

function formatComplete(result: PlanCompleteResult, projectId: string, planId: number, port: PlanStoragePort): string {
  const lines: string[] = [];
  lines.push(`## Plan Archived ✓`);
  lines.push('');
  lines.push(`Plan **#${planId}** in project **${escapeMd(projectId)}** has been moved to \`completed/\`.`);
  lines.push('');
  lines.push(`> New location: \`${escapeMd(result.newFile)}\``);
  lines.push('');
  lines.push(`Use \`plan({ action: 'status', projectId: '${projectId}', status: 'all' })\` to verify.`);
  lines.push('');
  lines.push(`> Plans directory: \`${port.getPlansDirectory(projectId)}\``);
  return lines.join('\n');
}

function escapeMd(text: string): string {
  return text.replace(/([|\\`])/g, '\\$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

export interface PlanToolContext extends ToolUseContext {
  currentProjectId?: string | null;
}

export class PlanTool extends BaseTool implements ToolExecutor {
  constructor(private readonly port: PlanStoragePort) {
    super();
  }

  readonly name = PLAN_TOOL_NAME;
  readonly description = `Query and manage duya execution plans stored under ~/.duya/projects/<projectId>/plans/.

Three actions:
- status:  list a project's plans. Pass projectId + optional status ('active'|'all', default 'active').
- search:  keyword search across projects. Pass query + optional scope ('all'|'project') and projectId.
- complete: archive a finished plan. Pass projectId + planId. All checkboxes must be checked first.`;

  readonly input_schema = {
    type: 'object' as const,
    properties: {
      action: {
        type: 'string' as const,
        enum: ['status', 'search', 'complete'] as const,
        description: "The plan operation to perform: 'status' (list plans), 'search' (keyword search), or 'complete' (archive a plan).",
      },
      // ── status ──────────────────────────────────────────────────────────────
      projectId: {
        type: 'string' as const,
        description: 'Project ID (e.g. e4e2b217). Optional for status/complete/search — falls back to the current project bound to this session (see ToolUseContext.currentProjectId). Pass an explicit ID only to operate on a non-current project.',
      },
      status: {
        type: 'string' as const,
        enum: ['active', 'all'] as const,
        description: "status action only: 'active' (default) shows active plans, 'all' shows active+completed.",
        default: 'active',
      },
      // ── search ──────────────────────────────────────────────────────────────
      query: {
        type: 'string' as const,
        description: "search action only: keyword to match against title, slug, ID, and tags.",
      },
      scope: {
        type: 'string' as const,
        enum: ['all', 'project'] as const,
        description: "search action only: 'all' (default) searches all projects, 'project' limits to projectId.",
        default: 'all',
      },
      // ── complete ────────────────────────────────────────────────────────────
      planId: {
        type: 'number' as const,
        description: 'complete action only: integer plan ID from the plan file frontmatter.',
      },
    },
    required: ['action'],
    allOf: [
      {
        if: { properties: { action: { const: 'status' } } },
        then: {},
      },
      {
        if: { properties: { action: { const: 'search' } } },
        then: { required: ['query'] },
      },
      {
        if: { properties: { action: { const: 'complete' } } },
        then: { required: ['planId'] },
      },
    ],
  };

  toTool() {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, _wd?: string, context?: PlanToolContext): Promise<ToolResult> {
    const { action, projectId, status, query, scope, planId } = input as {
      action: PlanAction;
      projectId?: string;
      status?: 'active' | 'all';
      query?: string;
      scope?: 'all' | 'project';
      planId?: number;
    };

    // Plan 536: projectId is optional in the schema; fall back to the project
    // bound to this session when the model omits it. Only "status" and
    // "complete" require a project; "search" works without one (defaults to
    // scope='all').
    const resolvedProjectId =
      projectId ??
      (action === 'status' || action === 'complete' ? context?.currentProjectId : undefined) ??
      undefined;

    if ((action === 'status' || action === 'complete') && !resolvedProjectId) {
      return toResult(
        this.name,
        '**Error**: `projectId` required for `' +
          action +
          '` action. ' +
          'Either pass `projectId` explicitly, or ensure the session is bound to a known project ' +
          '(ToolUseContext.currentProjectId is null when no project owns the session workingDirectory).',
        true,
      );
    }

    try {
      switch (action) {
        case 'status': {
          const result = await this.port.planStatus({ projectId: resolvedProjectId!, status });
          return toResult(this.name, formatStatus(result, status ?? 'active', this.port));
        }
        case 'search': {
          const result = await this.port.planSearch({ query: query!, scope: scope as 'all' | 'project', projectId });
          return toResult(this.name, formatSearch(result, query!, this.port));
        }
        case 'complete': {
          const result = await this.port.planComplete({ projectId: resolvedProjectId!, planId: planId! });
          return toResult(this.name, formatComplete(result, resolvedProjectId!, planId!, this.port));
        }
        default:
          return toResult(this.name, `**Unknown action:** \`${action}\`. Use 'status', 'search', or 'complete'.`, true);
      }
    } catch (err) {
      if (err instanceof Error && 'code' in err && typeof err.code === 'string') {
        return toResult(this.name, `**Error**  \n${err.code}: ${err.message}`, true);
      }
      return toResult(this.name, `**Error**  \n${String(err)}`, true);
    }
  }
}
