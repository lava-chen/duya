import { X } from '@phosphor-icons/react';
import type { AutomationTemplate } from '@/types/automation';

interface TemplateMarketModalProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectTemplate: (template: AutomationTemplate) => void;
  onManualSetup: () => void;
  templates: AutomationTemplate[];
}

export function TemplateMarketModal({
  isOpen,
  onClose,
  onSelectTemplate,
  onManualSetup,
  templates,
}: TemplateMarketModalProps) {
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
          maxWidth: '800px',
          width: '90vw',
          maxHeight: '80vh',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center justify-between px-5 py-4 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <h3 className="font-medium text-sm" style={{ color: 'var(--text)' }}>
            Automation Templates
          </h3>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
              style={{
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
              }}
              onClick={onManualSetup}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
            >
              Manual Setup
            </button>
            <button
              type="button"
              className="p-1.5 rounded-md transition-all duration-150"
              style={{ color: 'var(--muted)' }}
              onClick={onClose}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; e.currentTarget.style.color = 'var(--text)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--muted)'; }}
            >
              <X size={18} />
            </button>
          </div>
        </div>

        {/* Body - Template Grid */}
        <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
          {templates.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-center">
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                No templates available. You can create an automation manually.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-4">
              {templates.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  className="flex flex-col items-start gap-3 p-4 rounded-xl text-left transition-all duration-200"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                  }}
                  onClick={() => {
                    onSelectTemplate(template);
                    onClose();
                  }}
                  onMouseEnter={(e) => {
                    e.currentTarget.style.borderColor = 'var(--accent)';
                    e.currentTarget.style.transform = 'translateY(-2px)';
                    e.currentTarget.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.1)';
                  }}
                  onMouseLeave={(e) => {
                    e.currentTarget.style.borderColor = 'var(--border)';
                    e.currentTarget.style.transform = 'translateY(0)';
                    e.currentTarget.style.boxShadow = 'none';
                  }}
                >
                  <div
                    className="flex items-center justify-center w-10 h-10 rounded-lg"
                    style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                  >
                    <span className="text-lg font-semibold">
                      {template.label_en.charAt(0)}
                    </span>
                  </div>
                  <div className="flex-1">
                    <h4 className="font-medium text-sm mb-1" style={{ color: 'var(--text)' }}>
                      {template.label_en}
                    </h4>
                    <p className="text-xs leading-relaxed line-clamp-3" style={{ color: 'var(--muted)' }}>
                      {template.description_en}
                    </p>
                  </div>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}