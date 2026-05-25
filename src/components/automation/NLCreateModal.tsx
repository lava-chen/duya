import { useState, useEffect } from 'react';
import { X, Info, SquaresFour } from '@phosphor-icons/react';
import type { AutomationTemplate, CronSchedule, ParsedAutomationConfig, CreateAutomationCronInput } from '@/types/automation';
import { useAutomationParser } from './useAutomationParser';
import { SchedulePicker } from './SchedulePicker';
import type { ModelOption } from '@/components/chat/ModelSelector';

interface NLCreateModalProps {
  isOpen: boolean;
  onClose: () => void;
  onCreate: (data: CreateAutomationCronInput) => void;
  onOpenTemplates: () => void;
  initialTemplate?: AutomationTemplate | null;
  availableModels: ModelOption[];
  modelsLoading: boolean;
}

export function NLCreateModal({
  isOpen,
  onClose,
  onCreate,
  onOpenTemplates,
  initialTemplate,
  availableModels,
  modelsLoading,
}: NLCreateModalProps) {
  const [title, setTitle] = useState('');
  const [prompt, setPrompt] = useState('');
  const [schedule, setSchedule] = useState<CronSchedule>({ kind: 'every', everyMs: 86400000 });
  const [model, setModel] = useState('');
  const [showSettings, setShowSettings] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { parsed, parse } = useAutomationParser();

  useEffect(() => {
    if (initialTemplate) {
      setTitle(initialTemplate.label_en);
      setPrompt(initialTemplate.prompt);
      setSchedule(initialTemplate.defaultSchedule);
      if (initialTemplate.defaultModel) {
        setModel(initialTemplate.defaultModel);
      }
    }
  }, [initialTemplate]);

  useEffect(() => {
    if (!initialTemplate && prompt.trim()) {
      parse(prompt);
    }
  }, [prompt, parse, initialTemplate]);

  useEffect(() => {
    if (parsed && !initialTemplate) {
      if (parsed.name && !title) {
        setTitle(parsed.name);
      }
      setSchedule(parsed.schedule);
    }
  }, [parsed, initialTemplate, title]);

  const handleSubmit = () => {
    setError(null);

    if (!prompt.trim()) {
      setError('Please enter a prompt');
      return;
    }

    if (!model.trim()) {
      setError('Please select a model');
      return;
    }

    onCreate({
      name: title.trim() || `Automation ${new Date().toLocaleDateString()}`,
      prompt: prompt.trim(),
      schedule,
      model: model.trim(),
      inputParams: {},
      concurrencyPolicy: 'skip',
      maxRetries: 3,
      enabled: true,
    });
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

  const activeModel = availableModels.find((m) => m.id === model);
  const modelDisplay = activeModel?.display_name || model || 'Select Model';

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
          maxWidth: '720px',
          width: '90vw',
          minHeight: '400px',
          maxHeight: '80vh',
        }}
      >
        {/* Header */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-b"
          style={{ borderColor: 'var(--border)' }}
        >
          <input
            className="flex-1 bg-transparent text-sm font-medium outline-none"
            style={{ color: 'var(--text)' }}
            placeholder="Automation Title..."
            value={title}
            onChange={(e) => setTitle(e.target.value)}
          />
          <button
            type="button"
            className="p-1.5 rounded-md transition-all duration-150"
            style={{ color: 'var(--muted)' }}
            title="Info"
          >
            <Info size={18} />
          </button>
          <button
            type="button"
            className="p-1.5 rounded-md transition-all duration-150"
            style={{ color: 'var(--muted)' }}
            title="Use Template"
            onClick={onOpenTemplates}
            onMouseEnter={(e) => { e.currentTarget.style.color = 'var(--accent)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = 'var(--muted)'; }}
          >
            <SquaresFour size={18} />
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

        {/* Body */}
        <div className="flex-1 p-4">
          <textarea
            className="w-full h-full min-h-[200px] bg-transparent text-sm outline-none resize-none"
            style={{ color: 'var(--text)' }}
            placeholder="Add prompt, e.g.: Every morning at 9am, summarize yesterday's git commits in $myproject"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={handleKeyDown}
          />
        </div>

        {/* Footer Toolbar */}
        <div
          className="flex items-center gap-3 px-4 py-3 border-t"
          style={{ borderColor: 'var(--border)' }}
        >
          <SchedulePicker schedule={schedule} onChange={setSchedule} />

          <div className="relative">
            <button
              type="button"
              className="flex items-center gap-1.5 px-2 py-1.5 rounded-md text-xs transition-all duration-150"
              style={{
                background: 'var(--surface)',
                color: model ? 'var(--text)' : 'var(--muted)',
                border: '1px solid var(--border)',
              }}
              onClick={() => setShowSettings(!showSettings)}
              onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            >
              <span className="max-w-[120px] truncate">{modelDisplay}</span>
            </button>

            {showSettings && (
              <div
                className="absolute bottom-full right-0 mb-1 py-1 rounded-lg shadow-lg z-50 min-w-[220px] max-h-[200px] overflow-y-auto"
                style={{
                  background: 'var(--surface)',
                  border: '1px solid var(--border)',
                }}
              >
                {modelsLoading ? (
                  <div className="px-3 py-2 text-xs" style={{ color: 'var(--muted)' }}>
                    Loading models...
                  </div>
                ) : availableModels.length === 0 ? (
                  <div className="px-3 py-2 text-xs" style={{ color: 'var(--warning)' }}>
                    No models available
                  </div>
                ) : (
                  availableModels.map((m) => (
                    <button
                      key={m.id}
                      type="button"
                      className="w-full text-left px-3 py-2 text-xs transition-colors hover:bg-[var(--surface-hover)]"
                      style={{
                        color: 'var(--text)',
                        background: m.id === model ? 'var(--accent-soft)' : 'transparent',
                      }}
                      onClick={() => {
                        setModel(m.id);
                        setShowSettings(false);
                      }}
                    >
                      {m.display_name}
                    </button>
                  ))
                )}
              </div>
            )}
          </div>

          <div className="flex-1" />

          {error && (
            <span className="text-xs" style={{ color: 'var(--error)' }}>
              {error}
            </span>
          )}

          <button
            type="button"
            className="px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
            style={{
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
            onClick={onClose}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
          >
            Cancel
          </button>
          <button
            type="button"
            className="px-4 py-1.5 rounded-md text-xs font-medium transition-all duration-200"
            style={{
              background: 'linear-gradient(140deg, #5f71ff, #7286ff)',
              color: '#ffffff',
            }}
            onClick={handleSubmit}
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
            Create
          </button>
        </div>
      </div>
    </div>
  );
}