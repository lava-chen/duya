/**
 * OrbSessionCard — chat-style session floater.
 *
 * Replaces OrbInput + OrbResult as the INPUT/LOADING/RESULT surface.
 * Layout (Phase B of plan session-floater):
 *
 *   ┌──────────────────────────────────┐
 *   │ orb-name             [+] [⧉] [×] │  ← header
 *   ├──────────────────────────────────┤
 *   │                                  │
 *   │  user bubble (right)             │  ← scrollable stream
 *   │       assistant bubble (left)    │
 *   │           typing dots (LOADING)  │
 *   │       [Insert Tab]   assistant   │
 *   │       assistant bubble (left)    │
 *   │                                  │
 *   ├──────────────────────────────────┤
 *   │ ⚠ banner (redacted)              │  ← optional banner
 *   │ [📎 chip ×]                      │  ← attachments strip
 *   │ ┌────────────────────────────┐   │
 *   │ │ textarea                   │   │  ← input row
 *   │ └────────────────────────┬───┘   │
 *   │ [+ @] [model pill]   [🎙] [↑]   │
 *   └──────────────────────────────────┘
 *
 * Markdown rendering for assistant turns is intentionally pre-wrap for
 * Phase B; MarkdownRenderer integration is deferred to Phase H so we can
 * validate the orb bundle + i18n provider hooks first.
 */
import { useRef, useState, useCallback, useEffect, type ReactNode } from 'react';
import { PlugIcon } from '@/components/icons';
import type { OrbState, ProgressInfo, Turn } from '../types';

interface OrbSessionCardProps {
  messages: Turn[];
  state: OrbState;
  progress: ProgressInfo;
  /** Wake auto-injected text. The renderer owns the final value via
   *  setPendingText; submit clears it after the IPC fires. */
  pendingText: string;
  setPendingText: (text: string) => void;
  /** Wake auto-injected attachment data-URLs (typically a desktop screenshot). */
  pendingAttachments: string[];
  setPendingAttachments: (attachments: string[]) => void;
  /** Shown above the input row when OSContext is redacted and the wake
   *  deliberately suppressed screenshot + context. */
  autoInjectBanner: string | null;
  setAutoInjectBanner: (banner: string | null) => void;
  /** Submit a user turn. Caller pushes the user + empty assistant turn
   *  locally and arms the wakeless chat; this just resolves on accept. */
  onSubmit: (text: string, attachments?: string[]) => Promise<void>;
  /** Reset the conversation (Phase F wires persistence). */
  onNewChat: () => Promise<void>;
  /** Copy the latest assistant message's text to clipboard. */
  onCopyLast: () => Promise<void>;
  /** Collapse to DORMANT (collapses to ball). */
  onClose: () => Promise<void>;
  /** Insert the given text into the focused app input field via nut.js. */
  onInsertTab: (text: string) => Promise<void>;
}

// ── Local input-row types (lifted from OrbInput) ──────────────────────

interface Attachment {
  id: string;
  name: string;
  dataUrl: string;
}

interface MentionItem {
  label: string;
  value: string;
  description?: string;
  iconUrl?: string;
}

interface ModelOption {
  providerId: string;
  label: string;
  model: string;
}

/** Single attachment cap: data URL goes through IPC + SSE body. */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

function PluginMentionIcon({
  iconUrl,
  size = 16,
}: {
  iconUrl?: string;
  size?: number;
}) {
  const [failed, setFailed] = useState(false);
  if (!iconUrl || failed) return <PlugIcon size={size} />;
  return (
    <img
      src={iconUrl}
      width={size}
      height={size}
      alt=""
      style={{ objectFit: 'contain', borderRadius: 4 }}
      onError={() => setFailed(true)}
    />
  );
}

export function OrbSessionCard(props: OrbSessionCardProps) {
  const {
    messages,
    state,
    progress,
    pendingText,
    setPendingText,
    pendingAttachments,
    setPendingAttachments,
    autoInjectBanner,
    setAutoInjectBanner,
    onSubmit,
    onNewChat,
    onCopyLast,
    onClose,
    onInsertTab,
  } = props;

  const streamRef = useRef<HTMLDivElement>(null);

  // ── Header handlers ──────────────────────────────────────────────
  const handleCopyLast = useCallback(async () => {
    const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant');
    if (!lastAssistant?.text) return;
    try {
      await navigator.clipboard.writeText(lastAssistant.text);
    } catch {
      // best-effort
    }
    void onCopyLast();
  }, [messages, onCopyLast]);

  const handleNewChat = useCallback(() => {
    void onNewChat();
  }, [onNewChat]);

  const handleClose = useCallback(() => {
    void onClose();
  }, [onClose]);

  // ── Stream: scroll to bottom on each new chunk ───────────────────
  useEffect(() => {
    if (streamRef.current) {
      streamRef.current.scrollTop = streamRef.current.scrollHeight;
    }
  }, [messages.at(-1)?.text, messages.length]);

  const isLoadingStream =
    state === 'LOADING' &&
    (messages.at(-1)?.role !== 'assistant' || messages.at(-1)?.text === '');

  return (
    <div className="orb-session orb-no-drag" role="dialog" aria-label="Duya 会话">
      <SessionHeader
        onNewChat={handleNewChat}
        onCopyLast={handleCopyLast}
        onClose={handleClose}
        canCopy={
          [...messages].reverse().find((m) => m.role === 'assistant')?.text != null
        }
      />
      <SessionStream
        streamRef={streamRef}
        messages={messages}
        progress={progress}
        state={state}
        isLoadingStream={isLoadingStream}
        onInsertTab={onInsertTab}
      />
      <SessionInputRow
        state={state}
        pendingText={pendingText}
        setPendingText={setPendingText}
        pendingAttachments={pendingAttachments}
        setPendingAttachments={setPendingAttachments}
        autoInjectBanner={autoInjectBanner}
        setAutoInjectBanner={setAutoInjectBanner}
        onSubmit={onSubmit}
      />
    </div>
  );
}

// ── Header ──────────────────────────────────────────────────────────

interface SessionHeaderProps {
  onNewChat: () => void;
  onCopyLast: () => void;
  onClose: () => void;
  canCopy: boolean;
}

function SessionHeader({
  onNewChat,
  onCopyLast,
  onClose,
  canCopy,
}: SessionHeaderProps): ReactNode {
  return (
    <div className="orb-session-header">
      <span className="orb-session-header-title">Duya</span>
      <div className="orb-session-header-actions">
        <button
          type="button"
          className="orb-session-header-btn"
          aria-label="新建会话"
          title="新建会话"
          onClick={onNewChat}
        >
          {/* plus icon */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M12 5v14" />
            <path d="M5 12h14" />
          </svg>
        </button>
        <button
          type="button"
          className="orb-session-header-btn"
          aria-label="复制最后一条助手回复"
          title="复制最后一条助手回复"
          onClick={onCopyLast}
          disabled={!canCopy}
        >
          {/* copy icon */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
          </svg>
        </button>
        <button
          type="button"
          className="orb-session-header-btn"
          aria-label="关闭"
          title="关闭"
          onClick={onClose}
        >
          {/* x icon */}
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M18 6 6 18" />
            <path d="m6 6 12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
}

// ── Stream ──────────────────────────────────────────────────────────

interface SessionStreamProps {
  streamRef: React.RefObject<HTMLDivElement | null>;
  messages: Turn[];
  progress: ProgressInfo;
  state: OrbState;
  isLoadingStream: boolean;
  onInsertTab: (text: string) => Promise<void>;
}

function SessionStream({
  streamRef,
  messages,
  progress,
  state,
  isLoadingStream,
  onInsertTab,
}: SessionStreamProps): ReactNode {
  if (messages.length === 0) {
    return (
      <div className="orb-session-stream" ref={streamRef} aria-live="polite">
        <div className="orb-session-empty">
          {state === 'LOADING' ? (
            <TypingDots />
          ) : (
            <span style={{ color: 'var(--orb-fg-muted)' }}>问 Duya 任何事...</span>
          )}
        </div>
      </div>
    );
  }
  // Deduplicate by id: use index as fallback key when ids collide.
  // A Collided id means the same turn was appended twice (e.g. concurrent
  // submits + rejection rollback), which React would otherwise silently drop.
  const seenIds = new Set<string>();
  return (
    <div className="orb-session-stream" ref={streamRef} aria-live="polite">
      {messages.map((m, i) => {
        const key = seenIds.has(m.id) ? `idx-${i}` : m.id;
        seenIds.add(m.id);
        return (
          <MessageBubble
            key={key}
            turn={m}
            isLast={i === messages.length - 1}
            isLoadingLast={isLoadingStream && i === messages.length - 1}
            onInsertTab={onInsertTab}
            progressLabel={progress.label}
          />
        );
      })}
    </div>
  );
}

interface MessageBubbleProps {
  turn: Turn;
  isLast: boolean;
  isLoadingLast: boolean;
  onInsertTab: (text: string) => Promise<void>;
  progressLabel: string | null;
}

function MessageBubble({
  turn,
  isLast,
  isLoadingLast,
  onInsertTab,
  progressLabel,
}: MessageBubbleProps): ReactNode {
  const [inserting, setInserting] = useState(false);
  const [insertError, setInsertError] = useState<string | null>(null);

  const handleInsert = useCallback(async () => {
    if (!turn.text) return;
    setInserting(true);
    setInsertError(null);
    try {
      await onInsertTab(turn.text);
    } catch (e) {
      setInsertError(e instanceof Error ? e.message : '插入失败');
    } finally {
      setInserting(false);
    }
  }, [turn.text, onInsertTab]);

  const isUser = turn.role === 'user';
  const showTyping = isLoadingLast && !isUser && turn.text === '';

  return (
    <div
      className={
        isUser ? 'orb-message orb-message--user' : 'orb-message orb-message--assistant'
      }
    >
      {turn.attachments && turn.attachments.length > 0 && (
        <div className="orb-message-attachments">
          {turn.attachments.map((url, idx) => (
            <img
              key={idx}
              src={url}
              alt="附件"
              className="orb-message-attachment-img"
            />
          ))}
        </div>
      )}
      {showTyping ? (
        <TypingDots label={progressLabel} />
      ) : (
        <div className="orb-message-text">
          {turn.text || (isUser ? '' : '...')}
        </div>
      )}
      {!isUser && turn.text && (
        <div className="orb-message-footer">
          {insertError && (
            <span style={{ color: 'var(--orb-state-error)', fontSize: 11 }}>
              {insertError}
            </span>
          )}
          <button
            type="button"
            className="orb-message-insert"
            onClick={() => void handleInsert()}
            disabled={inserting}
            aria-label="插入到当前输入框 (Tab)"
            title="把这条回复输入到当前 App 输入框"
          >
            {inserting ? '插入中…' : 'Insert Tab'}
          </button>
        </div>
      )}
    </div>
  );
}

function TypingDots({ label }: { label?: string | null }): ReactNode {
  return (
    <div className="orb-stream-typing" aria-label={label ?? '思考中'}>
      {label && <span className="orb-stream-typing-label">{label}</span>}
      <span className="orb-stream-typing-dot" />
      <span className="orb-stream-typing-dot" />
      <span className="orb-stream-typing-dot" />
    </div>
  );
}

// ── Input row ───────────────────────────────────────────────────────

interface SessionInputRowProps {
  state: OrbState;
  pendingText: string;
  setPendingText: (text: string) => void;
  pendingAttachments: string[];
  setPendingAttachments: (attachments: string[]) => void;
  autoInjectBanner: string | null;
  setAutoInjectBanner: (banner: string | null) => void;
  onSubmit: (text: string, attachments?: string[]) => Promise<void>;
}

function SessionInputRow({
  state,
  pendingText,
  setPendingText,
  pendingAttachments,
  setPendingAttachments,
  autoInjectBanner,
  setAutoInjectBanner,
  onSubmit,
}: SessionInputRowProps): ReactNode {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const modelPopupRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState(pendingText);
  const [submitting, setSubmitting] = useState(false);
  const [localAttachments, setLocalAttachments] = useState<Attachment[]>(() =>
    pendingAttachments.map((dataUrl, idx) => ({
      id: `auto-${idx}`,
      name: idx === 0 ? '桌面截图' : `附件 ${idx}`,
      dataUrl,
    })),
  );
  const [model, setModel] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);

  // Re-seed `text` whenever the parent bumps pendingText (a new wake
  // auto-injected the context preamble). No key={epoch} remount — that
  // caused the test fireEvent to race with a pending React rerender and
  // drop the keystroke. The autogrow handler in onChange keeps the height
  // correct after each keystroke.
  useEffect(() => {
    setText(pendingText);
  }, [pendingText]);
  useEffect(() => {
    setLocalAttachments(
      pendingAttachments.map((dataUrl, idx) => ({
        id: `auto-${idx}`,
        name: idx === 0 ? '桌面截图' : `附件 ${idx}`,
        dataUrl,
      })),
    );
    setAutoInjectBanner(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingAttachments]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    void Promise.resolve(window.electronAPI?.orb?.chatConfig?.())
      .then((res) => {
        setModel(res?.model ?? null);
        setModelOptions((res?.options ?? []) as ModelOption[]);
      })
      .catch(() => {});
  }, []);

  // Outside-click handlers (mention + model popups)
  useEffect(() => {
    if (!modelOpen && !mentionOpen) return;
    const onDown = (e: MouseEvent) => {
      if (
        modelOpen &&
        modelPopupRef.current &&
        !modelPopupRef.current.contains(e.target as Node)
      ) {
        setModelOpen(false);
      }
      if (
        mentionOpen &&
        popupRef.current &&
        !popupRef.current.contains(e.target as Node)
      ) {
        setMentionOpen(false);
      }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [modelOpen, mentionOpen]);

  const pickModel = useCallback((opt: ModelOption) => {
    setModel(opt.model);
    setModelOpen(false);
    void window.electronAPI?.orb?.setModel?.({
      providerId: opt.providerId,
      model: opt.model,
    }).catch(() => {});
  }, []);

  const autogrow = useCallback(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 96)}px`;
  }, []);

  const send = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed || submitting) return;
    setSubmitting(true);
    try {
      await onSubmit(
        trimmed,
        localAttachments.map((a) => a.dataUrl),
      );
      setText('');
      setLocalAttachments([]);
      setPendingText('');
      setPendingAttachments([]);
    } finally {
      setSubmitting(false);
    }
  }, [
    text,
    submitting,
    localAttachments,
    onSubmit,
    setPendingText,
    setPendingAttachments,
  ]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void send();
      }
    },
    [send],
  );

  const openMentionPopup = useCallback(async () => {
    if (mentionOpen) {
      setMentionOpen(false);
      return;
    }
    try {
      const api = window.electronAPI?.plugin?.registry;
      if (api) {
        const res = await api.list();
        const items: MentionItem[] = (
          (res?.data ?? []) as unknown as Array<Record<string, unknown>>
        )
          .filter((p) => p.enabled !== false)
          .map((p) => {
            const manifest = (p.manifest ?? {}) as Record<string, unknown>;
            const components = (manifest.components ?? {}) as Record<string, unknown>;
            const asList = (v: unknown): string[] =>
              Array.isArray(v)
                ? v.filter((x): x is string => typeof x === 'string')
                : [];
            const skills = asList(components.skills);
            const mcp = asList(components.mcpServers);
            const apps = asList(components.appConnections);
            const labels: string[] = [];
            if (skills.length > 0)
              labels.push(`${skills.length} skill${skills.length > 1 ? 's' : ''}`);
            if (mcp.length > 0)
              labels.push(`${mcp.length} MCP server${mcp.length > 1 ? 's' : ''}`);
            if (apps.length > 0)
              labels.push(`${apps.length} app${apps.length > 1 ? 's' : ''}`);
            const capability = labels.join(' · ');
            const description = String(p.description ?? '');
            return {
              label: String(p.name ?? p.id),
              value: String(p.id),
              iconUrl: typeof p.icon === 'string' && p.icon ? p.icon : undefined,
              description: capability
                ? description
                  ? `${capability} — ${description}`
                  : capability
                : description || undefined,
            };
          });
        setMentionItems(items);
      }
    } catch {
      setMentionItems([]);
    }
    setMentionOpen(true);
  }, [mentionOpen]);

  const insertMention = useCallback(
    (item: MentionItem) => {
      const el = inputRef.current;
      const token = `@${item.value} `;
      if (el) {
        const at = el.selectionStart ?? text.length;
        const next = `${text.slice(0, at)}${token}${text.slice(at)}`;
        setText(next);
        requestAnimationFrame(() => {
          el.focus();
          const pos = at + token.length;
          el.setSelectionRange(pos, pos);
        });
      } else {
        setText(`${text}${token}`);
      }
      setMentionOpen(false);
    },
    [text],
  );

  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setLocalAttachments((prev) =>
          prev.some((a) => a.dataUrl === dataUrl)
            ? prev
            : [
                ...prev,
                {
                  id: `${file.name}-${Date.now()}`,
                  name: file.name,
                  dataUrl,
                },
              ],
        );
      };
      reader.readAsDataURL(file);
    }
  }, []);

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(e.clipboardData?.files ?? []);
      if (files.length === 0) return;
      e.preventDefault();
      addFiles(files);
    },
    [addFiles],
  );

  return (
    <div className="orb-session-input" data-state={state}>
      {autoInjectBanner && (
        <div className="orb-session-banner" role="status">
          <span>{autoInjectBanner}</span>
          <button
            type="button"
            aria-label="关闭提示"
            onClick={() => setAutoInjectBanner(null)}
          >
            ×
          </button>
        </div>
      )}

      {localAttachments.length > 0 && (
        <div className="orb-input-attachments">
          {localAttachments.map((att) => (
            <span
              key={att.id}
              className="orb-input-chip"
              title={att.name}
              data-auto={att.id.startsWith('auto-') ? 'true' : undefined}
            >
              <span className="orb-input-chip-name">{att.name}</span>
              <button
                type="button"
                className="orb-input-chip-remove"
                onClick={() =>
                  setLocalAttachments((prev) =>
                    prev.filter((a) => a.id !== att.id),
                  )
                }
                aria-label={`移除 ${att.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      <textarea
        ref={inputRef}
        className="orb-input-field"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setPendingText(e.target.value);
          autogrow();
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="问 Duya 任何事..."
        rows={1}
      />

      <div className="orb-input-toolbar">
        <div className="orb-input-toolbar-left">
          <div className="orb-input-mention-anchor">
            <button
              type="button"
              className="orb-pill"
              onClick={() => void openMentionPopup()}
              aria-label="添加内容 (@)"
              title="添加 @ 内容"
            >
              +
            </button>
            {mentionOpen && (
              <div className="orb-mention-popup" ref={popupRef}>
                {mentionItems.length === 0 ? (
                  <div className="orb-mention-empty">没有可 @ 的内容</div>
                ) : (
                  mentionItems.map((item) => (
                    <button
                      key={item.value}
                      type="button"
                      className="orb-mention-item"
                      onClick={() => insertMention(item)}
                      title={item.description ?? item.label}
                    >
                      <span className="orb-mention-icon">
                        <PluginMentionIcon iconUrl={item.iconUrl} />
                      </span>
                      <span className="orb-mention-label">{item.label}</span>
                      {item.description && (
                        <span className="orb-mention-desc">{item.description}</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="orb-input-mention-anchor" ref={modelPopupRef}>
            <button
              type="button"
              className="orb-pill orb-pill-model"
              onClick={() => setModelOpen((v) => !v)}
              aria-label="选择模型"
              title={model ? `当前模型：${model}` : '选择模型'}
            >
              {model ?? '选择模型'} ▾
            </button>
            {modelOpen && (
              <div className="orb-mention-popup">
                {modelOptions.length === 0 ? (
                  <div className="orb-mention-empty">没有可选模型</div>
                ) : (
                  modelOptions.map((opt) => (
                    <button
                      key={`${opt.providerId}:${opt.model}`}
                      type="button"
                      className="orb-mention-item"
                      onClick={() => pickModel(opt)}
                      title={`${opt.label} · ${opt.model}`}
                    >
                      <span className="orb-mention-label">{opt.model}</span>
                      <span className="orb-mention-desc">{opt.label}</span>
                      {opt.model === model && (
                        <span className="orb-mention-check">✓</span>
                      )}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>
        </div>

        <div className="orb-input-toolbar-right">
          <button
            type="button"
            className="orb-pill orb-pill-muted"
            disabled
            aria-label="语音（即将支持）"
            title="语音（即将支持）"
          >
            🎙
          </button>
          <button
            type="button"
            className="orb-input-send"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => void send()}
            disabled={submitting || !text.trim()}
            aria-label="Send"
            title="Send"
          >
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M12 19V5" />
              <path d="m5 12 7-7 7 7" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}