/**
 * BotBubbleRow — Single message row: bubble + hover overlay.
 *
 * Rakazo alignment (2026-09-05): rows carry NO avatar and NO name — the
 * bot identity lives once in the centered chat header. Rows are pure
 * bubbles (assistant left on surface, user right on contrast). The row
 * itself is the hover target (rakazo `group/message`): the hover bar
 * (time + thumbs-up/copy pill) hangs below the row's bottom-left corner,
 * landing in the next row's 36px padding lane, so it never covers the
 * previous message.
 *
 * Handles:
 *   - User vs Assistant alignment (flex-end vs flex-start)
 *   - BotMessageHoverBar (whole-row hover; suppressed while streaming
 *     so text selection and stop clicks stay free — rakazo progress
 *     exemption)
 *   - Persisted thumbs-up (localStorage, per message id) with the
 *     rakazo 👍 badge below the bubble
 *   - MarkdownRenderer (shared session-chat-view renderer) for bot text;
 *     user text stays plain pre-wrap (session-view parity)
 *   - BotCodeBlock for code messages
 *   - BotTypingIndicator for streaming state
 *
 * Usage:
 *   <BotBubbleRow
 *     role="assistant"
 *     text="Hello, how can I help?"
 *     messageId="m3"
 *     timestamp={1730000000000}
 *   />
 */

import React from 'react';
import {
  BotMessageHoverBar,
  BotThumbsBadge,
  useMessageThumbsUp,
} from './BotMessageHoverBar';
import { MarkdownRenderer } from './MarkdownRenderer';
import { BotCodeBlock } from './BotCodeBlock';
import { BotTypingIndicator } from './BotTypingIndicator';
import type { MessageDelivery } from '@/types/message';
import type { BotSessionPhase } from './bot/use-bot-session-phase';

interface BotBubbleRowProps {
  /** 'user' aligns right, 'assistant' aligns left */
  role: 'user' | 'assistant';
  /** Message id — keys the persisted thumbs-up (no id: no reaction) */
  messageId?: string;
  /** Plan 491 P0.1: message delivery phase (user messages only) */
  delivery?: MessageDelivery;
  /** Plan 491 P0.3: session phase (bot messages only) */
  phase?: BotSessionPhase;
  /** Message timestamp — shown in the hover bar's time label */
  timestamp?: number;
  /** Text content (user: plain pre-wrap; assistant: shared MarkdownRenderer) */
  text?: string;
  /** Pre-formatted code content (renders BotCodeBlock) */
  code?: string;
  /** Language hint for code blocks */
  codeLanguage?: string;
  /** True while the assistant is streaming this message */
  isStreaming?: boolean;
  /** Additional CSS class for the bubble */
  bubbleClassName?: string;
}

export function BotBubbleRow({
  role,
  messageId,
  text,
  code,
  codeLanguage,
  isStreaming = false,
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

  // Persisted thumbs-up (localStorage by message id); the hover pill and
  // the below-bubble badge share one state. Rows are keyed by message id
  // upstream, so the initializer re-reads storage on every new message.
  const [thumbsUp, toggleThumbsUp] = useMessageThumbsUp(messageId);

  // Determine content to render inside bubble
  const renderBubbleContent = () => {
    if (isStreaming && !text && !code) {
      return <BotTypingIndicator />;
    }
    if (code !== undefined) {
      return <BotCodeBlock code={code} language={codeLanguage} />;
    }
    if (text !== undefined) {
      // Session-chat-view parity (MessageItem): user messages render as
      // plain pre-wrap text (the bubble supplies white-space), assistant
      // messages go through the shared MarkdownRenderer — same renderer as
      // the workspace transcript (react-markdown + GFM + KaTeX + tables).
      return isUser ? (
        text
      ) : (
        <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none bot-bubble-markdown">
          {text}
        </MarkdownRenderer>
      );
    }
    return null;
  };

  const bubbleContent = renderBubbleContent();
  if (!bubbleContent) return null;

  return (
    <div
      className={`bot-chat-row ${isUser ? 'bot-chat-row--user' : 'bot-chat-row--assistant'}`}
      data-role={role}
    >
      {/* rakazo MessageHoverActions: suppressed while streaming (progress
          exemption) so selection / stop clicks stay hover-free. */}
      {!isStreaming && (
        <BotMessageHoverBar
          timestamp={timestamp}
          textToCopy={text}
          messageId={messageId}
          thumbsUp={thumbsUp}
          onToggleThumbsUp={messageId ? toggleThumbsUp : undefined}
        />
      )}
      <div className="bot-chat-row__stack">
        <div
          className={`bot-chat-bubble ${isUser ? 'bot-chat-bubble--user' : 'bot-chat-bubble--assistant'} ${bubbleClassName}${deliveryClass}${phaseClass}`}
        >
          {isUser && delivery === 'sending' ? (
            <div className="bot-chat-bubble__sending">
              <div className="bot-chat-bubble__spinner" />
              <span>发送中...</span>
            </div>
          ) : bubbleContent}
        </div>
        {thumbsUp && <BotThumbsBadge onRemove={toggleThumbsUp} />}
      </div>
    </div>
  );
}
