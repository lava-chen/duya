/**
 * CommandResultDialog — renders a slash command's text/error output.
 *
 * Info-style commands (/help, /status, /cost, /context, /transcript, `!cmd`
 * output) return `{ type: 'text' }` / `{ type: 'error' }` from their executor.
 * The dialog is the shared display surface so each command doesn't need its
 * own UI. `mono` renders the body in a preformatted block (shell output).
 */

import React from 'react';
import { XIcon } from '@/components/icons';

export interface CommandResultDialogProps {
  open: boolean;
  title: string;
  content: string;
  mono?: boolean;
  isError?: boolean;
  onClose: () => void;
}

export function CommandResultDialog({
  open,
  title,
  content,
  mono = false,
  isError = false,
  onClose,
}: CommandResultDialogProps): React.ReactElement | null {
  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={title}
        className="relative flex flex-col w-[min(680px,90vw)] max-h-[70vh] rounded-xl border border-[var(--border)] bg-[var(--surface-solid)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)]">
          <h3 className="text-sm font-semibold text-[var(--text)] truncate">{title}</h3>
          <button
            type="button"
            onClick={onClose}
            className="p-1 rounded-md text-[var(--muted)] hover:bg-[var(--surface-hover)] hover:text-[var(--text)] transition-colors"
            aria-label="Close"
          >
            <XIcon size={16} />
          </button>
        </div>
        <div className="overflow-auto px-4 py-3">
          {mono ? (
            <pre
              className="text-xs leading-relaxed whitespace-pre-wrap break-words font-mono"
              style={{ color: isError ? 'var(--error, #dc2626)' : 'var(--text)' }}
            >
              {content}
            </pre>
          ) : (
            <div
              className="text-xs leading-relaxed whitespace-pre-wrap break-words"
              style={{ color: isError ? 'var(--error, #dc2626)' : 'var(--text)' }}
            >
              {content}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
