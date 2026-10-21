// ResearchStateToolRow — plain, non-expandable status row for the
// model-facing research state-machine tools (plan 423): research_start,
// research_advance, research_continue. These only drive the lifecycle
// forward (or resume it after a user answer); they carry no user-visible
// artifact of their own, so instead of leaking the raw tool name we render
// a short natural-language cue ("进入下一研究阶段" / "Advanced"). The actual
// per-stage work is shown by the stage-grouped sections in the same reply.

'use client';

import React from 'react';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import { useTranslation } from '@/hooks/useTranslation';
import type { ToolAction } from '../types';
import type { TranslationKey } from '@/i18n';

interface ResearchStateToolRowProps {
  tool: ToolAction;
}

/** Map a research state-machine tool to its natural-language summary. */
function stateSummary(name: string, locale: 'en' | 'zh'): string {
  const lower = name.toLowerCase();
  if (lower === 'research_start') return locale === 'zh' ? '开始深度研究' : 'Started deep research';
  if (lower === 'research_advance') return locale === 'zh' ? '进入下一研究阶段' : 'Moved to the next research phase';
  if (lower === 'research_continue') return locale === 'zh' ? '继续研究' : 'Resumed research';
  return name;
}

export function ResearchStateToolRow({ tool }: ResearchStateToolRowProps) {
  const { locale } = useTranslation();
  const status = getStatus(tool);
  const summary = stateSummary(tool.name, locale);
  const verbKey: TranslationKey =
    status === 'running' ? 'streaming.toolAction.running.module'
    : status === 'error' ? 'streaming.toolAction.error.module'
    : 'streaming.toolAction.done.module';

  return (
    <ActionRowChrome
      status={status}
      verbKey={verbKey}
      canExpand={false}
      expanded={false}
      hovered={false}
      durationMs={tool.durationMs}
    >
      {summary}
    </ActionRowChrome>
  );
}