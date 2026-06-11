import { useEffect, useMemo, useState, useCallback } from 'react';
import type {
  AutomationCron,
  AutomationCronRun,
  AutomationTemplate,
  ConcurrencyPolicy,
  CreateAutomationCronInput,
  CronScheduleKind,
} from '@/types/automation';
import {
  createAutomationCronIPC,
  deleteAutomationCronIPC,
  listAutomationCronRunsIPC,
  listAutomationCronsIPC,
  listAutomationTemplatesIPC,
  runAutomationCronIPC,
  updateAutomationCronIPC,
} from '@/lib/automation-ipc';
import { CronChatModal } from './CronChatModal';
import { ModelSelector, type ModelOption } from '@/components/chat/ModelSelector';
import { listProvidersIPC, getOllamaModelsIPC, type Provider } from '@/lib/ipc-client';
import {
  Plus,
  Play,
  PencilSimple,
  Trash,
  Clock,
  Calendar,
  Timer,
  SlidersHorizontal,
  WarningCircle,
  CheckCircle,
  XCircle,
  SpinnerGap,
  Robot,
  SquaresFour,
  ArrowRight,
} from '@phosphor-icons/react';
import { AutomationEmptyState } from './AutomationEmptyState';
import { QuickCronChatModal } from './QuickCronChatModal';
import { TemplateMarketModal } from './TemplateMarketModal';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';

function buildCronCreationPrompt(userPrompt: string, templatePrompt?: string): string {
  const sections = [
    'Create a cron job automation using the cron tool. Here is the user request:',
    '',
    userPrompt,
  ];

  if (templatePrompt) {
    sections.push(
      '',
      'Template task details for the cron job to execute each run:',
      templatePrompt,
    );
  }

  sections.push(
    '',
    'Instructions:',
    '1. Use the cron tool with action "create" to set up this cron job',
    '2. Analyze the request to determine the appropriate schedule (cron expression, interval, or specific time)',
    '3. Extract a concise but descriptive name for the cron job',
    '4. The "prompt" field should contain the task description for each execution',
    '5. Set enabled to true by default',
  );

  return sections.join('\n');
}

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

function formatRelativeTime(value: number | null, t: (key: 'automation.timeLaterShort' | 'automation.timeLaterMinutes' | 'automation.timeAgoShort' | 'automation.timeAgoMinutes', params?: Record<string, string | number>) => string): string {
  if (!value) return '-';
  const now = Date.now();
  const diff = value - now;
  const absDiff = Math.abs(diff);
  const hours = Math.floor(absDiff / (1000 * 60 * 60));
  const minutes = Math.floor((absDiff % (1000 * 60 * 60)) / (1000 * 60));

  if (diff > 0) {
    if (hours > 0) return t('automation.timeLaterShort', { hours, minutes });
    return t('automation.timeLaterMinutes', { minutes });
  } else {
    if (hours > 0) return t('automation.timeAgoShort', { hours, minutes });
    return t('automation.timeAgoMinutes', { minutes });
  }
}

function formatDateShort(value: number | null): string {
  if (!value) return '-';
  const d = new Date(value);
  return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
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

function getScheduleLabel(cron: AutomationCron, t: (key: 'automation.scheduleEvery' | 'automation.scheduleAt' | 'automation.scheduleUnknown') => string): string {
  const everyPrefix = t('automation.scheduleEvery');
  switch (cron.schedule_kind) {
    case 'every': {
      const ms = cron.schedule_every_ms ?? 0;
      if (ms >= 86400000) return `${everyPrefix} ${ms / 86400000}d`;
      if (ms >= 3600000) return `${everyPrefix} ${ms / 3600000}h`;
      if (ms >= 60000) return `${everyPrefix} ${ms / 60000}m`;
      return `${everyPrefix} ${ms / 1000}s`;
    }
    case 'at':
      return `${t('automation.scheduleAt')} ${cron.schedule_at || '?'}`;
    case 'cron':
      return cron.schedule_cron_expr || '?';
    default:
      return t('automation.scheduleUnknown');
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

// Parse prompt into task steps
function parsePromptSteps(prompt: string): string[] {
  const lines = prompt.split(/\n|(?:\d+\.\s+)/).filter(l => l.trim().length > 0);
  if (lines.length <= 1) {
    // Try to split by sentences or commas
    return prompt.split(/[.!?;]/).filter(l => l.trim().length > 10).map(l => l.trim());
  }
  return lines.map(l => l.trim()).filter(l => l.length > 0 && !l.match(/^\d+\.$/));
}

// Mock capabilities based on prompt content
function inferCapabilities(prompt: string): { key: 'automation.capGit' | 'automation.capPRReview' | 'automation.capBrowser' | 'automation.capSearch'; available: boolean }[] {
  const p = prompt.toLowerCase();
  return [
    { key: 'automation.capGit', available: p.includes('git') || p.includes('commit') || p.includes('pr') || p.includes('branch') },
    { key: 'automation.capPRReview', available: p.includes('pr') || p.includes('pull request') || p.includes('review') },
    { key: 'automation.capBrowser', available: p.includes('browser') || p.includes('web') || p.includes('url') || p.includes('site') },
    { key: 'automation.capSearch', available: p.includes('search') || p.includes('find') || p.includes('lookup') },
  ];
}

// Mock execution graph based on prompt
function buildExecutionGraph(prompt: string): { key: 'automation.graphTrigger' | 'automation.graphGitCommit' | 'automation.capPRReview' | 'automation.graphSummarize' | 'automation.graphTodo' | 'automation.graphOutput'; status: 'success' | 'failed' | 'pending' | 'running' }[] {
  const p = prompt.toLowerCase();
  const graph: { key: 'automation.graphTrigger' | 'automation.graphGitCommit' | 'automation.capPRReview' | 'automation.graphSummarize' | 'automation.graphTodo' | 'automation.graphOutput'; status: 'success' | 'failed' | 'pending' | 'running' }[] = [
    { key: 'automation.graphTrigger', status: 'success' },
  ];

  if (p.includes('git') || p.includes('commit')) {
    graph.push({ key: 'automation.graphGitCommit', status: 'success' });
  }
  if (p.includes('pr') || p.includes('pull request')) {
    graph.push({ key: 'automation.capPRReview', status: Math.random() > 0.5 ? 'success' : 'failed' });
  }
  if (p.includes('summarize') || p.includes('summary')) {
    graph.push({ key: 'automation.graphSummarize', status: 'success' });
  }
  if (p.includes('todo') || p.includes('task')) {
    graph.push({ key: 'automation.graphTodo', status: 'pending' });
  }
  graph.push({ key: 'automation.graphOutput', status: 'pending' });

  return graph;
}

export function AutomationView() {
  const { t } = useTranslation();
  const hasElectronApi = typeof window !== 'undefined' && !!window.electronAPI?.automation;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crons, setCrons] = useState<AutomationCron[]>([]);
  const [selectedCronId, setSelectedCronId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationCronRun[]>([]);
  const [isCreating, setIsCreating] = useState(false);

  // NL & Template state
  const [quickChatModalOpen, setQuickChatModalOpen] = useState(false);
  const [templateModalOpen, setTemplateModalOpen] = useState(false);
  const [templates, setTemplates] = useState<AutomationTemplate[]>([]);
  const [selectedTemplate, setSelectedTemplate] = useState<AutomationTemplate | null>(null);

  const createThread = useConversationStore((s) => s.createThread);
  const setActiveThread = useConversationStore((s) => s.setActiveThread);
  const setCurrentView = useConversationStore((s) => s.setCurrentView);
  const storeThreads = useConversationStore((s) => s.threads);

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
        providers.forEach((p) => {
          const pAny = p as Provider & Record<string, unknown>;
          const hasKey = pAny.hasApiKey ?? pAny.has_api_key ?? !!(p.apiKey && p.apiKey.length > 0);
          if (pAny.hasApiKey === undefined && hasKey) {
            (p as Provider & { hasApiKey: boolean }).hasApiKey = hasKey;
          }
        });
        // With the multi-provider model, the default provider is
        // the implicit fallback. Automation scripts can use ANY
        // configured provider — they no longer gate on a single
        // active flag. We still surface the default first, but
        // fall back to the first configured provider.
        const defaultProvider = providers.find((p) => p.isDefault && p.hasApiKey);
        const activeProvider =
          defaultProvider ?? providers.find((p) => p.hasApiKey);

        if (activeProvider) {
          const isOllama = activeProvider.providerType === 'ollama' ||
            activeProvider.baseUrl?.includes('11434') ||
            activeProvider.baseUrl?.includes('ollama');

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

  useEffect(() => {
    if (hasElectronApi) {
      void (async () => {
        try {
          const list = await listAutomationTemplatesIPC();
          setTemplates(list);
        } catch {
          setTemplates([]);
        }
      })();
    }
  }, [hasElectronApi]);

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
    const list = await listAutomationCronRunsIPC(cronId, 50, 0);
    setRuns(list);
  }

  useEffect(() => {
    if (!hasElectronApi) {
      setLoading(false);
      setError(t('automation.electronOnlyError'));
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
    setSelectedTemplate(null);
    setQuickChatModalOpen(true);
  }

  function handleChatCreate(): void {
    setSelectedTemplate(null);
    setQuickChatModalOpen(true);
  }

  function handleViewTemplates(): void {
    setTemplateModalOpen(true);
  }

  function handleTemplateSelect(template: AutomationTemplate): void {
    setSelectedTemplate(template);
    setTemplateModalOpen(false);
    setQuickChatModalOpen(true);
  }

  function handleTemplateManualSetup(): void {
    setTemplateModalOpen(false);
    setSelectedTemplate(null);
    setQuickChatModalOpen(true);
  }

  async function handleStartCronChat(userPrompt: string, templatePrompt?: string): Promise<void> {
    setQuickChatModalOpen(false);
    setSelectedTemplate(null);

    const workingDir = storeThreads[0]?.workingDirectory ?? undefined;
    const projectName = storeThreads[0]?.projectName ?? undefined;

    const thread = await createThread({
      workingDirectory: workingDir,
      projectName,
    });

    if (!thread) {
      setError(t('automation.workspaceRequiredError'));
      return;
    }

    setActiveThread(thread.id);
    setCurrentView('chat');

    const prompt = buildCronCreationPrompt(userPrompt, templatePrompt);

    setTimeout(() => {
      const win = window as unknown as Record<string, unknown>;
      const sendFn = win.__widgetSendMessage as ((text: string) => void) | undefined;
      if (sendFn) {
        sendFn(prompt);
      }
    }, 200);
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

  // Calculate success rate
  const successRate = useMemo(() => {
    if (runs.length === 0) return null;
    const success = runs.filter(r => r.run_status === 'success').length;
    return Math.round((success / runs.length) * 100);
  }, [runs]);

  const showEmptyState = !loading && crons.length === 0 && !isCreating;

  // Last 7 days status
  const last7Days = useMemo(() => {
    const days: { date: string; status: 'success' | 'failed' | 'none' }[] = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const dateStr = `${d.getMonth() + 1}/${d.getDate()}`;
      const dayStart = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
      const dayEnd = dayStart + 86400000;
      const dayRuns = runs.filter(r => r.started_at && r.started_at >= dayStart && r.started_at < dayEnd);
      if (dayRuns.length === 0) {
        days.push({ date: dateStr, status: 'none' });
      } else {
        const hasFailed = dayRuns.some(r => r.run_status === 'failed');
        days.push({ date: dateStr, status: hasFailed ? 'failed' : 'success' });
      }
    }
    return days;
  }, [runs]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4">
        <h2 className="automation-title-copernicus" style={{ color: 'var(--text)' }}>{t('automation.title')}</h2>
        {!showEmptyState && (
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm whitespace-nowrap transition-all duration-200"
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
            {t('automation.newAutomation')}
          </button>

          <button
            className="flex items-center gap-2 px-4 py-2 rounded-lg font-medium text-sm whitespace-nowrap transition-all duration-200"
            style={{
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
            }}
            onClick={handleViewTemplates}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
            type="button"
          >
            <SquaresFour size={16} />
            {t('automation.templates')}
          </button>
        </div>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-6 mb-4 px-4 py-3 rounded-lg flex items-center gap-2" style={{ background: 'var(--error-soft)', border: '1px solid rgba(239, 68, 68, 0.3)' }}>
          <WarningCircle size={16} className="text-[var(--error)]" />
          <span className="text-sm" style={{ color: 'var(--error)' }}>{error}</span>
        </div>
      )}

      {/* Main Content */}
      {showEmptyState ? (
        <div className="flex-1 overflow-hidden">
          <AutomationEmptyState
            onChatCreate={handleChatCreate}
            onViewTemplates={handleViewTemplates}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden px-6 pb-6 min-h-0">
          <div className="h-full min-h-0 grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Cron Jobs List - Left Side */}
          <section className="flex flex-col h-full min-h-0 lg:col-span-1">
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {loading ? (
                <div className="flex items-center justify-center h-32" style={{ color: 'var(--muted)' }}>
                  <SpinnerGap size={20} className="animate-spin mr-2" />
                  {t('automation.loading')}
                </div>
              ) : crons.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-32 text-center p-4">
                  <Clock size={32} className="mb-2 opacity-30" style={{ color: 'var(--muted)' }} />
                  <p className="text-sm" style={{ color: 'var(--muted)' }}>{t('automation.noAutomations')}</p>
                </div>
              ) : (
                <div className="space-y-1">
                  {crons.map((cron) => (
                    <div
                      key={cron.id}
                      className="px-3 py-2.5 cursor-pointer transition-all duration-200 rounded-lg"
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
                          {getScheduleLabel(cron, t)}
                        </span>
                        <span className="flex items-center gap-1">
                          <Calendar size={11} />
                          {formatDateShort(cron.next_run_at)}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Detail/Editor Panel - Right Side */}
          <section className="flex flex-col h-full min-h-0 rounded-xl overflow-hidden lg:col-span-2" style={{ border: '1px solid var(--border)' }}>
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
                successRate={successRate}
                last7Days={last7Days}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <p className="text-base font-medium mb-1" style={{ color: 'var(--text)' }}>{t('automation.selectAutomation')}</p>
                <p className="text-sm" style={{ color: 'var(--muted)' }}>{t('automation.selectAutomationDesc')}</p>
              </div>
            )}
          </section>
        </div>
      </div>
      )}

      {/* NL Create Chat Modal */}
      <QuickCronChatModal
        isOpen={quickChatModalOpen}
        onClose={() => {
          setQuickChatModalOpen(false);
          setSelectedTemplate(null);
        }}
        onStartChat={handleStartCronChat}
        initialTemplate={selectedTemplate}
      />

      {/* Template Market Modal */}
      <TemplateMarketModal
        isOpen={templateModalOpen}
        onClose={() => setTemplateModalOpen(false)}
        onSelectTemplate={handleTemplateSelect}
        onManualSetup={handleTemplateManualSetup}
        templates={templates}
      />

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
  const { t } = useTranslation();
  const [editor, setEditor] = useState<EditorState>(initialData || DEFAULT_EDITOR);
  const [modelError, setModelError] = useState<string | null>(null);

  const handleSubmit = () => {
    setModelError(null);

    if (!editor.model || !editor.model.trim()) {
      setModelError(t('automation.modelRequired'));
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
          {initialData?.id ? t('automation.editAutomation') : t('automation.newAutomation')}
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
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.name')}</label>
              <input
                className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                style={{
                  background: 'var(--main-bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
                placeholder={t('automation.namePlaceholder')}
                value={editor.name}
                onChange={(event) => setEditor((prev) => ({ ...prev, name: event.target.value }))}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
              />
            </div>
            <div>
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.description')}</label>
              <input
                className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                style={{
                  background: 'var(--main-bg)',
                  border: '1px solid var(--border)',
                  color: 'var(--text)',
                }}
                placeholder={t('automation.descriptionPlaceholder')}
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
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{t('automation.model')}</span>
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
                {t('automation.noModelsAvailable')}
              </div>
            )}
          </div>

          {/* Schedule Section */}
          <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 mb-3">
              <Clock size={14} style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{t('automation.schedule')}</span>
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
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.intervalMs')}</label>
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
                  {t('automation.intervalMsHint')}
                </p>
              </div>
            )}
            {editor.scheduleKind === 'at' && (
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.dateTime')}</label>
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
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.cronExpression')}</label>
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
                    {t('automation.cronFormatHint')}
                  </p>
                </div>
                <div>
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.timezone')}</label>
                  <input
                    className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none"
                    style={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      color: 'var(--text)',
                    }}
                    placeholder={t('automation.timezonePlaceholder')}
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
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.prompt')}</label>
            <textarea
              className="w-full px-3 py-2 rounded-lg text-sm transition-all duration-150 outline-none resize-none"
              style={{
                background: 'var(--main-bg)',
                border: '1px solid var(--border)',
                color: 'var(--text)',
                minHeight: '80px',
              }}
              placeholder={t('automation.promptPlaceholder')}
              value={editor.prompt}
              onChange={(event) => setEditor((prev) => ({ ...prev, prompt: event.target.value }))}
              onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
              onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
            />
          </div>

          {/* Input Params */}
          <div>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.inputParams')}</label>
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
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{t('automation.advancedSettings')}</span>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.concurrencyPolicy')}</label>
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
                  <option value="skip">{t('automation.concurrencySkip')}</option>
                  <option value="parallel">{t('automation.concurrencyParallel')}</option>
                  <option value="queue">{t('automation.concurrencyQueue')}</option>
                  <option value="replace">{t('automation.concurrencyReplace')}</option>
                </select>
              </div>
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.maxRetries')}</label>
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
              <span className="text-xs">{t('automation.enabled')}</span>
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
                  {t('automation.saving')}
                </>
              ) : (
                <>{initialData?.id ? t('automation.saveChanges') : t('automation.createAutomation')}</>
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
              {t('automation.cancel')}
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
  successRate: number | null;
  last7Days: { date: string; status: 'success' | 'failed' | 'none' }[];
}

function CronDetail({ cron, runs, availableModels, modelsLoading, onRun, onDelete, onUpdate, saving, onViewSession, successRate, last7Days }: CronDetailProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [showAllRuns, setShowAllRuns] = useState(false);

  const displayedRuns = showAllRuns ? runs : runs.slice(0, 5);
  const capabilities = inferCapabilities(cron.prompt);
  const executionGraph = buildExecutionGraph(cron.prompt);
  const promptSteps = parsePromptSteps(cron.prompt);

  // Last result
  const lastRun = runs[0];
  const lastResult = lastRun ? {
    status: lastRun.run_status,
    error: lastRun.error_message,
    duration: lastRun.started_at && lastRun.ended_at
      ? `${Math.round((lastRun.ended_at - lastRun.started_at) / 1000)}s`
      : null,
  } : null;

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
            {t('automation.runNow')}
          </button>
          <button
            className="flex items-center gap-1 px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
            style={{ background: 'var(--surface)', color: 'var(--text)' }}
            onClick={() => setIsEditing(true)}
            onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface)'; }}
          >
            <PencilSimple size={12} />
            {t('automation.edit')}
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
        {/* Daily Brief Section */}
        <div className="p-4 border-b border-[var(--border)]">
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>{t('automation.dailyBrief')}</span>

          <div className="grid grid-cols-2 gap-3 mt-3">
            {/* Status Card */}
            <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{t('automation.status')}</span>
              <p className="text-sm font-medium capitalize mt-1" style={{ color: 'var(--text)' }}>
                {cron.status === 'error' ? t('automation.statusError') : lastResult?.status || t('automation.statusNoRuns')}
              </p>
            </div>

            {/* Next Run Card */}
            <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{t('automation.nextRun')}</span>
              <p className="text-sm font-medium mt-1" style={{ color: 'var(--text)' }}>
                {formatDateShort(cron.next_run_at)}
              </p>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {formatRelativeTime(cron.next_run_at, t)}
              </p>
            </div>

            {/* Last Result Card */}
            <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{t('automation.lastResult')}</span>
              {lastResult ? (
                <>
                  <p className="text-sm font-medium capitalize mt-1" style={{
                    color: lastResult.status === 'success' ? 'var(--success)' : lastResult.status === 'failed' ? 'var(--error)' : 'var(--text)'
                  }}>
                    {lastResult.status === 'success' ? t('automation.statusSuccess') : lastResult.status === 'failed' ? t('automation.statusFailed', { error: lastResult.error || t('automation.statusUnknown') }) : lastResult.status}
                  </p>
                  {lastResult.duration && (
                    <p className="text-xs" style={{ color: 'var(--muted)' }}>{t('automation.duration', { duration: lastResult.duration })}</p>
                  )}
                </>
              ) : (
                <p className="text-sm mt-1" style={{ color: 'var(--muted)' }}>{t('automation.statusNoRuns')}</p>
              )}
            </div>

            {/* Capabilities Card */}
            <div className="rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{t('automation.capabilities')}</span>
              <div className="flex flex-wrap gap-1.5 mt-2">
                {capabilities.map((cap) => (
                  <span
                    key={cap.key}
                    className="inline-flex items-center px-2 py-0.5 rounded text-[10px] font-medium"
                    style={{
                      background: cap.available ? 'var(--success-soft)' : 'var(--chip)',
                      color: cap.available ? 'var(--success)' : 'var(--muted)',
                    }}
                  >
                    {t(cap.key)}
                  </span>
                ))}
              </div>
            </div>
          </div>
        </div>

        {/* Task Spec Section */}
        <div className="p-4 border-b border-[var(--border)]">
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>{t('automation.task')}</span>
          <div className="rounded-lg p-3 mt-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
            <p className="text-sm font-medium mb-2" style={{ color: 'var(--text)' }}>
              {promptSteps[0] || cron.prompt}
            </p>
            {promptSteps.length > 1 && (
              <ul className="space-y-1">
                {promptSteps.slice(1).map((step, i) => (
                  <li key={i} className="flex items-start gap-2 text-xs" style={{ color: 'var(--muted)' }}>
                    <span className="mt-0.5 w-1 h-1 rounded-full bg-[var(--accent)] flex-shrink-0" />
                    {step}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {/* Execution Graph Section */}
        <div className="p-4 border-b border-[var(--border)]">
          <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>{t('automation.executionGraph')}</span>
          <div className="flex items-center gap-1 overflow-x-auto pb-2 mt-3">
            {executionGraph.map((node, i) => (
              <div key={i} className="flex items-center gap-1 flex-shrink-0">
                <div
                  className="flex items-center px-2.5 py-1.5 rounded-lg text-xs font-medium"
                  style={{
                    background: node.status === 'failed' ? 'var(--error-soft)' : node.status === 'success' ? 'var(--success-soft)' : 'var(--surface)',
                    color: node.status === 'failed' ? 'var(--error)' : node.status === 'success' ? 'var(--success)' : 'var(--muted)',
                    border: `1px solid ${node.status === 'failed' ? 'rgba(239, 68, 68, 0.3)' : node.status === 'success' ? 'rgba(34, 197, 94, 0.3)' : 'var(--border)'}`,
                  }}
                >
                  {t(node.key)}
                </div>
                {i < executionGraph.length - 1 && (
                  <ArrowRight size={12} style={{ color: 'var(--muted)' }} />
                )}
              </div>
            ))}
          </div>
        </div>

        {/* Runs Timeline Section */}
        <div className="p-4">
          <div className="flex items-center justify-between mb-3">
            <span className="text-xs font-semibold uppercase tracking-wider" style={{ color: 'var(--muted)' }}>{t('automation.recentRuns')}</span>
            {successRate !== null && (
              <div className="flex items-center gap-2">
                <span className="text-xs" style={{ color: 'var(--muted)' }}>{t('automation.successRate')}</span>
                <div className="flex items-center gap-1">
                  <div className="w-16 h-1.5 rounded-full overflow-hidden" style={{ background: 'var(--border)' }}>
                    <div
                      className="h-full rounded-full transition-all duration-300"
                      style={{
                        width: `${successRate}%`,
                        background: successRate >= 80 ? 'var(--success)' : successRate >= 50 ? 'var(--warning)' : 'var(--error)',
                      }}
                    />
                  </div>
                  <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{successRate}%</span>
                </div>
              </div>
            )}
          </div>

          {/* Last 7 days */}
          {last7Days.length > 0 && (
            <div className="flex items-center gap-2 mb-3 px-1">
              <span className="text-[10px]" style={{ color: 'var(--muted)' }}>{t('automation.last7Days')}</span>
              <div className="flex items-center gap-1">
                {last7Days.map((day, i) => (
                  <div key={i} className="flex flex-col items-center gap-0.5">
                    <div
                      className="w-4 h-4 rounded flex items-center justify-center text-[8px] font-bold"
                      style={{
                        background: day.status === 'success' ? 'var(--success-soft)' : day.status === 'failed' ? 'var(--error-soft)' : 'var(--chip)',
                        color: day.status === 'success' ? 'var(--success)' : day.status === 'failed' ? 'var(--error)' : 'var(--muted)',
                      }}
                    >
                      {day.status === 'success' ? '✓' : day.status === 'failed' ? '✗' : '·'}
                    </div>
                    <span className="text-[8px]" style={{ color: 'var(--muted)' }}>{day.date}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {runs.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-8 text-center">
              <p className="text-sm" style={{ color: 'var(--muted)' }}>{t('automation.statusNoRuns')}</p>
              <p className="text-xs mt-1" style={{ color: 'var(--muted)', opacity: 0.7 }}>{t('automation.clickRunNowHint')}</p>
            </div>
          ) : (
            <div className="space-y-0">
              {displayedRuns.map((run, index) => (
                <div
                  key={run.id}
                  className="flex items-start gap-3 py-3 relative"
                  style={{
                    borderLeft: '2px solid var(--border)',
                    paddingLeft: '12px',
                    marginLeft: '6px',
                  }}
                >
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium capitalize" style={{ color: 'var(--text)' }}>
                          {run.run_status}
                        </span>
                        {run.error_message && (
                          <span className="text-xs truncate max-w-[200px]" style={{ color: 'var(--error)' }}>
                            {run.error_message}
                          </span>
                        )}
                      </div>
                      <span className="text-xs flex-shrink-0" style={{ color: 'var(--muted)' }}>
                        {formatDateShort(run.started_at)}
                      </span>
                    </div>

                    {run.output && (
                      <p className="text-xs truncate" style={{ color: 'var(--muted)' }}>
                        {run.output}
                      </p>
                    )}

                    <div className="flex items-center gap-2 mt-1.5">
                      {run.session_id && onViewSession && (
                        <button
                          onClick={() => onViewSession(run)}
                          className="px-2 py-0.5 rounded text-[10px] font-medium transition-all duration-150"
                          style={{ background: 'var(--accent-soft)', color: 'var(--accent)' }}
                        >
                          {t('automation.viewLogs')}
                        </button>
                      )}
                      {run.error_message && (
                        <span className="text-[10px] px-2 py-0.5 rounded" style={{ background: 'var(--error-soft)', color: 'var(--error)' }}>
                          {run.error_message}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              ))}

              {runs.length > 5 && (
                <button
                  onClick={() => setShowAllRuns(!showAllRuns)}
                  className="w-full text-center py-2 text-xs font-medium transition-colors"
                  style={{ color: 'var(--accent)' }}
                >
                  {showAllRuns ? t('automation.showLess') : t('automation.showMore', { count: runs.length - 5 })}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </>
  );
}
