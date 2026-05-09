import { useEffect, useMemo, useState, useCallback } from 'react';
import type {
  AutomationCron,
  AutomationCronRun,
  ConcurrencyPolicy,
  CreateAutomationCronInput,
  CronScheduleKind,
} from '@/types/automation';
import {
  createAutomationCronIPC,
  deleteAutomationCronIPC,
  listAutomationCronRunsIPC,
  listAutomationCronsIPC,
  runAutomationCronIPC,
  updateAutomationCronIPC,
} from '@/lib/automation-ipc';
import { CronChatModal } from './CronChatModal';
import { ModelSelector, type ModelOption } from '@/components/chat/ModelSelector';
import { listProvidersIPC, getOllamaModelsIPC, type Provider } from '@/lib/ipc-client';
import { Plus, Play, PencilSimple, Trash, Clock, Calendar, Timer, SlidersHorizontal, WarningCircle, CheckCircle, XCircle, SpinnerGap, Gear, ChatCircle, Robot } from '@phosphor-icons/react';

type EditorState = {
  id?: string;
  name: string;
  description: string;
  scheduleKind: CronScheduleKind;
  at: string;
  everyMs: string;
  cronExpr: string;
  cronTz: string;
  prompt: string;
  inputParams: string;
  concurrencyPolicy: ConcurrencyPolicy;
  maxRetries: string;
  enabled: boolean;
  model: string;
};

function formatTime(value: number | null): string {
  if (!value) return '-';
  return new Date(value).toLocaleString();
}

function getScheduleDisplay(cron: AutomationCron): string {
  switch (cron.schedule_kind) {
    case 'every':
      return `Every ${cron.schedule_every_ms ? cron.schedule_every_ms / 1000 : '?'}s`;
    case 'at':
      return `At ${cron.schedule_at || '?'}`;
    case 'cron':
      return cron.schedule_cron_expr || '?';
    default:
      return 'Unknown';
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'enabled':
      return <CheckCircle size={14} weight="fill" className="text-[var(--success)]" />;
    case 'error':
      return <WarningCircle size={14} weight="fill" className="text-[var(--error)]" />;
    case 'disabled':
    default:
      return <XCircle size={14} weight="fill" className="text-[var(--muted)]" />;
  }
}

function getRunStatusIcon(status: string) {
  switch (status) {
    case 'success':
      return <CheckCircle size={14} weight="fill" className="text-[var(--success)]" />;
    case 'failed':
      return <XCircle size={14} weight="fill" className="text-[var(--error)]" />;
    case 'running':
      return <SpinnerGap size={14} className="animate-spin text-[var(--accent)]" />;
    case 'pending':
      return <Clock size={14} className="text-[var(--warning)]" />;
    case 'cancelled':
    default:
      return <XCircle size={14} className="text-[var(--muted)]" />;
  }
}

const DEFAULT_EDITOR: EditorState = {
  name: '',
  description: '',
  scheduleKind: 'every',
  at: '',
  everyMs: '60000',
  cronExpr: '*/5 * * * *',
  cronTz: '',
  prompt: '',
  inputParams: '{}',
  concurrencyPolicy: 'skip',
  maxRetries: '3',
  enabled: true,
  model: '',
};

export function AutomationView() {
  const hasElectronApi = typeof window !== 'undefined' && !!window.electronAPI?.automation;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crons, setCrons] = useState<AutomationCron[]>([]);
  const [selectedCronId, setSelectedCronId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationCronRun[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  // Cron chat modal state
  const [chatModalOpen, setChatModalOpen] = useState(false);
  const [selectedRun, setSelectedRun] = useState<AutomationCronRun | null>(null);

  // Models state
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

  const selectedCron = useMemo(
    () => crons.find((item) => item.id === selectedCronId) ?? null,
    [crons, selectedCronId],
  );

  // Fetch available models from providers
  const fetchModels = useCallback(async () => {
    setModelsLoading(true);
    try {
      const providers = await listProvidersIPC();
      if (providers && providers.length > 0) {
        // Fix the hasApiKey field if it's missing
        providers.forEach((p) => {
          const pAny = p as Provider & Record<string, unknown>;
          const hasKey = pAny.hasApiKey ?? pAny.has_api_key ?? !!(p.apiKey && p.apiKey.length > 0);
          if (pAny.hasApiKey === undefined && hasKey) {
            (p as Provider & { hasApiKey: boolean }).hasApiKey = hasKey;
          }
        });
        const activeProvider = providers.find((p) => p.isActive && p.hasApiKey)
          || providers.find((p) => p.hasApiKey);

        if (activeProvider) {
          // Check if this is an Ollama provider
          const isOllama = activeProvider.providerType === 'ollama' ||
            activeProvider.baseUrl?.includes('11434') ||
            activeProvider.baseUrl?.includes('ollama');

          // For Ollama, fetch local models
          if (isOllama) {
            try {
              const baseUrl = activeProvider.baseUrl || 'http://localhost:11434';
              const result = await getOllamaModelsIPC(baseUrl);
              if (result.success && result.models && result.models.length > 0) {
                setAvailableModels(result.models.map(m => ({
                  id: m.id,
                  display_name: m.name,
                })));
                setModelsLoading(false);
                return;
              }
            } catch (err) {
              console.error('[AutomationView] Error fetching Ollama models:', err);
            }
          }

          // Check if provider has enabled_models in options
          let enabledModels: string[] = [];
          try {
            const opts = JSON.parse(activeProvider.options || '{}');
            if (opts.enabled_models && Array.isArray(opts.enabled_models) && opts.enabled_models.length > 0) {
              enabledModels = opts.enabled_models;
            }
          } catch { /* ignore */ }

          if (enabledModels.length > 0) {
            setAvailableModels(enabledModels.map(id => {
              const cleanId = id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
              return { id: cleanId, display_name: cleanId };
            }));
            setModelsLoading(false);
            return;
          }

          // No models available - show empty list
          setAvailableModels([]);
        }
      }
    } catch (err) {
      console.error('[AutomationView] Error fetching models:', err);
    } finally {
      setModelsLoading(false);
    }
  }, []);

  useEffect(() => {
    if (hasElectronApi) {
      void fetchModels();
    }
  }, [hasElectronApi, fetchModels]);

  const handleOpenChat = (run: AutomationCronRun) => {
    if (run.session_id) {
      setSelectedRun(run);
      setChatModalOpen(true);
    }
  };

  const handleCloseChat = () => {
    setChatModalOpen(false);
    setSelectedRun(null);
  };

  async function reloadCrons(nextSelectedId?: string | null): Promise<void> {
    const list = await listAutomationCronsIPC();
    setCrons(list);
    const candidate = nextSelectedId ?? selectedCronId;
    const validId = candidate && list.some((item) => item.id === candidate) ? candidate : list[0]?.id ?? null;
    setSelectedCronId(validId);
  }

  async function reloadRuns(cronId: string | null): Promise<void> {
    if (!cronId) {
      setRuns([]);
      return;
    }
    const list = await listAutomationCronRunsIPC(cronId, 20, 0);
    setRuns(list);
  }

  useEffect(() => {
    if (!hasElectronApi) {
      setLoading(false);
      setError('Automation is only available in Electron runtime.');
      return;
    }
    void (async () => {
      try {
        setError(null);
        await reloadCrons();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hasElectronApi]);

  useEffect(() => {
    if (!hasElectronApi) return;
    void reloadRuns(selectedCronId);
  }, [hasElectronApi, selectedCronId]);

  function handleCreateNew(): void {
    setIsCreating(true);
    setSelectedCronId(null);
  }

  function handleSelectCron(cron: AutomationCron): void {
    setIsCreating(false);
    setSelectedCronId(cron.id);
  }

  async function runNow(cron: AutomationCron): Promise<void> {
    if (!hasElectronApi) return;
    try {
      setError(null);
      await runAutomationCronIPC(cron.id);
      await reloadCrons(cron.id);
      await reloadRuns(cron.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function removeCron(cron: AutomationCron): Promise<void> {
    if (!hasElectronApi) return;
    try {
      setError(null);
      await deleteAutomationCronIPC(cron.id);
      await reloadCrons();
      if (selectedCronId === cron.id) {
        setSelectedCronId(null);
        setRuns([]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-[var(--border)]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl flex items-center justify-center" style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}>
            <Clock size={20} weight="duotone" />
          </div>
          <div>
            <h2 className="text-lg font-semibold" style={{ color: 'var(--text)' }}>Automation</h2>
            <p className="text-xs" style={{ color: 'var(--muted)' }}>Schedule and manage cron jobs</p>
          </div>
        </div>
        <button
          className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm transition-all duration-200"
          style={{
            background: 'linear-gradient(140deg, #5f71ff, #7286ff)',
            color: '#ffffff',
          }}
          onClick={handleCreateNew}
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
          type="button"
        >
          <Plus size={16} weight="bold" />
          New Cron
        </button>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-6 mt-4 px-4 py-3 rounded-lg flex items-center gap-2" style={{ background: 'var(--error-soft)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <WarningCircle size={16} className="text-[var(--error)]" />
          <span className="text-sm" style={{ color: 'var(--error)' }}>{error}</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-hidden p-6">
        <div className="h-full grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Cron Jobs List - Left Side */}
          <section className="flex flex-col h-full rounded-xl overflow-hidden lg:col-span-1" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between" style={{ background: 'var(--surface)' }}>
              <h3 className="font-medium text-sm" style={{ color: 'var(--text)' }}>Cron Jobs</h3>
              <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
                {crons.length}
              </span>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {loading ? (
                <div className="flex items-center justify-center h-32" style={{ color: 'var(--muted)' }}>
                  <SpinnerGap size={20} className="animate-spin mr-2" />
                  Loading...
                </div>
              ) : crons.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-center p-4">
                  <Clock size={32} className="mb-2 opacity-30" style={{ color: 'var(--muted)' }} />
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>No cron jobs yet</p>
                  <p className="text-xs mt-1" style={{ color: 'var(--muted)', opacity: 0.7 }}>Click "New Cron" to create one</p>
                </div>
              ) : (
                <div>
                  {crons.map((cron) => (
                    <div
                      key={cron.id}
                      className="px-4 py-3 cursor-pointer transition-all duration-200 border-b border-[var(--border)] last:border-b-0"
                      style={{
                        background: selectedCronId === cron.id && !isCreating ? 'var(--accent-soft)' : 'transparent',
                      }}
                      onClick={() => handleSelectCron(cron)}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter' || event.key === ' ') {
                          handleSelectCron(cron);
                        }
                      }}
                      role="button"
                      tabIndex={0}
                    >
                      <div className="flex items-center justify-between mb-1">
                        <div className="flex items-center gap-2 min-w-0">
                          {getStatusIcon(cron.status)}
                          <span className="font-medium text-sm truncate" style={{ color: 'var(--text)' }}>{cron.name}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 text-xs ml-5" style={{ color: 'var(--muted)' }}>
                        <span className="flex items-center gap-1">
                          <Timer size={11} />
                          {getScheduleDisplay(cron)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar size={11} />
                          {formatTime(cron.next_run_at).split(' ')[0]}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Detail/Editor Panel - Right Side */}
          <section className="flex flex-col h-full rounded-xl overflow-hidden lg:col-span-2" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            {isCreating ? (
              <CronEditor
                availableModels={availableModels}
                modelsLoading={modelsLoading}
                onSave={async (data) => {
                  if (!hasElectronApi) return;
                  try {
                    setSaving(true);
                    setError(null);
                    const created = await createAutomationCronIPC(data as CreateAutomationCronInput);
                    await reloadCrons(created.id);
                    setIsCreating(false);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setSaving(false);
                  }
                }}
                onCancel={() => setIsCreating(false)}
                saving={saving}
              />
            ) : selectedCron ? (
              <CronDetail
                cron={selectedCron}
                runs={runs}
                availableModels={availableModels}
                modelsLoading={modelsLoading}
                onRun={() => void runNow(selectedCron)}
                onDelete={() => void removeCron(selectedCron)}
                onUpdate={async (id, data) => {
                  if (!hasElectronApi) return;
                  try {
                    setSaving(true);
                    setError(null);
                    await updateAutomationCronIPC(id, data);
                    await reloadCrons(id);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                  } finally {
                    setSaving(false);
                  }
                }}
                saving={saving}
                onViewSession={handleOpenChat}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <div className="w-16 h-16 rounded-2xl flex items-center justify-center mb-4" style={{ background: 'var(--surface)' }}>
                  <Gear size={32} style={{ color: 'var(--muted)' }} />
                </div>
                <p className="text-base font-medium mb-1" style={{ color: 'var(--text)' }}>Select a cron job</p>
                <p className="text-sm" style={{ color: 'var(--muted)' }}>Choose a cron job from the list to view details and runs</p>
              </div>
            )}
          </section>
        </div>
      </div>

      {/* Cron Chat Modal */}
      {chatModalOpen && selectedRun && selectedCron && (
        <CronChatModal
          sessionId={selectedRun.session_id!}
          sessionTitle={`[Cron] ${selectedCron.name} - ${selectedRun.run_status}`}
          cronName={selectedCron.name}
          runStatus={selectedRun.run_status}
          onClose={handleCloseChat}
        />
      )}
    </div>
  );
}

// Cron Editor Component
interface CronEditorProps {
  onSave: (data: CreateAutomationCronInput) => void;
  onCancel: () => void;
  saving: boolean;
  initialData?: EditorState;
  availableModels: ModelOption[];
  modelsLoading: boolean;
}

function CronEditor({ onSave, onCancel, saving, initialData, availableModels, modelsLoading }: CronEditorProps) {
  const [editor, setEditor] = useState<EditorState>(initialData || DEFAULT_EDITOR);
  const [modelError, setModelError] = useState<string | null>(null);

  const handleSubmit = () => {
    setModelError(null);

    if (!editor.model || !editor.model.trim()) {
      setModelError('Please select a model');
      return;
    }

    const parsedParams = editor.inputParams ? JSON.parse(editor.inputParams) : {};
    const maxRetries = Number(editor.maxRetries || '3');
    const schedule =
      editor.scheduleKind === 'at'
        ? { kind: 'at' as const, at: editor.at }
        : editor.scheduleKind === 'every'
          ? { kind: 'every' as const, everyMs: Number(editor.everyMs) }
          : { kind: 'cron' as const, cronExpr: editor.cronExpr, cronTz: editor.cronTz || null };

    onSave({
      name: editor.name,
      description: editor.description || null,
      schedule,
      prompt: editor.prompt,
      model: editor.model.trim(),
      inputParams: parsedParams as Record<string, unknown>,
      concurrencyPolicy: editor.concurrencyPolicy,
      maxRetries,
      enabled: editor.enabled,
    });
  };

  return (
    <>
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between" style={{ background: 'var(--surface)' }}>
        <h3 className="font-medium text-sm" style={{ color: 'var(--text)' }}>
          {initialData?.id ? 'Edit Cron Job' : 'Create New Cron Job'}
        </h3>
        <button
          className="p-1.5 rounded-md transition-all duration-150"
          style={{ color: 'var(--muted)' }}
          onClick={onCancel}
          onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; e.currentTarget.style.color = 'var(--text)'; }}
          onMouseLeave={(e) => { e.currentTarget.style.background = 'transparent'; e.currentTarget.style.color = 'var(--muted)'; }}
        >
          <XCircle size={18} />
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4 scrollbar-thin">
        <div className="space-y-4">
          {/* Name & Description */}
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>Name</label>
              <input
                className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                style={{
                  background: 'var(--main-bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
                placeholder="Enter cron job name"
                value={editor.name}
                onChange={(event) => setEditor((prev) => ({ ...prev, name: event.target.value }))}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>Description</label>
              <input
                className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                style={{
                  background: 'var(--main-bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
                placeholder="Optional description"
                value={editor.description}
                onChange={(event) => setEditor((prev) => ({ ...prev, description: event.target.value }))}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
              />
            </div>
          </div>

          {/* Model Selection */}
          <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-3">
              <Robot size={14} style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>Model</span>
              <span className="text-xs" style={{ color: 'var(--error)' }}>*</span>
            </div>
            <ModelSelector
              models={availableModels}
              selectedModelId={editor.model}
              onSelect={(modelId) => setEditor((prev) => ({ ...prev, model: modelId }))}
              loading={modelsLoading}
              variant="full"
            />
            {modelError && (
              <div className="text-xs mt-2" style={{ color: 'var(--error)' }}>
                {modelError}
              </div>
            )}
            {availableModels.length === 0 && !modelsLoading && (
              <div className="text-xs mt-2" style={{ color: 'var(--warning)' }}>
                No models available. Please configure a provider with models first.
              </div>
            )}
          </div>

          {/* Schedule Section */}
          <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-3">
              <Clock size={14} style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>Schedule</span>
            </div>
            <div className="flex gap-2 mb-3">
              {(['every', 'at', 'cron'] as CronScheduleKind[]).map((kind) => (
                <button
                  key={kind}
                  type="button"
                  className="flex-1 px-3 py-2 rounded-lg text-xs font-medium transition-all duration-150 capitalize"
                  style={{
                    background: editor.scheduleKind === kind ? 'var(--accent-soft)' : 'var(--surface)',
                    color: editor.scheduleKind === kind ? 'var(--accent)' : 'var(--muted)',
                    border: `1px solid ${editor.scheduleKind === kind ? 'var(--accent-soft)' : 'var(--border)'}`,
                  }}
                  onClick={() => setEditor((prev) => ({ ...prev, scheduleKind: kind }))}
                  onMouseEnter={(e) => {
                    if (editor.scheduleKind !== kind) {
                      e.currentTarget.style.background = 'var(--surface-hover)';
                    }
                  }}
                  onMouseLeave={(e) => {
                    if (editor.scheduleKind !== kind) {
                      e.currentTarget.style.background = 'var(--surface)';
                    }
                  }}
                >
                  {kind}
                </button>
              ))}
            </div>

            {editor.scheduleKind === 'every' && (
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>Interval (milliseconds)</label>
                <input
                  className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                  type="number"
                  placeholder="60000"
                  value={editor.everyMs}
                  onChange={(event) => setEditor((prev) => ({ ...prev, everyMs: event.target.value }))}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                />
                <p className="text-xs mt-1.5" style={{ color: 'var(--muted)', opacity: 0.7 }}>
                  Example: 60000 = 1 minute, 3600000 = 1 hour
                </p>
              </div>
            )}
            {editor.scheduleKind === 'at' && (
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>Date & Time (ISO format)</label>
                <input
                  className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                  placeholder="2026-05-01T10:00:00.000Z"
                  value={editor.at}
                  onChange={(event) => setEditor((prev) => ({ ...prev, at: event.target.value }))}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                />
              </div>
            )}
            {editor.scheduleKind === 'cron' && (
              <div className="space-y-3">
                <div>
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>Cron Expression</label>
                  <input
                    className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none font-mono"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                    }}
                    placeholder="*/5 * * * *"
                    value={editor.cronExpr}
                    onChange={(event) => setEditor((prev) => ({ ...prev, cronExpr: event.target.value }))}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                  />
                  <p className="text-xs mt-1.5" style={{ color: 'var(--muted)', opacity: 0.7 }}>
                    Format: minute hour day month weekday
                  </p>
                </div>
                <div>
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>Timezone (optional)</label>
                  <input
                    className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                    }}
                    placeholder="e.g. Asia/Shanghai"
                    value={editor.cronTz}
                    onChange={(event) => setEditor((prev) => ({ ...prev, cronTz: event.target.value }))}
                    onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                    onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                  />
                </div>
              </div>
            )}
          </div>

          {/* Prompt Section */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>Prompt</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none resize-none"
              style={{
                background: 'var(--main-bg)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                minHeight: '80px',
              }}
              placeholder="Enter the prompt to execute..."
              value={editor.prompt}
              onChange={(event) => setEditor((prev) => ({ ...prev, prompt: event.target.value }))}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
          </div>

          {/* Input Params */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>Input Parameters (JSON)</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none resize-none font-mono"
              style={{
                background: 'var(--main-bg)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                minHeight: '50px',
              }}
              placeholder='{"key": "value"}'
              value={editor.inputParams}
              onChange={(event) => setEditor((prev) => ({ ...prev, inputParams: event.target.value }))}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
          </div>

          {/* Advanced Settings */}
          <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-3">
              <SlidersHorizontal size={14} style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>Advanced Settings</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>Concurrency Policy</label>
                <select
                  className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none cursor-pointer"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                  value={editor.concurrencyPolicy}
                  onChange={(event) =>
                    setEditor((prev) => ({ ...prev, concurrencyPolicy: event.target.value as ConcurrencyPolicy }))
                  }
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                >
                  <option value="skip">Skip</option>
                  <option value="parallel">Parallel</option>
                  <option value="queue">Queue</option>
                  <option value="replace">Replace</option>
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>Max Retries</label>
                <input
                  className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                  style={{
                    background: 'var(--surface)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                  type="number"
                  min="0"
                  max="10"
                  value={editor.maxRetries}
                  onChange={(event) => setEditor((prev) => ({ ...prev, maxRetries: event.target.value }))}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                />
              </div>
            </div>
            <label className="flex items-center gap-2 mt-3 text-sm cursor-pointer" style={{ color: 'var(--text)' }}>
              <div className="relative inline-flex items-center">
                <input
                  type="checkbox"
                  className="sr-only peer"
                  checked={editor.enabled}
                  onChange={(event) => setEditor((prev) => ({ ...prev, enabled: event.target.checked }))}
                />
                <div
                  className="w-10 h-5 rounded-full transition-all duration-200"
                  style={{
                    background: editor.enabled ? 'var(--accent)' : 'rgba(255, 255, 255, 0.1)',
                  }}
                >
                  <div
                    className="w-4 h-4 bg-white rounded-full transition-transform duration-200"
                    style={{
                      transform: editor.enabled ? 'translateX(20px)' : 'translateX(2px)',
                      marginTop: '2px',
                    }}
                  />
                </div>
              </div>
              <span className="text-xs">Enabled</span>
            </label>
          </div>

          {/* Action Buttons */}
          <div className="flex gap-3 pt-2">
            <button
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-200"
              style={{
                background: 'linear-gradient(140deg, #5f71ff, #7286ff)',
                color: '#ffffff',
                opacity: saving ? 0.6 : 1,
              }}
              type="button"
              disabled={saving}
              onClick={handleSubmit}
              onMouseEnter={(e) => {
                if (!saving) {
                  e.currentTarget.style.opacity = '0.9';
                  e.currentTarget.style.transform = 'translateY(-1px)';
                  e.currentTarget.style.boxShadow = '0 4px 12px var(--accent-shadow)';
                }
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.opacity = saving ? '0.6' : '1';
                e.currentTarget.style.transform = 'translateY(0)';
                e.currentTarget.style.boxShadow = 'none';
              }}
            >
              {saving ? (
                <>
                  <SpinnerGap size={16} className="animate-spin" />
                  Saving...
                </>
              ) : (
                <>{initialData?.id ? 'Save Changes' : 'Create Cron Job'}</>
              )}
            </button>
            <button
              className="px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-200"
              style={{
                background: 'var(--surface)',
                color: 'var(--text)',
                border: '1px solid var(--border)',
              }}
              type="button"
              onClick={onCancel}
              onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
              onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// Cron Detail Component
interface CronDetailProps {
  cron: AutomationCron;
  runs: AutomationCronRun[];
  availableModels: ModelOption[];
  modelsLoading: boolean;
  onRun: () => void;
  onDelete: () => void;
  onUpdate: (id: string, data: Parameters<typeof updateAutomationCronIPC>[1]) => void;
  saving: boolean;
  onViewSession?: (run: AutomationCronRun) => void;
}

function CronDetail({ cron, runs, availableModels, modelsLoading, onRun, onDelete, onUpdate, saving, onViewSession }: CronDetailProps) {
  const [isEditing, setIsEditing] = useState(false);

  if (isEditing) {
    return (
      <CronEditor
        initialData={{
          id: cron.id,
          name: cron.name,
          description: cron.description ?? '',
          scheduleKind: cron.schedule_kind,
          at: cron.schedule_at ?? '',
          everyMs: cron.schedule_every_ms ? String(cron.schedule_every_ms) : '60000',
          cronExpr: cron.schedule_cron_expr ?? '*/5 * * * *',
          cronTz: cron.schedule_cron_tz ?? '',
          prompt: cron.prompt,
          inputParams: cron.input_params || '{}',
          concurrencyPolicy: cron.concurrency_policy,
          maxRetries: String(cron.max_retries),
          enabled: cron.status === 'enabled',
          model: cron.model ?? '',
        }}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        onSave={async (data) => {
          await onUpdate(cron.id, {
            name: data.name,
            description: data.description,
            schedule: data.schedule,
            prompt: data.prompt,
            model: data.model,
            inputParams: data.inputParams,
            concurrencyPolicy: data.concurrencyPolicy,
            maxRetries: data.maxRetries,
            status: data.enabled ? 'enabled' : 'disabled',
          });
          setIsEditing(false);
        }}
        onCancel={() => setIsEditing(false)}
        saving={saving}
      />
    );
  }

  return (
    <>
      {/* Header */}
      <div className="px-4 py-3 border-b border-[var(--border)] flex items-center justify-between" style={{ background: 'var(--surface)' }}>
        <div className="flex items-center gap-2">
          {getStatusIcon(cron.status)}
          <h3 className="font-medium text-sm" style={{ color: 'var(--text)' }}>{cron.name}</h3>
        </div>
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
            style={{ background: 'var(--success-soft)', color: 'var(--success)' }}
            onClick={onRun}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            <Play size={12} weight="fill" />
            Run Now
          </button>
          <button
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
            style={{ background: 'var(--surface)', color: 'var(--text)' }}
            onClick={() => setIsEditing(true)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
          >
            <PencilSimple size={12} />
            Edit
          </button>
          <button
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
            style={{ background: 'var(--error-soft)', color: 'var(--error)' }}
            onClick={onDelete}
            onMouseEnter={(e) => { e.currentTarget.style.opacity = '0.8'; }}
            onMouseLeave={(e) => { e.currentTarget.style.opacity = '1'; }}
          >
            <Trash size={12} />
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto scrollbar-thin">
        {/* Info Section */}
        <div className="p-4 border-b border-[var(--border)]">
          <div className="grid grid-cols-2 gap-4 mb-4">
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--muted)' }}>Schedule</label>
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                <Timer size={14} />
                {getScheduleDisplay(cron)}
              </div>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--muted)' }}>Status</label>
              <span
                className="text-xs px-2 py-1 rounded-full"
                style={{
                  background: cron.status === 'enabled' ? 'var(--success-soft)' : 'var(--chip)',
                  color: cron.status === 'enabled' ? 'var(--success)' : 'var(--muted)',
                }}
              >
                {cron.status}
              </span>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--muted)' }}>Model</label>
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                <Robot size={14} />
                <span className="truncate">{cron.model || 'Not configured'}</span>
              </div>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--muted)' }}>Next Run</label>
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                <Calendar size={14} />
                {formatTime(cron.next_run_at)}
              </div>
            </div>
            <div>
              <label className="block text-xs mb-1" style={{ color: 'var(--muted)' }}>Last Run</label>
              <div className="flex items-center gap-2 text-sm" style={{ color: 'var(--text)' }}>
                <Clock size={14} />
                {formatTime(cron.last_run_at)}
              </div>
            </div>
          </div>
          {cron.description && (
            <div className="mb-4">
              <label className="block text-xs mb-1" style={{ color: 'var(--muted)' }}>Description</label>
              <p className="text-sm" style={{ color: 'var(--text)' }}>{cron.description}</p>
            </div>
          )}
          <div>
            <label className="block text-xs mb-1" style={{ color: 'var(--muted)' }}>Prompt</label>
            <div className="p-3 rounded-lg text-sm" style={{ background: 'var(--main-bg)', color: 'var(--text)' }}>
              {cron.prompt}
            </div>
          </div>
        </div>

        {/* Runs Section */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <h4 className="font-medium text-sm" style={{ color: 'var(--text)' }}>Recent Runs</h4>
            <span className="text-xs px-2 py-1 rounded-full" style={{ background: 'var(--chip)', color: 'var(--muted)' }}>
              {runs.length}
            </span>
          </div>
          {runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <Play size={28} className="mb-2 opacity-30" style={{ color: 'var(--muted)' }} />
              <p className="text-sm" style={{ color: 'var(--muted)' }}>No runs yet</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)', opacity: 0.7 }}>Click "Run Now" to execute manually</p>
            </div>
          ) : (
            <div className="space-y-2">
              {runs.map((run) => (
                <div
                  key={run.id}
                  className="rounded-lg p-3 transition-all duration-150"
                  style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}
                >
                  <div className="flex items-center justify-between mb-2">
                    <div className="flex items-center gap-2">
                      {getRunStatusIcon(run.run_status)}
                      <span className="text-sm font-medium capitalize" style={{ color: 'var(--text)' }}>
                        {run.run_status}
                      </span>
                    </div>
                    <div className="flex items-center gap-3 text-xs" style={{ color: 'var(--muted)' }}>
                      <span>{formatTime(run.started_at)}</span>
                      {run.session_id && onViewSession && (
                        <button
                          onClick={() => onViewSession(run)}
                          className="flex items-center gap-1 px-2 py-1 rounded-md text-xs font-medium transition-all duration-150"
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                          title="View session messages"
                        >
                          <ChatCircle size={12} />
                          View
                        </button>
                      )}
                    </div>
                  </div>
                  {run.error_message && (
                    <div className="text-xs px-2 py-1.5 rounded mb-2" style={{ background: 'var(--error-soft)', color: 'var(--error)' }}>
                      {run.error_message}
                    </div>
                  )}
                  {run.output && (
                    <pre className="text-xs p-2 rounded overflow-x-auto" style={{ background: 'var(--surface)', color: 'var(--text)' }}>
                      {run.output}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
