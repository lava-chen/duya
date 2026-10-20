// ResearchStageSections — groups a stream of tool actions by research
// lifecycle stage (plan 423 UI). When a research run is active, the
// streaming manager stamps each tool_use with the `stage` it ran in
// (clarifying / planning / gathering / evaluating / synthesizing), so the
// tool actions arrive already ordered by stage. This component splits the
// flat action list at stage boundaries and renders one collapsible section
// per stage (中英文标题 + done icon), auto-collapsing completed stages so
// the user sees at a glance which phase the agent is working through.
//
// Only renders when at least one action carries a `stage`; otherwise it
// returns `null` and the caller falls back to the normal grouped chrome.

'use client';

import React, { useMemo, useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { CheckCircleIcon, CaretRightIcon } from '@/components/icons';
import type { ActionItem, Segment } from './tools/types';
import { computeSegments } from './tools/segments';
import { renderOrderedBody } from './tools/flatRenderer';
import { splitByStage, stageLabel, type StageSection } from './researchStageLogic';
import type { AgentProgressEventWithMeta } from '@/hooks/useStreamingAgentProgress';

interface ResearchStageSectionsProps {
  actions: ActionItem[];
  isStreaming?: boolean;
  streamingToolOutput?: string;
  agentProgressEvents?: AgentProgressEventWithMeta[];
  /** locale: 'en' | 'zh' — controls title language. */
  locale?: 'en' | 'zh';
}

export function ResearchStageSections({
  actions,
  isStreaming,
  streamingToolOutput,
  agentProgressEvents,
  locale = 'en',
}: ResearchStageSectionsProps) {
  const sections = useMemo(() => splitByStage(actions), [actions]);

  // The last (current) stage is expanded by default; earlier stages collapse.
  const [expandedKeys, setExpandedKeys] = useState<Set<string>>(() => {
    const last = sections.length > 0 ? sections[sections.length - 1].stage : '';
    return new Set(last ? [last] : []);
  });

  // Keep the latest stage expanded as new sections stream in.
  useEffect(() => {
    if (sections.length === 0) return;
    const lastStage = sections[sections.length - 1].stage;
    setExpandedKeys((prev) => {
      if (prev.has(lastStage)) return prev;
      const next = new Set(prev);
      next.add(lastStage);
      return next;
    });
  }, [sections]);

  const toggle = (stage: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev);
      if (next.has(stage)) next.delete(stage);
      else next.add(stage);
      return next;
    });
  };

  if (sections.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {sections.map((section, idx) => {
        const { zh, en } = stageLabel(section.stage);
        const title = locale === 'zh' ? zh : en;
        const expanded = expandedKeys.has(section.stage);
        const segments = computeSegments(section.actions);
        const lastRunningTool = undefined;

        return (
          <div key={`${section.stage || 'untracked'}-${idx}`} className="research-stage-section">
            <button
              type="button"
              onClick={() => toggle(section.stage)}
              className="flex w-full items-center gap-2 py-1 text-xs rounded-sm hover:bg-muted/30 transition-colors"
              aria-expanded={expanded}
            >
              <CheckCircleIcon size={13} className="shrink-0 text-green-500" />
              <span className="font-medium text-muted-foreground/80 shrink-0">
                {locale === 'zh' ? `已完成${zh}` : `Done · ${en}`}
              </span>
              <CaretRightIcon
                size={11}
                className={`shrink-0 text-muted-foreground/60 transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
              />
            </button>

            <AnimatePresence initial={false}>
              {expanded && (
                <motion.div
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.15, ease: 'easeOut' }}
                  style={{ overflow: 'hidden' }}
                >
                  <div className="mt-0.5 border-l-2 border-border/50">
                    {renderOrderedBody(
                      section.actions,
                      segments,
                      lastRunningTool,
                      streamingToolOutput,
                      agentProgressEvents,
                      isStreaming,
                    )}
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </div>
  );
}