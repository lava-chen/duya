import {
  ClockIcon,
  PlusIcon,
  SquaresFourIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { useTranslation } from '@/hooks/useTranslation';

interface AutomationEmptyStateProps {
  onManualCreate: () => void;
  onChatCreate: () => void;
  onViewTemplates: () => void;
}

export function AutomationEmptyState({
  onManualCreate,
  onChatCreate,
  onViewTemplates,
}: AutomationEmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <ClockIcon size={48} className="mb-4 opacity-20" style={{ color: 'var(--muted)' }} />

      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text)' }}>
        {t('automation.emptyTitle')}
      </h2>
      <p className="text-xs mb-6" style={{ color: 'var(--muted)' }}>
        {t('automation.emptyDesc')}
      </p>

      <div className="flex items-center gap-2">
        <Button
          variant="primary"
          size="md"
          className="whitespace-nowrap"
          onClick={onManualCreate}
        >
          <PlusIcon size={16} />
          {t('automation.newAutomation')}
        </Button>

        <Button
          variant="secondary"
          size="md"
          className="whitespace-nowrap"
          onClick={onChatCreate}
        >
          通过对话创建
        </Button>

        <Button
          variant="secondary"
          size="md"
          className="whitespace-nowrap"
          onClick={onViewTemplates}
        >
          <SquaresFourIcon size={16} />
          {t('automation.templates')}
        </Button>
      </div>
    </div>
  );
}
