/**
 * BotToolCallRow — Expandable tool-call row (grok-bot's TranscriptToolCallRow).
 *
 * States:
 *   pending  — spinning loader
 *   running  — spinning loader (tool executing)
 *   done     — wrench icon, summary shown
 *   failed   — XCircle icon, summary shown, detail expanded
 *   aborted  — wrench icon, struck through
 *
 * Layout: [icon] [tool-name] [preview] [chevron]
 * Expanded: [detail] [ToolResultCard]
 */

import React, { useState } from 'react';
import {
  WrenchIcon,
  XCircleIcon,
  CircleNotchIcon,
  CaretRightIcon,
  CopyIcon,
  CheckIcon,
} from '@/components/icons';

export type ToolCallStatus = 'pending' | 'running' | 'done' | 'failed' | 'aborted';

interface BotToolCallRowProps {
  name: string;
  status?: ToolCallStatus;
  summary?: string;
  toolInput?: string;
  toolResult?: string;
  toolResultDetail?: string;
}

const STATUS_ICONS: Record<ToolCallStatus, React.ReactNode> = {
  pending: <CircleNotchIcon size={14} className="bot-tool-icon bot-tool-icon--pending" />,
  running: <CircleNotchIcon size={14} className="bot-tool-icon bot-tool-icon--running" />,
  done: <WrenchIcon size={14} className="bot-tool-icon bot-tool-icon--done" />,
  failed: <XCircleIcon size={14} className="bot-tool-icon bot-tool-icon--failed" />,
  aborted: <WrenchIcon size={14} className="bot-tool-icon bot-tool-icon--aborted" />,
};

/** Format a tool name like "bash__run_command" → "bash / run command" */
function formatToolName(name: string): string {
  return name
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export function BotToolCallRow({
  name,
  status = 'pending',
  summary,
  toolInput,
  toolResult,
  toolResultDetail,
}: BotToolCallRowProps) {
  const [expanded, setExpanded] = useState(status === 'failed');
  const [copied, setCopied] = useState(false);

  const preview = summary
    ? summary.slice(0, 72) + (summary.length > 72 ? '…' : '')
    : status === 'pending'
    ? 'Calling tool…'
    : status === 'running'
    ? 'Running…'
    : '';

  const handleCopy = async (e: React.MouseEvent) => {
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(toolInput || summary || name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard not available
    }
  };

  return (
    <div
      className={`bot-tool-row ${expanded ? 'bot-tool-row--expanded' : ''} bot-tool-row--${status}`}
      role="listitem"
    >
      <button
        type="button"
        className="bot-tool-row__toggle"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
      >
        <span className="bot-tool-row__icon">{STATUS_ICONS[status]}</span>
        <span className="bot-tool-row__name">{formatToolName(name)}</span>
        {preview && (
          <span className="bot-tool-row__preview">{preview}</span>
        )}
        <CaretRightIcon
          size={12}
          className={`bot-tool-row__chevron ${expanded ? 'bot-tool-row__chevron--open' : ''}`}
        />
      </button>

      {expanded && (
        <div className="bot-tool-row__detail">
          {toolInput && (
            <div className="bot-tool-row__detail-section">
              <div className="bot-tool-row__detail-header">
                <span className="bot-tool-row__detail-label">Input</span>
                <button
                  type="button"
                  className="bot-tool-row__copy-btn"
                  onClick={handleCopy}
                  aria-label="Copy input"
                  title="Copy input"
                >
                  {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
                </button>
              </div>
              <pre className="bot-tool-row__detail-pre">{toolInput}</pre>
            </div>
          )}
          {toolResult && (
            <div className="bot-tool-row__detail-section">
              <div className="bot-tool-row__detail-header">
                <span className="bot-tool-row__detail-label">Result</span>
                {toolResultDetail && (
                  <span className={`bot-tool-row__result-badge bot-tool-row__result-badge--${status === 'failed' ? 'failed' : 'done'}`}>
                    {status === 'failed' ? 'Error' : 'Done'}
                  </span>
                )}
              </div>
              <pre className="bot-tool-row__detail-pre">{toolResult}</pre>
            </div>
          )}
          {!toolInput && !toolResult && summary && (
            <pre className="bot-tool-row__detail-pre">{summary}</pre>
          )}
        </div>
      )}
    </div>
  );
}
