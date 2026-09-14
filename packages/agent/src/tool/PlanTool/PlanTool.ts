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

import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import {
  planStatus,
  planSearch,
  planComplete,
  type PlanStatusResult,
  type PlanSearchResult,
  type PlanCompleteResult,
  PlansError,
} from './storage.js';

export const PLAN_TOOL_NAME = 'plan';

type PlanAction = 'status' | 'search' | 'complete';

function toResult(name: string, markdown: string, error?: boolean): ToolResult {
  return {
    id: crypto.randomUUID(),
    name,
    result: markdown,
    ...(error ? { error: true } : {}),
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Formatters — each returns a markdown string
// ─────────────────────────────────────────────────────────────────────────────

function formatStatus(result: PlanStatusResult, filter: 'active' | 'all'): string {
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

  return lines.join('\n');
}

function formatSearch(result: PlanSearchResult, query: string): string {
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

  return lines.join('\n');
}

function formatComplete(result: PlanCompleteResult, projectId: string, planId: number): string {
  const lines: string[] = [];
  lines.push(`## Plan Archived ✓`);
  lines.push('');
  lines.push(`Plan **#${planId}** in project **${escapeMd(projectId)}** has been moved to \`completed/\`.`);
  lines.push('');
  lines.push(`> New location: \`${escapeMd(result.newFile)}\``);
  lines.push('');
  lines.push(`Use \`plan({ action: 'status', projectId: '${projectId}', status: 'all' })\` to verify.`);
  return lines.join('\n');
}

function escapeMd(text: string): string {
  return text.replace(/([|\\`])/g, '\\$1');
}

// ─────────────────────────────────────────────────────────────────────────────
// Tool
// ─────────────────────────────────────────────────────────────────────────────

export class PlanTool implements Tool, ToolExecutor {
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
        description: 'Project ID (e.g. e4e2b217). Required for status and complete actions.',
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
        then: { required: ['projectId'] },
      },
      {
        if: { properties: { action: { const: 'search' } } },
        then: { required: ['query'] },
      },
      {
        if: { properties: { action: { const: 'complete' } } },
        then: { required: ['projectId', 'planId'] },
      },
    ],
  };

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  async execute(input: Record<string, unknown>, _wd?: string, _context?: ToolUseContext): Promise<ToolResult> {
    const { action, projectId, status, query, scope, planId } = input as {
      action: PlanAction;
      projectId?: string;
      status?: 'active' | 'all';
      query?: string;
      scope?: 'all' | 'project';
      planId?: number;
    };

    try {
      switch (action) {
        case 'status': {
          const result = planStatus({ projectId: projectId!, status });
          return toResult(this.name, formatStatus(result, status ?? 'active'));
        }
        case 'search': {
          const result = planSearch({ query: query!, scope: scope as 'all' | 'project', projectId });
          return toResult(this.name, formatSearch(result, query!));
        }
        case 'complete': {
          const result = planComplete({ projectId: projectId!, planId: planId! });
          return toResult(this.name, formatComplete(result, projectId!, planId!));
        }
        default:
          return toResult(this.name, `**Unknown action:** \`${action}\`. Use 'status', 'search', or 'complete'.`, true);
      }
    } catch (err) {
      if (err instanceof PlansError) {
        return toResult(this.name, `**Error**  \n${err.code}: ${err.message}`, true);
      }
      return toResult(this.name, `**Error**  \n${String(err)}`, true);
    }
  }
}

export const planTool = new PlanTool();
