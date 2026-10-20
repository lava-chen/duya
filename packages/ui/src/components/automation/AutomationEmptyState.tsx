import {
  ClockIcon,
  PlusIcon,
  SquaresFourIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { EmptyState } from '@/components/ui/page';
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
    <EmptyState
      icon={<ClockIcon size={48} />}
      title={t('automation.emptyTitle')}
      description={t('automation.emptyDesc')}
      action={
        <div className="flex items-center gap-2 flex-wrap justify-center">
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
      }
    />
  );
}
