"use client";

/**
 * ChatView.tsx — static replica of the real DUYA bot chat pane:
 * a BotDirectChatView-style header + a scrollable transcript.
 *
 * Header is exactly the real one: `button.bot-chat-header__identity` wrapping
 *   <span class="bot-chat-header__avatar">
 *     <span class="bot-contact-avatar">…emoji…</span>
 *   </span>
 *   <span class="bot-chat-header__name">name</span>
 * Timestamps are centered `.bot-chat-date-separator` / `.bot-chat-time-separator`
 * rows shown when the message time changes.
 */

import { BotContact, ChatMessage } from "./mock-data";

export interface ChatViewProps {
  contact: BotContact;
  messages: ChatMessage[];
}

function TimeSeparator({ label, date }: { label: string; date?: boolean }) {
  return (
    <div
      className={date ? "bot-chat-date-separator" : "bot-chat-time-separator"}
      role="separator"
    >
      {label}
    </div>
  );
}

export default function ChatView({ contact, messages }: ChatViewProps) {
  return (
    <div className="bot-chat-view">
      <header className="bot-chat-header">
        <button
          type="button"
          className="bot-chat-header__identity"
          title={contact.subtitle || undefined}
        >
          <span className="bot-chat-header__avatar">
            <span
              className="bot-contact-avatar"
              style={{
                backgroundColor: contact.color,
                width: 28,
                height: 28,
                fontSize: Math.round(28 * 0.63),
              }}
              aria-hidden="true"
            >
              <span className="bot-contact-avatar-glyph">{contact.emoji}</span>
            </span>
          </span>
          <span className="bot-chat-header__name">{contact.name}</span>
        </button>
      </header>

      <div className="bot-chat-transcript-wrap">
        <div className="bot-chat-transcript" role="log" aria-live="off">
          {messages.length === 0 ? (
            <div className="bot-chat-empty">
              <div
                className="bot-contact-avatar"
                style={{
                  backgroundColor: contact.color,
                  width: 72,
                  height: 72,
                  fontSize: Math.round(72 * 0.63),
                }}
                aria-hidden="true"
              >
                <span className="bot-contact-avatar-glyph">{contact.emoji}</span>
              </div>
              <div className="bot-chat-empty__name">{contact.name}</div>
              {contact.subtitle && (
                <div className="bot-chat-empty__desc">{contact.subtitle}</div>
              )}
            </div>
          ) : (
            messages.map((message, idx) => {
              const prev = messages[idx - 1];
              const timeChanged = !prev || prev.time !== message.time;

              return (
                <div key={message.id}>
                  {timeChanged && <TimeSeparator label={message.time} />}
                  {message.role === "user" ? (
                    <div className="bot-chat-row bot-chat-row--user" data-role="user">
                      <div className="bot-chat-row__stack">
                        <div className="bot-chat-bubble bot-chat-bubble--user">
                          {message.text}
                        </div>
                      </div>
                    </div>
                  ) : message.role === "thinking" ? (
                    <div className="bot-thinking-row">
                      <div className="bot-thinking-row__toggle" aria-hidden="true">
                        <span className="bot-thinking-row__icon" />
                        <span className="bot-thinking-row__label">Thinking…</span>
                      </div>
                      {message.label && (
                        <div className="bot-thinking-row__preview">{message.label}</div>
                      )}
                    </div>
                  ) : message.role === "card" ? (
                    <div
                      className="bot-chat-row bot-chat-row--assistant"
                      data-role="assistant"
                    >
                      <div className="bot-chat-row__stack">
                        <div className="bot-send-card-surface">
                          <div className="bot-send-card" data-card="manual">
                            <div className="bot-send-card__title">{message.card.title}</div>
                            <div className="bot-send-card__lines">
                              {message.card.lines.map((line) => (
                                <div key={line} className="bot-send-card__line">
                                  {line}
                                </div>
                              ))}
                            </div>
                          </div>
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div
                      className="bot-chat-row bot-chat-row--assistant"
                      data-role="assistant"
                    >
                      <div className="bot-chat-row__stack">
                        <div className="bot-chat-bubble bot-chat-bubble--assistant">
                          <div className="bot-bubble-markdown">{message.text}</div>
                        </div>
                      </div>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}