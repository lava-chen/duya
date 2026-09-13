import { useState, useEffect } from 'react';
import { LightningIcon } from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { Modal } from '@/components/ui/page';
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

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      icon={<LightningIcon size={18} />}
      title={
        initialTemplate
          ? t('automation.quickCreateTemplateTitle', { name: initialTemplate.label_en })
          : t('automation.quickCreateTitle')
      }
      size="md"
      footer={
        <>
          <div className="flex-1">
            {error && (
              <span className="text-xs" style={{ color: 'var(--error)' }}>
                {error}
              </span>
            )}
          </div>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t('automation.cancel')}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSubmit}>
            {t('automation.quickCreateTitle')}
          </Button>
        </>
      }
    >
      <textarea
        className="w-full min-h-[160px] bg-transparent text-sm outline-none resize-none"
        style={{ color: 'var(--text)' }}
        placeholder={t('automation.quickCreatePlaceholder')}
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={handleKeyDown}
        autoFocus
      />
    </Modal>
  );
}