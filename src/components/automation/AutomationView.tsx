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
  SlidersHorizontal,
  WarningCircle,
  XCircle,
  SpinnerGap,
  Robot,
  SquaresFour,
  ArrowRight,
  DotsThree,
} from '@phosphor-icons/react';
import { AutomationEmptyState } from './AutomationEmptyState';
import { QuickCronChatModal } from './QuickCronChatModal';
import { TemplateMarketModal } from './TemplateMarketModal';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';
import { CronScheduleCard } from './CronScheduleCard';
import {
  createDefaultScheduleDraft,
  describeScheduleDraft,
  draftToSchedule,
  scheduleToDraft,
  type ScheduleDraft,
} from './cron-schedule';

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
  workingDirectory: string;
  scheduleDraft: ScheduleDraft;
};

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
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
}

function formatInterval(ms: number | null): string {
  const value = ms ?? 0;
  if (value >= 86_400_000 && value % 86_400_000 === 0) return `每 ${value / 86_400_000} 天`;
  if (value >= 3_600_000 && value % 3_600_000 === 0) return `每 ${value / 3_600_000} 小时`;
  if (value >= 60_000 && value % 60_000 === 0) return `每 ${value / 60_000} 分钟`;
  return `每 ${Math.max(1, Math.round(value / 1000))} 秒`;
}

function formatCronSchedule(expression: string | null): string {
  const fields = expression?.trim().split(/\s+/) ?? [];
  if (fields.length !== 5) return '自定义计划';
  const [minute = '', hour = '', dayOfMonth = '', month = '', dayOfWeek = ''] = fields;
  if (minute.startsWith('*/') && hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*') {
    return `每 ${minute.slice(2)} 分钟`;
  }
  const time = /^\d+$/.test(minute) && /^\d+$/.test(hour)
    ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    : '';
  if (dayOfMonth === '*' && month === '*' && dayOfWeek === '*') return time ? `每天 ${time}` : '每天';
  const weekday: Record<string, string> = {
    '0': '日', '1': '一', '2': '二', '3': '三', '4': '四', '5': '五', '6': '六', '7': '日',
  };
  if (dayOfMonth === '*' && month === '*' && weekday[dayOfWeek]) {
    return `每周${weekday[dayOfWeek]}${time ? ` ${time}` : ''}`;
  }
  return time ? `自定义 · ${time}` : '自定义计划';
}

function getFriendlySchedule(cron: AutomationCron): string {
  switch (cron.schedule_kind) {
    case 'every':
      return formatInterval(cron.schedule_every_ms);
    case 'at':
      return cron.schedule_at ? `一次性 · ${formatDateShort(Date.parse(cron.schedule_at))}` : '一次性任务';
    case 'cron':
      return formatCronSchedule(cron.schedule_cron_expr);
    default:
      return '未设置计划';
  }
}

function getStatusIcon(status: string) {
  switch (status) {
    case 'enabled':
      return <span className="h-4 w-4 rounded-full border-2 border-[var(--muted)]" aria-label="已启用" />;
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
  workingDirectory: '',
  scheduleDraft: createDefaultScheduleDraft(),
};

function editorStateFromCron(cron: AutomationCron): EditorState {
  return {
    id: cron.id,
    name: cron.name,
    description: cron.description ?? '',
    scheduleKind: cron.schedule_kind,
    at: cron.schedule_at ?? '',
    everyMs: String(cron.schedule_every_ms ?? 3_600_000),
    cronExpr: cron.schedule_cron_expr ?? '0 9 * * *',
    cronTz: cron.schedule_cron_tz ?? '',
    prompt: cron.prompt,
    inputParams: cron.input_params || '{}',
    concurrencyPolicy: cron.concurrency_policy,
    maxRetries: String(cron.max_retries),
    enabled: cron.status === 'enabled',
    model: cron.model,
    workingDirectory: cron.working_directory || '',
    scheduleDraft: scheduleToDraft(cron),
  };
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
    setSelectedCronId(null);
    setIsCreating(true);
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
    <div className="automation-scheduled-view h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-8 pb-5">
        <div>
          <h2 className="automation-title-copernicus text-3xl" style={{ color: 'var(--text)' }}>已计划</h2>
          <p className="mt-2 text-sm" style={{ color: 'var(--muted)' }}>让 Duya 帮你安排任务、设置提醒，或定期跟进更新。</p>
        </div>
        {!showEmptyState && (
        <div className="flex items-center gap-2">
          <button
            className="flex items-center gap-2 px-4 py-2 rounded-full font-medium text-sm whitespace-nowrap transition-all duration-200"
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
            onManualCreate={handleCreateNew}
            onChatCreate={handleChatCreate}
            onViewTemplates={handleViewTemplates}
          />
        </div>
      ) : (
        <div className="flex-1 overflow-hidden px-8 pb-8 min-h-0">
          <div className="h-full min-h-0 grid grid-cols-1 gap-6 lg:grid-cols-[minmax(260px,0.75fr)_minmax(440px,1.25fr)]">
          {/* Cron Jobs List - Left Side */}
          <section className="flex flex-col h-full min-h-0">
            <button
              type="button"
              onClick={handleCreateNew}
              className="mb-7 flex items-center gap-3 rounded-full px-5 py-4 text-left transition-colors"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)', color: 'var(--muted)' }}
            >
              <Plus size={20} weight="bold" style={{ color: 'var(--text)' }} />
              <span className="text-base">安排任务</span>
            </button>
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
                <div className="space-y-0">
                  {crons.map((cron) => (
                    <div
                      key={cron.id}
                      className="px-5 py-4 cursor-pointer transition-all duration-200 rounded-2xl border-b"
                      style={{
                        background: selectedCronId === cron.id && !isCreating ? 'var(--surface)' : 'transparent',
                        borderColor: selectedCronId === cron.id && !isCreating ? 'var(--text)' : 'var(--border)',
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
                      <div className="flex items-center justify-between mb-1.5">
                        <div className="flex items-center gap-3 min-w-0">
                          {selectedCronId === cron.id && !isCreating ? (
                            <span className="h-3 w-3 rounded-full bg-[var(--accent)]" />
                          ) : (
                            getStatusIcon(cron.status)
                          )}
                          <span className="font-medium text-sm truncate" style={{ color: 'var(--text)' }}>{cron.name}</span>
                        </div>
                      </div>
                      <div className="flex items-center gap-1.5 text-xs ml-7" style={{ color: 'var(--muted)' }}>
                        <span>{getFriendlySchedule(cron)}</span>
                        <span>·</span>
                        <span>下次运行 {formatRelativeTime(cron.next_run_at, t)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          {/* Detail/Editor Panel - Right Side */}
          <section className="flex flex-col h-full min-h-0 overflow-hidden border-l" style={{ borderColor: 'var(--border)' }}>
            {isCreating ? (
              <CronEditor
                availableModels={availableModels}
                modelsLoading={modelsLoading}
                onSave={async (data) => {
                  if (!hasElectronApi) return;
                  try {
                    setSaving(true);
                    setError(null);
                    const created = await createAutomationCronIPC(data);
                    await reloadCrons(created.id);
                    setIsCreating(false);
                  } catch (err) {
                    setError(err instanceof Error ? err.message : String(err));
                    throw err;
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
                    throw err;
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
  onSave: (data: CreateAutomationCronInput) => Promise<void>;
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
  const [formError, setFormError] = useState<string | null>(null);

  const handleSubmit = async () => {
    setModelError(null);
    setFormError(null);

    if (!editor.name.trim()) {
      setFormError('请输入任务名称。');
      return;
    }
    if (!editor.prompt.trim()) {
      setFormError('请输入每次运行时要执行的提示词。');
      return;
    }

    if (!editor.model || !editor.model.trim()) {
      setModelError(t('automation.modelRequired'));
      return;
    }

    try {
      const parsedParams = editor.inputParams ? JSON.parse(editor.inputParams) : {};
      if (!parsedParams || Array.isArray(parsedParams) || typeof parsedParams !== 'object') {
        throw new Error('输入参数必须是 JSON 对象。');
      }
      const maxRetries = Number(editor.maxRetries || '3');
      const schedule = draftToSchedule(editor.scheduleDraft);
      if (schedule.kind === 'cron' && !schedule.cronExpr?.trim()) throw new Error('请输入 Cron 表达式。');
      if (schedule.kind === 'at' && !schedule.at) throw new Error('请选择运行时间。');
      if (editor.scheduleDraft.endRepeat === 'on' && !editor.scheduleDraft.endAt) throw new Error('请选择结束重复时间。');

      await onSave({
        name: editor.name.trim(),
        description: editor.description.trim() || null,
        schedule,
        prompt: editor.prompt.trim(),
        model: editor.model.trim(),
        workingDirectory: editor.workingDirectory.trim() || undefined,
        inputParams: parsedParams as Record<string, unknown>,
        concurrencyPolicy: editor.concurrencyPolicy,
        maxRetries,
        enabled: editor.enabled,
      });
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  return (
    <>
      <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between" style={{ background: 'var(--surface)' }}>
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
      <div className="flex-1 overflow-y-auto p-5 pb-24 scrollbar-thin">
        <div className="space-y-4">
          {/* Name and prompt are the primary decisions, so they lead the form. */}
          <div className="overflow-hidden rounded-xl divide-y divide-[var(--border)]" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="px-4 py-3.5">
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>任务名称</label>
              <input
                className="w-full px-3 py-1.5 rounded-md text-sm transition-all duration-150 outline-none bg-black/30"
                style={{
                  background: 'rgba(0, 0, 0, 0.3)',
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
            <div className="px-4 py-3.5">
              <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>提示词</label>
              <textarea
                className="w-full px-3 py-3 rounded-md text-sm transition-all duration-150 outline-none resize-y bg-black/30"
                style={{ border: '1px solid var(--border)', color: 'var(--text)', minHeight: '148px' }}
                placeholder={t('automation.promptPlaceholder')}
                value={editor.prompt}
                onChange={(event) => setEditor((prev) => ({ ...prev, prompt: event.target.value }))}
                onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
              />
            </div>
          </div>

          <div className="overflow-hidden rounded-2xl" style={{ background: 'var(--command-menu-bg)', border: '1px solid var(--command-menu-border)' }}>
            <div className="px-5 py-4">
              <label className="mb-2 block text-xs font-medium" style={{ color: 'var(--command-menu-muted)' }}>工作目录</label>
              <input
                className="w-full rounded-lg bg-transparent px-3 py-2 text-sm outline-none"
                style={{ border: '1px solid var(--command-menu-border)', color: 'var(--text)' }}
                placeholder="~/.duya/workspace（默认）"
                value={editor.workingDirectory}
                onChange={(event) => setEditor((prev) => ({ ...prev, workingDirectory: event.target.value }))}
              />
              <p className="mt-2 text-xs" style={{ color: 'var(--command-menu-muted)' }}>留空时任务在 ~/.duya/workspace 中运行。</p>
            </div>
          </div>

          {/* Model Selection */}
          <div className="rounded-xl px-4 py-3.5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
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

          <section>
            <p className="mb-3 text-xs font-medium" style={{ color: 'var(--command-menu-muted)' }}>频率</p>
            <CronScheduleCard
              value={editor.scheduleDraft}
              onChange={(scheduleDraft) => setEditor((prev) => ({ ...prev, scheduleDraft }))}
            />
          </section>

          {/* Legacy schedule controls are kept out of the render path while old editor fields remain wire-compatible. */}
          <div className="hidden overflow-hidden rounded-xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 px-4 pt-3.5 pb-3 border-b border-[var(--border)]">
              <Clock size={14} style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{t('automation.schedule')}</span>
            </div>
            <div className="flex gap-2 px-4 py-3.5 border-b border-[var(--border)]">
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
                  {kind === 'every' ? '重复' : kind === 'at' ? '一次' : '自定义'}
                </button>
              ))}
            </div>

            {editor.scheduleKind === 'every' && (
              <div className="px-4 pb-3.5">
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>每隔多久运行</label>
                <div className="flex items-center gap-3">
                <input
                  className="min-w-0 flex-1 px-3 py-1.5 rounded-md text-sm transition-all duration-150 outline-none bg-black/30"
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                  type="number"
                  min="1"
                  placeholder="60"
                  value={editor.everyMs ? String(Number(editor.everyMs) / 60_000) : ''}
                  onChange={(event) => setEditor((prev) => ({ ...prev, everyMs: String(Number(event.target.value || '0') * 60_000) }))}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                />
                <span className="text-sm whitespace-nowrap" style={{ color: 'var(--muted)' }}>分钟</span>
                </div>
                <p className="text-xs mt-1.5" style={{ color: 'var(--muted)', opacity: 0.7 }}>
                  例如：60 表示每小时运行一次。
                </p>
              </div>
            )}
            {editor.scheduleKind === 'at' && (
              <div className="px-4 pb-3.5">
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.dateTime')}</label>
                <input
                  className="w-full px-3 py-1.5 rounded-md text-sm transition-all duration-150 outline-none bg-black/30"
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
                    border: '1px solid var(--border)',
                    color: 'var(--text)',
                  }}
                  type="datetime-local"
                  value={editor.at ? editor.at.slice(0, 16) : ''}
                  onChange={(event) => setEditor((prev) => ({ ...prev, at: event.target.value }))}
                  onFocus={(e) => { e.currentTarget.style.borderColor = 'var(--accent)'; }}
                  onBlur={(e) => { e.currentTarget.style.borderColor = 'var(--border)'; }}
                />
              </div>
            )}
            {editor.scheduleKind === 'cron' && (
              <div className="space-y-3 px-4 pb-3.5">
                <div>
                  <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.cronExpression')}</label>
                  <input
                    className="w-full px-3 py-1.5 rounded-md text-sm transition-all duration-150 outline-none font-mono bg-black/30"
                    style={{
                      background: 'rgba(0, 0, 0, 0.3)',
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
                    className="w-full px-3 py-1.5 rounded-md text-sm transition-all duration-150 outline-none bg-black/30"
                    style={{
                      background: 'rgba(0, 0, 0, 0.3)',
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

          {/* Input Params */}
          <div className="rounded-xl px-4 py-3.5" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <label className="block text-xs font-medium mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.inputParams')}</label>
            <textarea
              className="w-full px-3 py-2 rounded-md text-sm transition-all duration-150 outline-none resize-none font-mono bg-black/30"
              style={{
                background: 'rgba(0, 0, 0, 0.3)',
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
          <div className="overflow-hidden rounded-xl" style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}>
            <div className="flex items-center gap-2 px-4 py-3.5 border-b border-[var(--border)]">
              <SlidersHorizontal size={14} style={{ color: 'var(--accent)' }} />
              <span className="text-xs font-medium" style={{ color: 'var(--text)' }}>{t('automation.advancedSettings')}</span>
            </div>
            <div className="grid grid-cols-2 gap-3 px-4 py-3.5">
              <div>
                <label className="block text-xs mb-1.5" style={{ color: 'var(--muted)' }}>{t('automation.concurrencyPolicy')}</label>
                <select
                  className="w-full px-3 py-1.5 rounded-md text-sm transition-all duration-150 outline-none cursor-pointer bg-black/30"
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
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
                  className="w-full px-3 py-1.5 rounded-md text-sm transition-all duration-150 outline-none bg-black/30"
                  style={{
                    background: 'rgba(0, 0, 0, 0.3)',
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
            <label className="flex items-center gap-2 px-4 py-3.5 border-t border-[var(--border)] text-sm cursor-pointer" style={{ color: 'var(--text)' }}>
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
          {formError && (
            <div className="rounded-xl px-4 py-3 text-sm" role="alert" style={{ background: 'var(--error-soft)', color: 'var(--error)' }}>
              {formError}
            </div>
          )}
          <div
            className="-mx-5 flex gap-3 border-t px-5 pb-5 pt-4"
            style={{ background: 'var(--command-menu-bg)', borderColor: 'var(--command-menu-border)' }}
          >
            <button
              className="flex-1 flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg font-medium text-sm transition-all duration-200"
              style={{
                background: 'linear-gradient(140deg, #5f71ff, #7286ff)',
                color: '#ffffff',
                opacity: saving ? 0.6 : 1,
              }}
              type="button"
              disabled={saving}
              onClick={() => { void handleSubmit(); }}
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
  onUpdate: (id: string, data: Parameters<typeof updateAutomationCronIPC>[1]) => Promise<void>;
  saving: boolean;
  onViewSession?: (run: AutomationCronRun) => void;
  successRate: number | null;
  last7Days: { date: string; status: 'success' | 'failed' | 'none' }[];
}

function CronDetail({ cron, runs, availableModels, modelsLoading, onRun, onDelete, onUpdate, saving, onViewSession, successRate, last7Days }: CronDetailProps) {
  const { t } = useTranslation();
  const [isEditing, setIsEditing] = useState(false);
  const [showAllRuns, setShowAllRuns] = useState(false);
  const [showMoreMenu, setShowMoreMenu] = useState(false);

  const displayedRuns = showAllRuns ? runs : runs.slice(0, 5);
  const capabilities = inferCapabilities(cron.prompt);
  const executionGraph = buildExecutionGraph(cron.prompt);
  // Last result
  const lastRun = runs[0];
  const lastResult = lastRun ? {
    status: lastRun.run_status,
    error: lastRun.error_message,
    duration: lastRun.started_at && lastRun.ended_at
      ? `${Math.round((lastRun.ended_at - lastRun.started_at) / 1000)}s`
      : null,
  } : null;
  const [draftPrompt, setDraftPrompt] = useState(cron.prompt);
  const [draftScheduleKind, setDraftScheduleKind] = useState<CronScheduleKind>(cron.schedule_kind);
  const [draftEveryMs, setDraftEveryMs] = useState(String(cron.schedule_every_ms ?? 60_000));
  const [draftAt, setDraftAt] = useState(cron.schedule_at ?? '');
  const [draftCronExpr, setDraftCronExpr] = useState(cron.schedule_cron_expr ?? '*/5 * * * *');
  const [draftCronTz, setDraftCronTz] = useState(cron.schedule_cron_tz ?? '');
  const detailScheduleDraft = useMemo(() => scheduleToDraft(cron), [cron]);

  const beginEditing = () => {
    setDraftPrompt(cron.prompt);
    setDraftScheduleKind(cron.schedule_kind);
    setDraftEveryMs(String(cron.schedule_every_ms ?? 60_000));
    setDraftAt(cron.schedule_at ?? '');
    setDraftCronExpr(cron.schedule_cron_expr ?? '*/5 * * * *');
    setDraftCronTz(cron.schedule_cron_tz ?? '');
    setIsEditing(true);
  };

  const cancelEditing = () => {
    setIsEditing(false);
  };

  const saveInlineChanges = async () => {
    const schedule = draftScheduleKind === 'at'
      ? { kind: 'at' as const, at: draftAt }
      : draftScheduleKind === 'every'
        ? { kind: 'every' as const, everyMs: Number(draftEveryMs) }
        : { kind: 'cron' as const, cronExpr: draftCronExpr, cronTz: draftCronTz || null };

    await onUpdate(cron.id, {
      schedule,
      prompt: draftPrompt,
    });
    setIsEditing(false);
  };

  if (isEditing) {
    return (
      <CronEditor
        initialData={editorStateFromCron(cron)}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        saving={saving}
        onCancel={cancelEditing}
        onSave={async (data) => {
          const { enabled, ...patch } = data;
          await onUpdate(cron.id, {
            ...patch,
            status: enabled === false ? 'disabled' : 'enabled',
          });
          setIsEditing(false);
        }}
      />
    );
  }

  return (
    <>
      {/* Header */}
      <div className="px-8 pt-7 pb-5 flex items-start justify-between" style={{ background: 'var(--main-bg)' }}>
        <div className="min-w-0">
          <p className="mb-1 text-xs" style={{ color: 'var(--accent)' }}>{getFriendlySchedule(cron)}</p>
          <h3 className="font-medium text-lg truncate" style={{ color: 'var(--text)' }}>{cron.name}</h3>
        </div>
        <div className="relative">
          <button
            type="button"
            aria-label="更多操作"
            aria-expanded={showMoreMenu}
            className="flex h-9 w-9 items-center justify-center rounded-full transition-colors"
            style={{ color: 'var(--text)' }}
            onClick={() => setShowMoreMenu((visible) => !visible)}
            onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--surface-hover)'; }}
            onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
          >
            <DotsThree size={22} weight="bold" />
          </button>
          {showMoreMenu && (
            <div
              className="absolute right-0 top-11 z-20 w-36 overflow-hidden rounded-xl py-1 shadow-lg"
              style={{ background: 'var(--surface)', border: '1px solid var(--border)' }}
            >
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm transition-colors"
                style={{ color: 'var(--text)' }}
                onClick={() => { setShowMoreMenu(false); beginEditing(); }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--surface-hover)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                编辑计划
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm transition-colors"
                style={{ color: 'var(--success)' }}
                onClick={() => { setShowMoreMenu(false); onRun(); }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--success-soft)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                立即运行
              </button>
              <button
                type="button"
                className="w-full px-3 py-2 text-left text-sm transition-colors"
                style={{ color: 'var(--error)' }}
                onClick={() => { setShowMoreMenu(false); onDelete(); }}
                onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--error-soft)'; }}
                onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
              >
                删除计划
              </button>
            </div>
          )}
        </div>
        <div className="hidden items-center gap-2">
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
            编辑
          </button>
          {lastRun?.session_id && onViewSession && (
            <button
              className="px-3 py-1.5 rounded-md text-xs font-medium transition-all duration-150"
              style={{ background: 'var(--text)', color: 'var(--main-bg)' }}
              onClick={() => onViewSession(lastRun)}
            >
              打开聊天
            </button>
          )}
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
        <div className="px-8 pb-8 pt-4">
          <section>
            <p className="mb-3 text-xs font-medium" style={{ color: 'var(--muted)' }}>提示词</p>
            <textarea
              readOnly={!isEditing}
              value={isEditing ? draftPrompt : cron.prompt}
              aria-label="提示词"
              className="min-h-52 w-full resize-none rounded-2xl px-5 py-4 text-[15px] leading-7 outline-none"
              style={{ background: 'var(--main-bg)', border: '1px solid var(--border)', color: 'var(--text)' }}
              onChange={(event) => setDraftPrompt(event.target.value)}
            />
          </section>

          <section className="mt-8">
            <p className="mb-3 text-xs font-medium" style={{ color: 'var(--muted)' }}>频率</p>
            <div className="w-full overflow-hidden rounded-2xl" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
              {isEditing ? (
                <>
                  <div className="flex items-center justify-between gap-4 px-5 py-4 text-sm">
                    <span style={{ color: 'var(--text)' }}>重复</span>
                    <select
                      value={draftScheduleKind}
                      className="min-w-28 rounded-lg px-2 py-1.5 text-right outline-none"
                      style={{ background: 'var(--surface)', color: 'var(--text)' }}
                      onChange={(event) => setDraftScheduleKind(event.target.value as CronScheduleKind)}
                    >
                      <option value="every">重复</option>
                      <option value="at">一次</option>
                      <option value="cron">自定义</option>
                    </select>
                  </div>
                  {draftScheduleKind === 'every' && (
                    <div className="flex items-center justify-between gap-4 px-5 py-4 text-sm" style={{ borderTop: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text)' }}>间隔</span>
                      <div className="flex items-center gap-2" style={{ color: 'var(--muted)' }}>
                        <input
                          type="number"
                          min="1"
                          value={Number(draftEveryMs) / 60_000}
                          className="w-20 rounded-lg px-2 py-1.5 text-right outline-none"
                          style={{ background: 'var(--surface)', color: 'var(--text)' }}
                          onChange={(event) => setDraftEveryMs(String(Number(event.target.value || '0') * 60_000))}
                        />
                        分钟
                      </div>
                    </div>
                  )}
                  {draftScheduleKind === 'at' && (
                    <div className="flex items-center justify-between gap-4 px-5 py-4 text-sm" style={{ borderTop: '1px solid var(--border)' }}>
                      <span style={{ color: 'var(--text)' }}>时间</span>
                      <input
                        type="datetime-local"
                        value={draftAt ? draftAt.slice(0, 16) : ''}
                        className="rounded-lg px-2 py-1.5 outline-none"
                        style={{ background: 'var(--surface)', color: 'var(--text)' }}
                        onChange={(event) => setDraftAt(event.target.value)}
                      />
                    </div>
                  )}
                  {draftScheduleKind === 'cron' && (
                    <div className="space-y-3 px-5 py-4" style={{ borderTop: '1px solid var(--border)' }}>
                      <input
                        value={draftCronExpr}
                        className="w-full rounded-lg px-3 py-2 font-mono text-sm outline-none"
                        style={{ background: 'var(--surface)', color: 'var(--text)' }}
                        onChange={(event) => setDraftCronExpr(event.target.value)}
                      />
                      <input
                        value={draftCronTz}
                        placeholder="本地时间"
                        className="w-full rounded-lg px-3 py-2 text-sm outline-none"
                        style={{ background: 'var(--surface)', color: 'var(--text)' }}
                        onChange={(event) => setDraftCronTz(event.target.value)}
                      />
                    </div>
                  )}
                </>
              ) : (
                <button
                  type="button"
                  className="w-full text-left transition-colors"
                  onClick={beginEditing}
                  onMouseEnter={(event) => { event.currentTarget.style.background = 'var(--surface-hover)'; }}
                  onMouseLeave={(event) => { event.currentTarget.style.background = 'transparent'; }}
                >
                  <div className="flex items-center justify-between px-5 py-4 text-sm">
                    <span style={{ color: 'var(--text)' }}>重复</span>
                    <span className="flex items-center gap-2" style={{ color: 'var(--muted)' }}>
                      {cron.schedule_kind === 'at' ? '一次' : '重复'} <span aria-hidden="true">›</span>
                    </span>
                  </div>
                  <div className="flex items-center justify-between px-5 py-4 text-sm" style={{ borderTop: '1px solid var(--border)' }}>
                    <span style={{ color: 'var(--text)' }}>频率</span>
                    <span className="flex items-center gap-2" style={{ color: 'var(--muted)' }}>
                      {describeScheduleDraft(detailScheduleDraft)} <span aria-hidden="true">›</span>
                    </span>
                  </div>
                </button>
              )}
            </div>
          </section>

          <section className="mt-6">
            <div className="flex items-center justify-between rounded-2xl px-5 py-4 text-sm" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
              <span style={{ color: 'var(--text)' }}>下次运行</span>
              <span className="text-right" style={{ color: 'var(--muted)' }}>
                {formatDateShort(cron.next_run_at)}
              </span>
            </div>
          </section>

          <section className="mt-4">
            <button
              type="button"
              className="flex w-full items-center justify-between gap-5 rounded-2xl px-5 py-4 text-left text-sm transition-colors"
              style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}
              onClick={beginEditing}
            >
              <span style={{ color: 'var(--text)' }}>工作目录</span>
              <span className="truncate" style={{ color: 'var(--muted)' }}>{cron.working_directory || '~/.duya/workspace'}</span>
            </button>
          </section>
        </div>

        <div className="hidden">
        {/* Daily Brief Section */}
        <div className="p-6 border-b border-[var(--border)]">
          <span className="text-xs font-semibold tracking-wider" style={{ color: 'var(--muted)' }}>计划</span>

          <div className="mt-3 overflow-hidden rounded-xl divide-y divide-[var(--border)]" style={{ background: 'var(--surface)', border: '1px solid var(--border)', borderColor: 'var(--border)' }}>
            {/* Status Card */}
            <div className="flex items-center justify-between px-4 py-3.5" style={{ background: 'transparent' }}>
              <span className="text-sm" style={{ color: 'var(--text)' }}>重复</span>
              <p className="text-sm" style={{ color: 'var(--muted)' }}>
                {getFriendlySchedule(cron)}
              </p>
            </div>

            {/* Next Run Card */}
            <div className="flex items-center justify-between px-4 py-3.5" style={{ background: 'transparent' }}>
              <span className="text-sm" style={{ color: 'var(--text)' }}>下次运行</span>
              <div className="text-right">
                <p className="text-sm" style={{ color: 'var(--text)' }}>{formatRelativeTime(cron.next_run_at, t)}</p>
                <p className="text-xs mt-0.5" style={{ color: 'var(--muted)' }}>{formatDateShort(cron.next_run_at)}</p>
              </div>
            </div>

            {/* Last Result Card */}
            <div className="flex items-center justify-between px-4 py-3.5" style={{ background: 'transparent' }}>
              <span className="text-sm" style={{ color: 'var(--text)' }}>上次运行</span>
              <div className="text-right">
                <p className="text-sm" style={{ color: 'var(--text)' }}>
                  {lastRun?.started_at ? formatDateShort(lastRun.started_at) : '尚未运行'}
                </p>
                {lastResult && (
                  <p className="text-xs mt-0.5" style={{ color: lastResult.status === 'success' ? 'var(--success)' : 'var(--error)' }}>
                    {lastResult.status === 'success' ? '已完成' : '未完成'}
                  </p>
                )}
              </div>
            </div>

            <div className="flex items-center justify-between px-4 py-3.5" style={{ background: 'transparent' }}>
              <span className="text-sm" style={{ color: 'var(--text)' }}>状态</span>
              <p className="text-sm" style={{ color: cron.status === 'error' ? 'var(--error)' : cron.status === 'disabled' ? 'var(--muted)' : 'var(--success)' }}>
                {cron.status === 'error' ? '需要处理' : cron.status === 'disabled' ? '已暂停' : '已启用'}
              </p>
            </div>

            <div className="hidden rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
              <span className="text-xs font-medium" style={{ color: 'var(--muted)' }}>{t('automation.nextRun')}</span>
              <p className="text-sm font-medium mt-1" style={{ color: 'var(--text)' }}>
                {formatDateShort(cron.next_run_at)}
              </p>
              <p className="text-xs" style={{ color: 'var(--muted)' }}>
                {formatRelativeTime(cron.next_run_at, t)}
              </p>
            </div>

            <div className="hidden rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
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
            <div className="hidden rounded-lg p-3" style={{ background: 'var(--main-bg)', border: '1px solid var(--border)' }}>
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
        <div className="p-6 border-b border-[var(--border)]">
          <span className="text-xs font-semibold tracking-wider" style={{ color: 'var(--muted)' }}>提示词</span>
          <div className="rounded-xl p-4 mt-3 max-h-72 overflow-y-auto whitespace-pre-wrap text-sm leading-6 bg-black/30" style={{ border: '1px solid var(--border)', color: 'var(--text)' }}>
            {cron.prompt}
          </div>
        </div>

        {/* Execution Graph Section */}
        <div className="hidden p-4 border-b border-[var(--border)]">
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
        <div className="hidden p-4">
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
      </div>
      {isEditing ? (
        <div className="flex gap-3 px-8 pb-6 pt-3" style={{ background: 'var(--main-bg)', borderTop: '1px solid var(--border)' }}>
          <button
            type="button"
            disabled={saving}
            className="flex-1 rounded-full px-4 py-3 text-sm font-medium transition-opacity"
            style={{ background: 'var(--text)', color: 'var(--main-bg)', opacity: saving ? 0.6 : 1 }}
            onClick={() => { void saveInlineChanges(); }}
          >
            {saving ? '保存中…' : '保存更改'}
          </button>
          <button
            type="button"
            className="rounded-full px-5 py-3 text-sm font-medium transition-colors"
            style={{ color: 'var(--text)', border: '1px solid var(--border)' }}
            onClick={cancelEditing}
          >
            取消
          </button>
        </div>
      ) : lastRun?.session_id && onViewSession && (
        <div className="px-8 pb-6 pt-3" style={{ background: 'var(--main-bg)', borderTop: '1px solid var(--border)' }}>
          <button
            type="button"
            className="w-full rounded-full px-4 py-3 text-sm font-medium transition-opacity"
            style={{ background: 'var(--text)', color: 'var(--main-bg)' }}
            onClick={() => onViewSession(lastRun)}
            onMouseEnter={(event) => { event.currentTarget.style.opacity = '0.82'; }}
            onMouseLeave={(event) => { event.currentTarget.style.opacity = '1'; }}
          >
            打开聊天
          </button>
        </div>
      )}
    </>
  );
}
