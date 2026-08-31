/**
 * OrbInput — INPUT state.
 *
 * 320x160 输入框,球已消失。布局参考 Grok 回复框的排布（+ 附件、模型
 * 胶囊、语音、发送），视觉保持 duya 自己的浅色玻璃风:
 *
 *   [ textarea                                ]
 *   [chip ×][chip ×]                          （有附件时）
 *   [+] [model pill]              [mic] [↑]
 *
 *   +        → 打开 @ 内容弹窗（与主应用 context popover 同数据源:
 *              已安装 plugins），选中插入 `@<pluginId> `
 *   粘贴     → 图片/文件直接变成附件 chip（与参考回复框一致），
 *              随 submit 走 wakeless files 通道
 *   模型胶囊 → 显示 wakeless 回合实际使用的模型名（automation:orb:chat-config）
 *   语音     → 管线未接,禁用占位
 *
 * Keyboard:
 *   Enter       → submit（与主应用一致）
 *   Shift+Enter → newline
 *   Esc         → 关闭弹窗;无弹窗时由 OrbApp 收起整个输入框
 *   失焦        → 主进程 blur 监听收起整个输入框
 */
import { useRef, useState, useCallback, useEffect } from 'react';
import { PlugIcon } from '@/components/icons';

interface OrbInputProps {
  onSubmit: (text: string, attachments?: string[]) => Promise<void> | void;
}

/** Plugin brand icon for the @ popup: resolved duya-file:// icon, generic plug on failure. */
function PluginMentionIcon({ iconUrl, size = 16 }: { iconUrl?: string; size?: number }) {
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

interface Attachment {
  id: string;
  name: string;
  dataUrl: string;
}

interface MentionItem {
  label: string;
  value: string;
  description?: string;
  /** Resolved `duya-file://` plugin icon URL (undefined → generic plug icon). */
  iconUrl?: string;
}

interface ModelOption {
  providerId: string;
  label: string;
  model: string;
}

/** 单个附件上限（data URL 走 IPC + SSE body,不要把 50MB 塞进去）。 */
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

export function OrbInput({ onSubmit }: OrbInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [model, setModel] = useState<string | null>(null);
  const [modelOptions, setModelOptions] = useState<ModelOption[]>([]);
  const [modelOpen, setModelOpen] = useState(false);
  const modelPopupRef = useRef<HTMLDivElement>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionItems, setMentionItems] = useState<MentionItem[]>([]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 真实模型名 + 可选列表（同一解析路径:wakeless 回合就用它）
  useEffect(() => {
    void Promise.resolve(window.electronAPI?.orb?.chatConfig?.())
      .then((res) => {
        setModel(res?.model ?? null);
        setModelOptions((res?.options ?? []) as ModelOption[]);
      })
      .catch(() => {});
  }, []);

  // 模型弹窗外点击关闭
  useEffect(() => {
    if (!modelOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!modelPopupRef.current?.contains(e.target as Node)) setModelOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [modelOpen]);

  const pickModel = useCallback((opt: ModelOption) => {
    setModel(opt.model);
    setModelOpen(false);
    void window.electronAPI?.orb?.setModel?.({
      providerId: opt.providerId,
      model: opt.model,
    }).catch(() => {});
  }, []);

  // 弹窗外点击关闭
  useEffect(() => {
    if (!mentionOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!popupRef.current?.contains(e.target as Node)) setMentionOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [mentionOpen]);

  // 自增高：随内容长高,超出后内部滚动。
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
        attachments.map((a) => a.dataUrl),
      );
      setText('');
      setAttachments([]);
    } finally {
      setSubmitting(false);
    }
  }, [text, submitting, attachments, onSubmit]);

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
    // 与主应用 context popover 同一数据源:已安装 plugins(每个 plugin 一行)。
    try {
      const api = window.electronAPI?.plugin?.registry;
      if (api) {
        const res = await api.list();
        const items: MentionItem[] = ((res?.data ?? []) as unknown as Array<Record<string, unknown>>)
          .filter((p) => p.enabled !== false)
          .map((p) => {
            const manifest = (p.manifest ?? {}) as Record<string, unknown>;
            const components = (manifest.components ?? {}) as Record<string, unknown>;
            const asList = (v: unknown): string[] =>
              Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
            const skills = asList(components.skills);
            const mcp = asList(components.mcpServers);
            const apps = asList(components.appConnections);
            const labels: string[] = [];
            if (skills.length > 0) labels.push(`${skills.length} skill${skills.length > 1 ? 's' : ''}`);
            if (mcp.length > 0) labels.push(`${mcp.length} MCP server${mcp.length > 1 ? 's' : ''}`);
            if (apps.length > 0) labels.push(`${apps.length} app${apps.length > 1 ? 's' : ''}`);
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

  const insertMention = useCallback((item: MentionItem) => {
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
  }, [text]);

  const addFiles = useCallback((files: File[]) => {
    for (const file of files) {
      if (file.size > MAX_ATTACHMENT_BYTES) continue;
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        setAttachments((prev) =>
          prev.some((a) => a.dataUrl === dataUrl)
            ? prev
            : [...prev, { id: `${file.name}-${Date.now()}`, name: file.name, dataUrl }],
        );
      };
      reader.readAsDataURL(file);
    }
  }, []);

  // 粘贴即附件:图片/文件直接成 chip(与参考回复框的 Screenshot chip 一致)。
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
    <div className="orb-input orb-no-drag" role="dialog" aria-label="Duya 输入">
      <textarea
        ref={inputRef}
        className="orb-input-field"
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          autogrow();
        }}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="问 Duya 任何事..."
        rows={1}
      />

      {attachments.length > 0 && (
        <div className="orb-input-attachments">
          {attachments.map((att) => (
            <span key={att.id} className="orb-input-chip" title={att.name}>
              <span className="orb-input-chip-name">{att.name}</span>
              <button
                type="button"
                className="orb-input-chip-remove"
                onClick={() =>
                  setAttachments((prev) => prev.filter((a) => a.id !== att.id))
                }
                aria-label={`移除 ${att.name}`}
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

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
