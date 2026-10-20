// ChatNotice — a quiet, centered one-line hint rendered in the message
// flow when the agent uses a memory or routine tool.
//
// These are explicitly NOT tool rows: the user asked for a lightweight
// status update ("Memory updated", "Created routine ◷ …") sitting in the
// middle of the chat, rather than a collapsible tool chrome chit the
// user would have to expand. `MessageItem` lifts notice actions out of
// the tool group and renders one of these per call, always visible.
//
// Visual reference: rakazo's product-demo "meta" line — a bare, centered
// muted text row (no background pill), with the routine armed by a "◷"
// history glyph. States: running (spinner + progress cue) → success
// (one-line outcome) or error (failure hint).

'use client';

import React from 'react';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';
import type { ChatNotice } from './tools/types';
import type { TranslationKey } from '@/i18n';

// manage_routine result strings (see
// packages/agent/src/tool/ManageRoutineTool/ManageRoutineTool.ts):
//   'Created routine "Morning digest" (id ...). Confirm it to the user once.'
//   'Updated routine "X" (id ...). It keeps its history.'
//   'Paused routine "X" (id ...). It stays listed but will not fire...'
//   'Resumed routine "X" (id ...).'
//   'Deleted routine "X" (id ...).'
//   'Your routines:\n- name (id ...) [state] — when...'
//   'You have no routines yet.'
function parseRoutineResult(result: string | undefined): { action: string; name?: string } {
  const text = (result || '').trim();
  const prefixes = [
    'Created routine',
    'Updated routine',
    'Paused routine',
    'Resumed routine',
    'Deleted routine',
  ];
  for (const word of prefixes) {
    if (text.toLowerCase().startsWith(word.toLowerCase())) {
      const match = /"[^"]*"\s*/.exec(text.slice(word.length));
      // Strip surrounding quotes from the captured name.
      const nameMatch = match ? /"([^"]*)"/.exec(match[0]) : null;
      return { action: word.toLowerCase(), name: nameMatch ? nameMatch[1] : undefined };
    }
  }
  if (text.startsWith('Your routines') || text.startsWith('You have no routines')) {
    return { action: 'list' };
  }
  return { action: '' };
}

const ROUTINE_KEYS: Record<string, TranslationKey> = {
  'created routine': 'chat.notice.routineCreated',
  'updated routine': 'chat.notice.routineUpdated',
  'paused routine': 'chat.notice.routinePaused',
  'resumed routine': 'chat.notice.routineResumed',
  'deleted routine': 'chat.notice.routineDeleted',
  list: 'chat.notice.routineListed',
};

const ROUTINE_NAME_KEYS: ReadonlySet<TranslationKey> = new Set<TranslationKey>([
  'chat.notice.routineCreated',
  'chat.notice.routineUpdated',
  'chat.notice.routinePaused',
  'chat.notice.routineResumed',
  'chat.notice.routineDeleted',
]);

export function ChatNotice({ notice }: { notice: ChatNotice }) {
  const { t } = useTranslation();
  const running = notice.result === undefined;
  const failed = running ? false : !!notice.isError;

  let content: React.ReactNode;
  if (running) {
    const key: TranslationKey =
      notice.kind === 'memory' ? 'chat.notice.memoryRunning' : 'chat.notice.routineRunning';
    content = (
      <>
        <SpinnerGapIcon size={11} className="animate-spin" />
        <span>{t(key)}</span>
      </>
    );
  } else if (failed) {
    const key: TranslationKey =
      notice.kind === 'memory' ? 'chat.notice.memoryFailed' : 'chat.notice.routineFailed';
    content = (
      <>
        <XCircleIcon size={11} />
        <span>{t(key)}</span>
      </>
    );
  } else if (notice.kind === 'memory') {
    content = (
      <>
        <CheckCircleIcon size={11} />
        <span>{t('chat.notice.memoryUpdated')}</span>
      </>
    );
  } else {
    const { action, name } = parseRoutineResult(notice.result);
    const key = ROUTINE_KEYS[action] ?? 'chat.notice.routineListed';
    const withName = name && ROUTINE_NAME_KEYS.has(key);
    content = (
      <>
        <CheckCircleIcon size={11} />
        <span>{withName ? t(key, { name }) : t(key)}</span>
      </>
    );
  }

  return (
    <div className="flex w-full justify-center">
      <span className="inline-flex items-center gap-1.5 text-[12.5px] leading-5 text-muted-foreground/80">
        {content}
      </span>
    </div>
  );
}