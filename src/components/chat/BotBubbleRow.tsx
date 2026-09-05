/**
 * BotBubbleRow — Single message row: bubble + hover actions.
 *
 * Grok/screenshot standard (2026-09-04): rows carry NO avatar and NO
 * name — the bot identity lives once in the centered chat header. Rows
 * are pure bubbles (assistant left on surface, user right on contrast).
 *
 * Handles:
 *   - User vs Assistant alignment (flex-end vs flex-start)
 *   - BotMessageAction hover wrapper (both roles: copy/reply)
 *   - BotBubbleText (inline markdown) for regular text
 *   - BotCodeBlock for code messages
 *   - BotTypingIndicator for streaming state
 *
 * Usage:
 *   <BotBubbleRow
 *     role="assistant"
 *     text="Hello, how can I help?"
 *     onReply={handleReply}
 *   />
 */

import React from 'react';
import { BotMessageAction } from './BotMessageAction';
import { BotBubbleText } from './BotBubbleText';
import { BotCodeBlock } from './BotCodeBlock';
import { BotTypingIndicator } from './BotTypingIndicator';
import type { MessageDelivery } from '@/types/message';
import type { BotSessionPhase } from './bot/use-bot-session-phase';

interface BotBubbleRowProps {
  /** 'user' aligns right, 'assistant' aligns left */
  role: 'user' | 'assistant';
  /** Plan 491 P0.1: message delivery phase (user messages only) */
  delivery?: MessageDelivery;
  /** Plan 491 P0.3: session phase (bot messages only) */
  phase?: BotSessionPhase;
  /** Message timestamp for hover display */
  timestamp?: number;
  /** Plain text content (rendered as markdown via BotBubbleText) */
  text?: string;
  /** Pre-formatted code content (renders BotCodeBlock) */
  code?: string;
  /** Language hint for code blocks */
  codeLanguage?: string;
  /** True while the assistant is streaming this message */
  isStreaming?: boolean;
  /** Callback when user clicks Reply */
  onReply?: () => void;
  /** Additional CSS class for the bubble */
  bubbleClassName?: string;
}

export function BotBubbleRow({
  role,
  text,
  code,
  codeLanguage,
  isStreaming = false,
  onReply,
  bubbleClassName = '',
  delivery,
  phase,
  timestamp,
}: BotBubbleRowProps) {
  const isUser = role === 'user';

  // Plan 491 P0.1: delivery state CSS class
  const deliveryClass = delivery && isUser ? ` bot-chat-bubble--${delivery}` : '';

  // Plan 491 P0.3: session phase CSS class for bot messages
  const phaseClass = phase && !isUser ? ` bot-chat-bubble--phase-${phase}` : '';

  // Plan 491 P2.3: format timestamp for hover display
  const formatTimestamp = (ts: number) => {
    const date = new Date(ts);
    return date.toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  // Determine content to render inside bubble
  const renderBubbleContent = () => {
    if (isStreaming && !text && !code) {
      return <BotTypingIndicator />;
    }
    if (code !== undefined) {
      return <BotCodeBlock code={code} language={codeLanguage} />;
    }
    if (text !== undefined) {
      return <BotBubbleText text={text} />;
    }
    return null;
  };

  const bubbleContent = renderBubbleContent();
  if (!bubbleContent) return null;

  // Both roles get the hover action anchor (grok isOrdinaryMessageActionable
  // treats user + agent rows alike: copy/reply on hover, menu on dots).
  return (
    <div
      className={`bot-chat-row ${isUser ? 'bot-chat-row--user' : 'bot-chat-row--assistant'}`}
      data-role={role}
    >
      <BotMessageAction textToCopy={text} onReply={onReply}>
        <div
          className={`bot-chat-bubble ${isUser ? 'bot-chat-bubble--user' : 'bot-chat-bubble--assistant'} ${bubbleClassName}${deliveryClass}${phaseClass}`}
        >
          {isUser && delivery === 'sending' ? (
            <div className="bot-chat-bubble__sending">
              <div className="bot-chat-bubble__spinner" />
              <span>发送中...</span>
            </div>
          ) : bubbleContent}

          {/* Plan 491 P2.3: timestamp shown on hover */}
          {timestamp && (
            <span className="bot-chat-bubble__timestamp">
              {formatTimestamp(timestamp)}
            </span>
          )}
        </div>
      </BotMessageAction>
    </div>
  );
}
