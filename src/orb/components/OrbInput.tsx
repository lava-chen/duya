/**
 * OrbInput — INPUT state.
 *
 * 280x100 输入框,球已消失。
 * - Top row: attachments chips + remove button
 * - Middle: text input / textarea
 * - Bottom toolbar: model selector + icon buttons (emoji / attachment / AI / mic / hide)
 *
 * Keyboard:
 *   Enter       → submit
 *   Shift+Enter → newline
 *   Esc         → handled by OrbApp (any state → DORMANT)
 *   ↑/↓         → history navigation (caller maintains)
 */
import { useRef, useState, useCallback, useEffect } from 'react';

interface OrbInputProps {
  onSubmit: (text: string, attachments?: string[]) => Promise<void> | void;
}

interface Attachment {
  id: string;
  name: string;
}

export function OrbInput({ onSubmit }: OrbInputProps) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [text, setText] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);

  // Auto-focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (text.trim() || attachments.length) {
          void onSubmit(text.trim(), attachments.map((a) => a.id));
          setText('');
          setAttachments([]);
        }
      }
    },
    [text, attachments, onSubmit],
  );

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  return (
    <div className="orb-input orb-no-drag" role="dialog" aria-label="Duya 输入">
      {attachments.length > 0 && (
        <div className="orb-input-attachments">
          {attachments.map((att) => (
            <span key={att.id} className="orb-input-chip">
              {att.name}
              <button
                className="orb-input-chip-remove"
                onClick={() => removeAttachment(att.id)}
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
        onChange={(e) => setText(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder="问 Duya 任何事..."
        rows={2}
      />

      <div className="orb-input-toolbar">
        <div className="orb-input-icons">
          <button className="orb-input-icon" aria-label="附件" title="附件">
            📎
          </button>
          <button className="orb-input-icon" aria-label="AI 模式" title="AI 模式">
            ✨
          </button>
          <button className="orb-input-icon" aria-label="语音" title="语音(Phase 2)">
            🎙
          </button>
        </div>

        <button className="orb-input-model" title="选择模型">
          GPT-5.6 Luna ▾
        </button>
      </div>
    </div>
  );
}