import { useState, useRef, useEffect } from 'react';
import {
  Clock,
  CaretDown,
  Newspaper,
  CalendarCheck,
  ChartLine,
  Plus,
  SquaresFour,
} from '@phosphor-icons/react';
import type { AutomationTemplate } from '@/types/automation';

const ICON_MAP: Record<string, React.ComponentType<{ size?: number; weight?: 'thin' | 'light' | 'regular' | 'bold' | 'fill' | 'duotone'; className?: string; style?: React.CSSProperties }>> = {
  newspaper: Newspaper,
  'calendar-check': CalendarCheck,
  'chart-line': ChartLine,
};

const QUICK_TEMPLATE_IDS = ['daily-brief', 'weekly-review', 'project-monitor'];

interface AutomationEmptyStateProps {
  templates: AutomationTemplate[];
  onQuickTemplate: (template: AutomationTemplate) => void;
  onChatCreate: () => void;
  onManualCreate: () => void;
  onViewTemplates: () => void;
}

export function AutomationEmptyState({
  templates,
  onQuickTemplate,
  onChatCreate,
  onManualCreate,
  onViewTemplates,
}: AutomationEmptyStateProps) {
  const [showDropdown, setShowDropdown] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const quickTemplates = QUICK_TEMPLATE_IDS
    .map((id) => templates.find((t) => t.id === id))
    .filter((t): t is AutomationTemplate => !!t);

  return (
    <div className="flex flex-col items-center justify-center h-full text-center p-8">
      <Clock size={48} className="mb-4 opacity-20" style={{ color: 'var(--muted)' }} />

      <h2 className="text-lg font-semibold mb-1" style={{ color: 'var(--text)' }}>
        Create First Automation
      </h2>
      <p className="text-xs mb-6" style={{ color: 'var(--muted)' }}>
        Describe what you want, or pick a template
      </p>

      {quickTemplates.length > 0 && (
        <div className="flex gap-2 mb-5">
          {quickTemplates.map((template) => {
            const IconComp = ICON_MAP[template.icon] || Plus;
            return (
              <button
                key={template.id}
                type="button"
                className="flex flex-col items-center gap-2 px-4 py-3 rounded-xl transition-all duration-200 w-[140px]"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
                onClick={() => onQuickTemplate(template)}
                onMouseEnter={(e) => {
                  e.currentTarget.style.borderColor = 'var(--accent)';
                  e.currentTarget.style.transform = 'translateY(-2px)';
                  e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.08)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.borderColor = 'var(--border)';
                  e.currentTarget.style.transform = 'translateY(0)';
                  e.currentTarget.style.boxShadow = 'none';
                }}
              >
                <IconComp size={20} weight="fill" style={{ color: 'var(--accent)' }} />
                <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>
                  {template.label_en}
                </span>
                <span className="text-[10px] leading-tight" style={{ color: 'var(--muted)' }}>
                  {template.description_en}
                </span>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center gap-2">
        <div className="relative flex" ref={dropdownRef}>
          <button
            type="button"
            className="flex items-center gap-2 pl-4 pr-3 py-2 rounded-l-lg font-medium text-sm transition-all duration-200"
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
            Create via Chat
          </button>

          <button
            type="button"
            className="flex items-center justify-center px-2 py-2 rounded-r-lg text-sm transition-all duration-200 border-l"
            style={{
              background: 'linear-gradient(140deg, #5f71ff, #7286ff)',
              color: '#ffffff',
              borderColor: 'rgba(255,255,255,0.2)',
            }}
            onClick={() => setShowDropdown(!showDropdown)}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.9'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            <CaretDown size={14} weight="bold" />
          </button>

          {showDropdown && (
            <div
              className="absolute top-full right-0 mt-1 py-1 rounded-lg shadow-lg z-50 min-w-[160px]"
              style={{
                background: 'var(--surface)',
                border: '1px solid var(--border)',
              }}
            >
              <button
                type="button"
                className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--surface-hover)]"
                style={{ color: 'var(--text)' }}
                onClick={() => {
                  setShowDropdown(false);
                  onChatCreate();
                }}
              >
                <Plus size={14} />
                Create via Chat
              </button>
              <button
                type="button"
                className="w-full flex items-center gap-2 text-left px-3 py-2 text-sm transition-colors hover:bg-[var(--surface-hover)]"
                style={{ color: 'var(--text)' }}
                onClick={() => {
                  setShowDropdown(false);
                  onManualCreate();
                }}
              >
                <SquaresFour size={14} />
                Manual Create
              </button>
            </div>
          )}
        </div>

        <button
          type="button"
          className="px-4 py-2 rounded-lg font-medium text-sm transition-all duration-200"
          style={{
            background: 'var(--surface)',
            color: 'var(--text)',
            border: '1px solid var(--border)',
          }}
          onClick={onViewTemplates}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
        >
          View Templates
        </button>
      </div>
    </div>
  );
}