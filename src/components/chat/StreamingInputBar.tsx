/**
 * StreamingInputBar.tsx - Minimal input bar shown while the agent is streaming (Plan 202).
 *
 * Replaces the full MessageInput when isStreaming is true. The MailboxPanel
 * (above) handles in-run instructions; this bar provides only the essential
 * affordances:
 *   left:    "+"   → opens an attachment menu (PR2 stub)
 *   middle:  "完全访问" / "5.4 中"  → read-only permission + model display
 *   right:   🎤  + 圆形 stop 按钮
 *
 * Visually it bonds to the MailboxPanel above using the same chrome as
 * sub-agent-panel / permission-prompt-panel (rounded top, flat bottom).
 *
 * The selectors are display-only during streaming. PR1 just shows their
 * current state as a label; PR2 will wire up live popovers if needed.
 */

'use client';

import React from 'react';
import {
  PlusIcon,
  MicrophoneIcon,
  StopIcon,
  CaretDownIcon,
} from '@/components/icons';
import { useTranslation } from '@/hooks/useTranslation';

// =============================================================================
// Props
// =============================================================================

interface StreamingInputBarProps {
  /** Stop the running agent (required while streaming). */
  onStop: () => void;
  /** Open the attachment menu (PR2 stub). */
  onAttach?: () => void;
  /** Push-to-talk microphone (PR2 stub). */
  onMic?: () => void;

  /** Display label for the model (e.g. "5.4 中") */
  modelLabel: string;
  /** Display label for the permission mode (e.g. "完全访问") */
  permissionLabel: string;
}

// =============================================================================
// Component
// =============================================================================

export function StreamingInputBar({
  onStop,
  onAttach,
  onMic,
  modelLabel,
  permissionLabel,
}: StreamingInputBarProps) {
  const { t } = useTranslation();

  return (
    <div className="streaming-input-bar-wrapper">
      <div className="streaming-input-bar">
        {/* Left: attach */}
        <div className="streaming-input-bar-left">
          <button
            type="button"
            onClick={() => onAttach?.()}
            className="streaming-input-bar-icon-btn"
            title={t('messageInput.attachFiles')}
            aria-label={t('messageInput.attachFiles')}
          >
            <PlusIcon size={14} weight="bold" />
          </button>
        </div>

        {/* Middle: permission + model (read-only display) */}
        <div className="streaming-input-bar-mid">
          <span className="streaming-input-bar-selector" title={permissionLabel}>
            <span>{permissionLabel}</span>
            <CaretDownIcon size={12} />
          </span>
          <span className="streaming-input-bar-selector" title={modelLabel}>
            <span>{modelLabel}</span>
            <CaretDownIcon size={12} />
          </span>
        </div>

        {/* Right: mic + stop */}
        <div className="streaming-input-bar-right">
          <button
            type="button"
            onClick={() => onMic?.()}
            className="streaming-input-bar-icon-btn"
            title="Voice (PR2)"
            aria-label="Voice"
          >
            <MicrophoneIcon size={14} />
          </button>
          <button
            type="button"
            onClick={onStop}
            className="streaming-input-bar-stop-btn"
            title="Stop"
            aria-label="Stop"
          >
            <StopIcon size={12} weight="fill" />
          </button>
        </div>
      </div>
    </div>
  );
}
