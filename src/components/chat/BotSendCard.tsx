/**
 * BotSendCard — Plan 489 P2.2 minimal card rendering for SendMessage
 * message kinds beyond plain text.
 *
 * Scope: MINIMAL readable cards inside the assistant bubble chrome —
 * not the full interactive card family (P2.2 follow-ups add secret
 * input flows, cursor-agent live status, etc.).
 *
 * Dispatch by Message.msgType:
 *   - 'attachment'      → caption + clickable file/link chip
 *   - 'widget'          → prompt + option buttons (click = send as user)
 *   - 'cursor-agent'    → run badge with bcId + content
 *   - 'secret-request'  → credential request descriptor (no input yet)
 *   - 'text' + images   → text + image thumbnails
 *
 * Payload source: Message.sendMessageMeta (round-trips through
 * metadata.sendMessage → MessageRow.send_message_meta). Rows persisted
 * before that whitelist existed render content-only — acceptable
 * degradation for minimal cards.
 */

import React from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import type { Message, SendMessageCardMeta } from '@/types/message';

interface BotSendCardProps {
  message: Message;
  /** Called when a widget option is clicked (sends the option as a user message). */
  onOptionClick?: (option: string) => void;
}

/** Extract a display filename from a file:// or https:// url. */
function urlLabel(url: string): string {
  try {
    const clean = url.replace(/^file:\/\//, '');
    const last = clean.split(/[\\/]/).pop();
    return last || url;
  } catch {
    return url;
  }
}

function AttachmentBody({ meta }: { meta: SendMessageCardMeta }) {
  if (!meta.url) return null;
  return (
    <a
      className="bot-send-card__chip"
      href={meta.url}
      target="_blank"
      rel="noreferrer"
      title={meta.url}
    >
      <span className="bot-send-card__chip-icon">📎</span>
      <span className="bot-send-card__chip-label">
        {meta.alt || urlLabel(meta.url)}
      </span>
    </a>
  );
}

function WidgetBody({
  meta,
  onOptionClick,
}: {
  meta: SendMessageCardMeta;
  onOptionClick?: (option: string) => void;
}) {
  const widget = meta.widget;
  if (!widget || !Array.isArray(widget.options)) return null;
  return (
    <div className="bot-send-card__widget">
      {widget.prompt && (
        <div className="bot-send-card__widget-prompt">{widget.prompt}</div>
      )}
      <div className="bot-send-card__widget-options">
        {widget.options.slice(0, 6).map((option, i) => {
          // SendMessageTool persists options as {label, value?, description?,
          // style?}; rows written before that schema may hold bare strings.
          const resolved =
            typeof option === 'string' ? { label: option } : option;
          return (
            <button
              key={i}
              type="button"
              className="bot-send-card__option"
              data-style={resolved.style}
              title={resolved.description}
              onClick={() => onOptionClick?.(resolved.value ?? resolved.label)}
            >
              {resolved.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function CursorAgentBody({ meta }: { meta: SendMessageCardMeta }) {
  return (
    <div className="bot-send-card__badge-row">
      <span className="bot-send-card__badge">Cursor Agent</span>
      {meta.bcId && (
        <code className="bot-send-card__bcid" title={meta.bcId}>
          {meta.bcId.slice(0, 12)}
        </code>
      )}
    </div>
  );
}

function SecretRequestBody({ meta }: { meta: SendMessageCardMeta }) {
  const secret = meta.secret;
  if (!secret) return null;
  return (
    <div className="bot-send-card__secret">
      <div className="bot-send-card__secret-label">
        <span className="bot-send-card__chip-icon">🔑</span>
        <strong>{secret.label}</strong>
      </div>
      <div className="bot-send-card__secret-path">
        {secret.connector} / {secret.field}
      </div>
      <div className="bot-send-card__secret-hint">
        凭据将通过加密通道填写，bot 不会看到明文。
      </div>
    </div>
  );
}

function ImageStrip({ images }: { images: Array<{ url: string; alt?: string }> }) {
  return (
    <div className="bot-send-card__images">
      {images.map((image, i) => (
        <img
          key={i}
          className="bot-send-card__image"
          src={image.url}
          alt={image.alt || ''}
          loading="lazy"
        />
      ))}
    </div>
  );
}

export function BotSendCard({ message, onOptionClick }: BotSendCardProps) {
  const meta = message.sendMessageMeta ?? {};
  const caption = typeof message.content === 'string' ? message.content : '';

  return (
    <div className="bot-send-card" data-card={message.msgType}>
      {caption && (
        <MarkdownRenderer className="prose prose-sm dark:prose-invert max-w-none bot-bubble-markdown">
          {caption}
        </MarkdownRenderer>
      )}
      {message.msgType === 'attachment' && <AttachmentBody meta={meta} />}
      {message.msgType === 'widget' && (
        <WidgetBody meta={meta} onOptionClick={onOptionClick} />
      )}
      {message.msgType === 'cursor-agent' && <CursorAgentBody meta={meta} />}
      {message.msgType === 'secret-request' && <SecretRequestBody meta={meta} />}
      {meta.images && meta.images.length > 0 && <ImageStrip images={meta.images} />}
    </div>
  );
}
