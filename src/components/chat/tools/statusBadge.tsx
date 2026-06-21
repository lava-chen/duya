// Shared bottom-right status badge used by every row's expanded card.
// The badge is the only place a row says "this thing actually finished
// successfully / failed / is still running" once the user opens it.
// Hoisted out of each row file because the same 14-line JSX block was
// copy-pasted in BashToolRow, DuyaCliToolRow, ReadToolRow,
// AskUserQuestionResultRow, MemoryToolRow, FileEditToolRow, and the
// generic ToolActionRow — keeping one source of truth avoids drift
// (e.g. a future tone tweak landing in 6 of 7 rows).

'use client';

import React from 'react';
import {
  CheckCircleIcon,
  SpinnerGapIcon,
  XCircleIcon,
} from '@/components/icons';
import type { ToolStatus } from './types';

export function ToolStatusBadge({ status }: { status: ToolStatus }) {
  return (
    <div className="mt-1 flex justify-end">
      {status === 'success' && (
        <div className="flex items-center gap-1 text-[11px] text-green-500">
          <CheckCircleIcon size={12} />
          <span>Success</span>
        </div>
      )}
      {status === 'error' && (
        <div className="flex items-center gap-1 text-[11px] text-red-500">
          <XCircleIcon size={12} />
          <span>Failed</span>
        </div>
      )}
      {status === 'running' && (
        <div className="flex items-center gap-1 text-[11px] text-amber-500">
          <SpinnerGapIcon size={12} className="animate-spin" />
          <span>Running</span>
        </div>
      )}
    </div>
  );
}
