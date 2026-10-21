// SkillToolRow — handles the `Skill` tool (see
// packages/agent/src/tool/SkillTool/SkillTool.ts). The tool returns a
// JSON envelope:
//   { success, commandName, status, allowedTools?, model?, content }
//
// `content` is the actual skill markdown body, prefixed with
// `Base directory for this skill: <path>\n\n` so the model can locate
// the skill's source on disk. We split the prefix off and use the
// path to open the skill's SKILL.md in the side-panel preview when
// the user clicks the row — the skill name is rendered in blue to
// signal that the row is a link to the skill source.
//
// Row:  [verb] [skill name (blue link)]            [baseDir mono]

'use client';

import React, { useMemo } from 'react';
import { ActionRowChrome } from '../chrome/ActionRowChrome';
import { getStatus } from '../registry';
import type { ToolAction } from '../types';

interface SkillToolRowProps {
  tool: ToolAction;
}

const BASE_DIR_RE = /^Base directory for this skill:\s*(.+?)\s*\n\n?/;

interface ParsedSkillResult {
  /** Path extracted from the `Base directory for this skill:` prefix, or
   *  null when the prefix is absent (e.g. older result formats). */
  baseDir: string | null;
  /** Friendly command name from the JSON envelope (usually equals the
   *  skill name from `tool.input.skill`). Falls back to `'skill'`. */
  commandName: string;
}

/**
 * Parse the SkillTool's JSON envelope. Returns null when the result is
 * missing or unparseable. We only need the base directory and command
 * name — the markdown body is no longer rendered inline (the user
 * clicks through to the SKILL.md file in the side panel instead).
 */
function parseSkillResult(result: string | undefined): ParsedSkillResult | null {
  if (!result) return null;
  let content: string;
  let commandName = 'skill';
  const trimmed = result.trim();
  if (trimmed.startsWith('{')) {
    try {
      const data = JSON.parse(trimmed) as Record<string, unknown>;
      const rawContent = data.content;
      if (typeof rawContent !== 'string' || !rawContent) return null;
      content = rawContent;
      if (typeof data.commandName === 'string' && data.commandName.trim()) {
        commandName = data.commandName.trim();
      }
    } catch {
      return null;
    }
  } else {
    content = result;
  }

  const match = content.match(BASE_DIR_RE);
  const baseDir = match ? match[1].trim() : null;
  return { baseDir, commandName };
}

export function SkillToolRow({ tool }: SkillToolRowProps) {
  const status = getStatus(tool);

  const parsed = useMemo(
    () => parseSkillResult(tool.result),
    [tool.result],
  );

  // Header summary: prefer the JSON envelope's commandName, fall back
  // to the input's `skill` field, then a generic 'skill' placeholder.
  const summary = useMemo(() => {
    if (parsed?.commandName && parsed.commandName !== 'skill') return parsed.commandName;
    const inp = (tool.input || {}) as Record<string, unknown>;
    const fromInput = typeof inp.skill === 'string' ? inp.skill.trim() : '';
    return fromInput || 'skill';
  }, [parsed, tool.input]);

  const baseDir = parsed?.baseDir ?? null;

  const verbKey =
    status === 'running' ? 'streaming.toolAction.running.skill'
    : status === 'error' ? 'streaming.toolAction.error.skill'
    : 'streaming.toolAction.done.skill';

  const handleOpenSkillFile = () => {
    if (!baseDir) return;
    const filePath = `${baseDir.replace(/[\\/]+$/, '')}/SKILL.md`;
    window.dispatchEvent(new CustomEvent('duya:open-file-preview-panel', {
      detail: {
        filePath,
        workingDirectory: baseDir,
      },
    }));
  };

  return (
    <ActionRowChrome
      status={status}
      verbKey={verbKey}
      canExpand={false}
      expanded={false}
      hovered={false}
      durationMs={tool.durationMs}
      onClick={baseDir ? handleOpenSkillFile : undefined}
      buttonClassName={baseDir ? 'cursor-pointer' : 'cursor-default'}
      rightSlot={
        baseDir ? (
          <span
            className="text-muted-foreground/40 text-[11px] font-mono truncate max-w-[260px] hidden sm:inline"
            title={baseDir}
          >
            {baseDir}
          </span>
        ) : null
      }
    >
      <span
        className={
          baseDir
            ? 'text-blue-600 dark:text-blue-400 hover:underline underline-offset-2 transition-colors'
            : undefined
        }
      >
        {summary}
      </span>
    </ActionRowChrome>
  );
}
