import { useRef, useCallback, type FormEvent, type KeyboardEvent } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import { ArrowUpIcon, PlusIcon } from '@/components/icons';
import { IconButton } from '../ui/IconButton';
import { VoiceButton } from './VoiceButton';
import { StopIcon } from '@/components/icons';
import { RichTextInput } from './RichTextInput';

interface BotMessageInputProps {
  value: string;
  onChange: (value: string) => void;
  onSend: (content: string) => void;
  onStop?: () => void;
  busy?: boolean;
  disabled?: boolean;
  placeholder?: string;
  onAttach?: () => void;
}

export function BotMessageInput({
  value,
  onChange,
  onSend,
  onStop,
  busy = false,
  disabled = false,
  placeholder,
  onAttach,
}: BotMessageInputProps) {
  const { t } = useTranslation();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const voiceBaseTextRef = useRef('');
  const inputValueRef = useRef(value);
  inputValueRef.current = value;

  const handleSubmit = useCallback(
    (e: FormEvent) => {
      e.preventDefault();
      const trimmedValue = value.trim();
      if (!trimmedValue) return;
      if (disabled) return;
      onSend(trimmedValue);
      onChange('');
    },
    [value, disabled, onSend, onChange],
  );

  const handleKeyDown = useCallback(
    (e: KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        const trimmedValue = value.trim();
        if (trimmedValue) {
          handleSubmit({ preventDefault: () => {} } as FormEvent);
        }
      }
    },
    [value, handleSubmit],
  );

  const handleAttach = useCallback(() => {
    if (onAttach) {
      onAttach();
    } else {
      fileInputRef.current?.click();
    }
  }, [onAttach]);

  const handleFileChange = useCallback(
    async (e: React.ChangeEvent<HTMLInputElement>) => {
      const input = e.target;
      if (!input.files) return;
      input.value = '';
    },
    [],
  );

  const handleInputChange = useCallback(
    (val: string) => {
      onChange(val);
    },
    [onChange],
  );

  const handleVoiceSessionStart = useCallback(() => {
    voiceBaseTextRef.current = inputValueRef.current;
  }, []);

  const handleVoiceTranscription = useCallback((text: string, kind: 'interim' | 'final') => {
    const base = voiceBaseTextRef.current;
    if (kind === 'interim') {
      onChange(base + text);
    } else {
      voiceBaseTextRef.current = base + text;
      onChange(base + text);
    }
  }, [onChange]);

  return (
    <form onSubmit={handleSubmit} className="relative">
      <div
        className="message-input-surface relative z-[1] rounded-3xl p-2 transition-shadow"
        style={{
          backgroundColor: 'var(--composer-bg)',
          boxShadow: 'inset 0 0 0 1px var(--border-color)',
        }}
      >
        {/* Textarea — RichTextInput manages its own height via contentEditable */}
        <RichTextInput
          value={value}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onPaste={() => {}}
          placeholder={placeholder || t('chat.placeholder')}
          disabled={disabled}
        />

        {/* Bottom Toolbar */}
        <div className="mt-1 px-2 flex min-w-0 items-center gap-2">
          <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-visible">
            {/* Plus Button — opens file picker directly */}
            <IconButton
              variant="ghost"
              shape="square"
              size="md"
              aria-label={t('common.settings') || 'Attach'}
              onClick={handleAttach}
              className="text-muted-foreground border-transparent hover:text-foreground hover:bg-accent/50"
              title={t('common.settings') || 'Attach'}
            >
              <PlusIcon size={16} />
            </IconButton>

            {/* Hidden file input */}
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
          </div>

          {/* Right: Send/Stop Button */}
          <div className="flex shrink-0 items-center gap-1">
            <VoiceButton
              disabled={disabled || busy}
              onTranscription={handleVoiceTranscription}
              onNeedsSetup={() => {}}
              onSessionStart={handleVoiceSessionStart}
            />
            {busy && onStop ? (
              <IconButton
                variant="danger"
                shape="round"
                size="md"
                aria-label="Stop"
                onClick={onStop}
                className="bg-red-500/20 text-red-400 hover:bg-red-500/30 ml-1"
                title="Stop"
              >
                <StopIcon size={16} />
              </IconButton>
            ) : (
              <IconButton
                type="submit"
                variant="primary"
                shape="round"
                size="md"
                aria-label="Send"
                title="Send"
                disabled={disabled || !value.trim()}
                className="bg-[var(--send-btn)] hover:bg-[var(--send-btn-hover)] ml-1"
              >
                <ArrowUpIcon size={16} />
              </IconButton>
            )}
          </div>
        </div>
      </div>
    </form>
  );
}
