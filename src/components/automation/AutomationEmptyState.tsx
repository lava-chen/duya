import {
  Clock,
  Plus,
  SquaresFour,
} from '@phosphor-icons/react';
import { useTranslation } from '@/hooks/useTranslation';

interface AutomationEmptyStateProps {
  onChatCreate: () => void;
  onViewTemplates: () => void;
}

export function AutomationEmptyState({
  onChatCreate,
  onViewTemplates,
}: AutomationEmptyStateProps) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <Clock size={48} className="mb-4 opacity-20" style={{ color: 'var(--muted)' }} />

      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text)' }}>
        {t('automation.emptyTitle')}
      </h2>
      <p className="text-xs mb-6" style={{ color: 'var(--muted)' }}>
        {t('automation.emptyDesc')}
      </p>

      <div className="flex items-center gap-2">
        <button
          type="button"
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm whitespace-nowrap transition-all duration-200"
          style={{
            background: 'linear-gradient(140deg, #5f71ff, #7286ff)',
            color: '#ffffff',
          }}
          onClick={onChatCreate}
          onMouseEnter={(e) => {
            e.currentTarget.style.opacity = '0.9';
            e.currentTarget.style.transform = 'translateY(-1px)';
            e.currentTarget.style.boxShadow = '0 4px 12px var(--accent-shadow)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.opacity = '1';
            e.currentTarget.style.transform = 'translateY(0)';
            e.currentTarget.style.boxShadow = 'none';
          }}
        >
          <Plus size={16} weight="bold" />
          {t('automation.newAutomation')}
        </button>

        <button
          type="button"
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm whitespace-nowrap transition-all duration-200"
          style={{
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
          }}
          onClick={onViewTemplates}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
        >
          <SquaresFour size={16} />
          {t('automation.templates')}
        </button>
      </div>
    </div>
  );
}
