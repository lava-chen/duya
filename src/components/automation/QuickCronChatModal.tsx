import { useState, useEffect } from 'react';
import { XIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import type { AutomationTemplate } from '@/types/automation';
import { useTranslation } from '@/hooks/useTranslation';

interface QuickCronChatModalProps {
  isOpen: boolean;
  onClose: () => void;
  onStartChat: (userPrompt: string, templatePrompt?: string) => void;
  initialTemplate?: AutomationTemplate | null;
}

export function QuickCronChatModal({
  isOpen,
  onClose,
  onStartChat,
  initialTemplate,
}: QuickCronChatModalProps) {
  const { t } = useTranslation();
  const [prompt, setPrompt] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (initialTemplate) {
      setPrompt(`${initialTemplate.label_en}: ${initialTemplate.description_en}`);
    } else {
      setPrompt('');
    }
  }, [initialTemplate]);

  const handleSubmit = () => {
    setError(null);

    const trimmed = prompt.trim();
    if (!trimmed) {
      setError(t('automation.quickCreateEmptyError'));
      return;
    }

    onStartChat(trimmed, initialTemplate?.prompt);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      if (prompt.trim()) {
        handleSubmit();
      }
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: 'rgba(0, 0, 0, 0.5)' }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        className="rounded-xl shadow-2xl flex flex-col overflow-hidden"
        style={{
          background: 'var(--main-bg)',
          border: '1px solid var(--border)',
          maxWidth: '640px',
          width: '90vw',
          minHeight: '280px',
          maxHeight: '70vh',
        }}
      >
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <span className="flex-1 text-sm font-medium" style={{ color: 'var(--text)' }}>
            {initialTemplate ? t('automation.quickCreateTemplateTitle', { name: initialTemplate.label_en }) : t('automation.quickCreateTitle')}
          </span>
          <IconButton
            variant="default"
            size="sm"
            shape="square"
            aria-label="Close"
            onClick={onClose}
          >
            <XIcon size={18} />
          </IconButton>
        </div>

        <div className="flex-1 p-4">
          <textarea
            className="w-full h-full min-h-[160px] bg-transparent text-sm outline-none resize-none"
            style={{ color: 'var(--text)' }}
            placeholder={t('automation.quickCreatePlaceholder')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
            autoFocus
          />
        </div>

        <div
          className="flex items-center gap-3 px-4 py-3 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          <div className="flex-1" />

          {error && (
            <span className="text-xs" style={{ color: 'var(--error)' }}>
              {error}
            </span>
          )}

          <Button
            variant="secondary"
            size="sm"
            onClick={onClose}
          >
            {t('automation.cancel')}
          </Button>
          <Button
            variant="primary"
            size="sm"
            onClick={handleSubmit}
          >
            {t('automation.quickCreateTitle')}
          </Button>
        </div>
      </div>
    </div>
  );
}