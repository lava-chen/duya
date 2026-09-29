import type { TranslationKey } from '@/i18n';
import type { ToolAction } from '../types';
import { buildGroupSummary } from './buildGroupSummary';

const MAX_TITLE_LENGTH = 120;
const FILE_TARGET_TOOLS = new Set([
  'read', 'read_file', 'readfile', 'readtool',
  'edit', 'edit_file', 'edittool', 'write', 'write_file', 'writefile', 'create_file',
]);
const FILE_TARGET_KEYS = ['file_path', 'filePath', 'path', 'file'];

export function sanitizeProgressTitleForDisplay(value: unknown): string | undefined {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/u.test(value)) return undefined;
  const title = value.trim();
  if (!title) return undefined;
  return title.slice(0, MAX_TITLE_LENGTH).trimEnd() || undefined;
}

function firstSafeFileTarget(tools: ToolAction[]): string | undefined {
  for (const tool of tools) {
    if (!FILE_TARGET_TOOLS.has(tool.name.toLowerCase())) continue;
    if (!tool.input || typeof tool.input !== 'object' || Array.isArray(tool.input)) continue;
    const input = tool.input as Record<string, unknown>;
    for (const key of FILE_TARGET_KEYS) {
      const raw = input[key];
      if (typeof raw !== 'string' || raw.length > 2048) continue;
      const leaf = raw.trim().replace(/\\/g, '/').split('/').pop()?.trim();
      if (!leaf || leaf === '.' || leaf === '..') continue;
      const safe = sanitizeProgressTitleForDisplay(leaf);
      if (safe) return safe.slice(0, 48).trimEnd();
    }
  }
  return undefined;
}

export function buildGroupDisplayTitle(
  tools: ToolAction[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: string,
): string {
  return resolveGroupDisplayTitle(tools, t, locale).title;
}

export function resolveGroupDisplayTitle(
  tools: ToolAction[],
  t: (key: TranslationKey, params?: Record<string, string | number>) => string,
  locale: string,
): { title: string; source: NonNullable<ToolAction['progressSource']> } {
  const explicitTitle = tools
    .map((tool) => ({
      title: sanitizeProgressTitleForDisplay(tool.progressTitle),
      source: tool.progressSource,
    }))
    .find((candidate) => !!candidate.title);
  if (explicitTitle?.title) {
    return {
      title: explicitTitle.title,
      source: explicitTitle.source === 'provider_commentary' || explicitTitle.source === 'model_progress_tool'
        ? explicitTitle.source
        : 'tool_fallback',
    };
  }

  const summary = buildGroupSummary(tools, t, locale).trim();
  const safeTarget = firstSafeFileTarget(tools);
  const title = summary && safeTarget
    ? `${summary} · ${safeTarget}`
    : summary || t('streaming.toolAction.groupProgress.generic');
  return { title, source: 'tool_fallback' };
}
