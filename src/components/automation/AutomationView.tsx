import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import type {
  AutomationCron,
  AutomationCronRun,
  AutomationTemplate,
  ConcurrencyPolicy,
  CreateAutomationCronInput,
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
  PlusIcon,
  PlayIcon,
  TrashIcon,
  ClockIcon,
  WarningCircleIcon,
  XCircleIcon,
  SpinnerGapIcon,
  SquaresFourIcon,
  DotsThreeIcon,
  XIcon,
} from '@/components/icons';
import { AutomationEmptyState } from './AutomationEmptyState';
import { QuickCronChatModal } from './QuickCronChatModal';
import { TemplateMarketModal } from './TemplateMarketModal';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';
import { CronScheduleCard } from './CronScheduleCard';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  SettingsSection,
  SettingsCard,
  SettingsRow,
} from '@/components/settings/ui';
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
      return <span className="h-4 w-4 rounded-full border-2 border-muted-foreground" aria-label="已启用" />;
    case 'error':
      return <WarningCircleIcon size={14} className="text-destructive" />;
    case 'disabled':
    default:
      return <XCircleIcon size={14} className="text-muted-foreground" />;
  }
}

const DEFAULT_EDITOR: EditorState = {
  name: '',
  description: '',
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

export function AutomationView() {
  const { t } = useTranslation();
  const hasElectronApi = typeof window !== 'undefined' && !!window.electronAPI?.automation;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crons, setCrons] = useState<AutomationCron[]>([]);
  const [selectedCronId, setSelectedCronId] = useState<string | null>(null);
  const [runs, setRuns] = useState<AutomationCronRun[]>([]);

  // Edit modal state (create & edit)
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editingCron, setEditingCron] = useState<AutomationCron | null>(null);

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
    setEditingCron(null);
    setEditModalOpen(true);
  }

  function handleEditCron(cron: AutomationCron): void {
    setEditingCron(cron);
    setEditModalOpen(true);
  }

  function handleCloseEditModal(): void {
    setEditModalOpen(false);
    setEditingCron(null);
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

  async function handleSaveCron(
    cronId: string | undefined,
    data: CreateAutomationCronInput,
  ): Promise<void> {
    if (!hasElectronApi) return;
    try {
      setSaving(true);
      setError(null);
      if (cronId) {
        const { enabled, ...patch } = data;
        await updateAutomationCronIPC(cronId, {
          ...patch,
          status: enabled === false ? 'disabled' : 'enabled',
        });
        await reloadCrons(cronId);
      } else {
        const created = await createAutomationCronIPC(data);
        await reloadCrons(created.id);
      }
      handleCloseEditModal();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    } finally {
      setSaving(false);
    }
  }

  const showEmptyState = !loading && crons.length === 0;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between px-8 pt-8 pb-5">
        <div>
          <h2 className="text-3xl font-bold tracking-tight text-foreground" style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}>已计划</h2>
          <p className="mt-2 text-sm text-muted-foreground">让 Duya 帮你安排任务、设置提醒，或定期跟进更新。</p>
        </div>
        {!showEmptyState && (
          <div className="flex items-center gap-2">
            <Button
              className="whitespace-nowrap rounded-full"
              onClick={handleViewTemplates}
              type="button"
              variant="secondary"
              size="md"
            >
              <SquaresFourIcon size={16} />
              {t('automation.templates')}
            </Button>
          </div>
        )}
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-8 mb-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 flex items-center gap-2">
          <WarningCircleIcon size={16} className="text-destructive" />
          <span className="text-sm text-destructive">{error}</span>
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
              <Button
                type="button"
                variant="secondary"
                size="md"
                onClick={handleCreateNew}
                className="mb-7 flex items-center gap-3 rounded-full px-5 py-4 text-left"
              >
                <PlusIcon size={20} />
                <span className="text-base">安排任务</span>
              </Button>
              <div className="flex-1 overflow-y-auto scrollbar-thin">
                {loading ? (
                  <div className="flex items-center justify-center h-32 text-muted-foreground">
                    <SpinnerGapIcon size={20} className="animate-spin mr-2" />
                    {t('automation.loading')}
                  </div>
                ) : crons.length === 0 ? (
                  <div className="flex flex-col items-center justify-center h-32 text-center p-4">
                    <ClockIcon size={32} className="mb-2 opacity-30 text-muted-foreground" />
                    <p className="text-sm text-muted-foreground">{t('automation.noAutomations')}</p>
                  </div>
                ) : (
                  <div className="space-y-0">
                    {crons.map((cron) => {
                      const isSelected = selectedCronId === cron.id;
                      return (
                        <div
                          key={cron.id}
                          className={`px-5 py-4 cursor-pointer transition-all duration-200 rounded-2xl border-b hover:bg-[var(--surface-hover)] ${
                            isSelected
                              ? 'bg-[var(--surface)] border-foreground'
                              : 'bg-transparent border-border/50'
                          }`}
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
                              {isSelected ? (
                                <span className="h-3 w-3 rounded-full bg-accent" />
                              ) : (
                                getStatusIcon(cron.status)
                              )}
                              <span className="font-medium text-sm truncate text-foreground">{cron.name}</span>
                            </div>
                          </div>
                          <div className="flex items-center gap-1.5 text-xs ml-7 text-muted-foreground">
                            <span>{getFriendlySchedule(cron)}</span>
                            <span>·</span>
                            <span>下次运行 {formatRelativeTime(cron.next_run_at, t)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </section>

          {/* Detail/Editor Panel - Right Side */}
          <section className="flex flex-col h-full min-h-0 overflow-hidden border-l border-border/50">
            {selectedCron ? (
              <CronDetail
                cron={selectedCron}
                runs={runs}
                onRun={() => void runNow(selectedCron)}
                onDelete={() => void removeCron(selectedCron)}
                onEdit={() => handleEditCron(selectedCron)}
                onViewSession={handleOpenChat}
              />
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-center p-8">
                <p className="text-base font-medium mb-1 text-foreground">{t('automation.selectAutomation')}</p>
                <p className="text-sm text-muted-foreground">{t('automation.selectAutomationDesc')}</p>
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

      {/* Create / Edit Cron Modal */}
      <CronEditModal
        cron={editingCron}
        isOpen={editModalOpen}
        onClose={handleCloseEditModal}
        onSave={handleSaveCron}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        saving={saving}
      />
    </div>
  );
}

function CronEditModal({
  cron,
  isOpen,
  onClose,
  onSave,
  availableModels,
  modelsLoading,
  saving,
}: {
  cron: AutomationCron | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (cronId: string | undefined, data: CreateAutomationCronInput) => Promise<void>;
  availableModels: ModelOption[];
  modelsLoading: boolean;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const initial = cron ? editorStateFromCron(cron) : DEFAULT_EDITOR;
  const [editor, setEditor] = useState<EditorState>(initial);
  const [modelError, setModelError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setEditor(initial);
      setModelError(null);
      setFormError(null);
    }
  }, [isOpen, cron]);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

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

      await onSave(cron?.id, {
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
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
      onClick={onClose}
    >
      <div
        className="flex max-h-[90vh] w-full max-w-xl flex-col overflow-hidden rounded-xl border border-border/50 bg-[var(--sidebar-bg)] shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
          <h3 className="text-lg font-semibold text-foreground">
            {cron ? t('automation.editAutomation') : t('automation.newAutomation')}
          </h3>
          <IconButton variant="ghost" size="sm" aria-label="关闭" onClick={onClose}>
            <XIcon size={18} />
          </IconButton>
        </div>

        <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
          <div className="space-y-4 pb-4">
            <SettingsSection title="任务">
              <SettingsCard>
                <SettingsRow label="任务名称">
                  <Input
                    type="text"
                    size="sm"
                    placeholder={t('automation.namePlaceholder')}
                    value={editor.name}
                    onChange={(event) => setEditor((prev) => ({ ...prev, name: event.target.value }))}
                    className="min-w-40"
                  />
                </SettingsRow>
                <SettingsRow label="提示词" className="flex-col items-stretch gap-2">
                  <textarea
                    className="w-full min-h-[120px] rounded-md border border-border/50 bg-chip px-3 py-2 text-sm text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50 resize-y"
                    placeholder={t('automation.promptPlaceholder')}
                    value={editor.prompt}
                    onChange={(event) => setEditor((prev) => ({ ...prev, prompt: event.target.value }))}
                  />
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="频率">
              <CronScheduleCard
                value={editor.scheduleDraft}
                onChange={(scheduleDraft) => setEditor((prev) => ({ ...prev, scheduleDraft }))}
              />
            </SettingsSection>

            <SettingsSection title="设置">
              <SettingsCard>
                <SettingsRow label="模型" description={modelError || undefined}>
                  <ModelSelector
                    models={availableModels}
                    selectedModelId={editor.model}
                    onSelect={(modelId) => {
                      setEditor((prev) => ({ ...prev, model: modelId }));
                      setModelError(null);
                    }}
                    loading={modelsLoading}
                    variant="full"
                  />
                </SettingsRow>
                <SettingsRow label="工作目录" description="留空时使用默认目录">
                  <Input
                    type="text"
                    size="sm"
                    placeholder="~/.duya/workspace"
                    value={editor.workingDirectory}
                    onChange={(event) => setEditor((prev) => ({ ...prev, workingDirectory: event.target.value }))}
                    className="min-w-40"
                  />
                </SettingsRow>
                <SettingsRow label="输入参数" description='JSON 对象，运行时会传入提示词'>
                  <textarea
                    className="w-full min-w-40 min-h-[60px] rounded-md border border-border/50 bg-chip px-3 py-2 text-sm font-mono text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50 resize-none"
                    placeholder='{"key": "value"}'
                    value={editor.inputParams}
                    onChange={(event) => setEditor((prev) => ({ ...prev, inputParams: event.target.value }))}
                  />
                </SettingsRow>
              </SettingsCard>
            </SettingsSection>

            <SettingsSection title="高级">
              <SettingsCard>
                <SettingsRow label="并发策略">
                  <select
                    className="rounded-md border border-border/50 bg-chip px-3 py-1.5 text-sm text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50 cursor-pointer"
                    value={editor.concurrencyPolicy}
                    onChange={(event) =>
                      setEditor((prev) => ({ ...prev, concurrencyPolicy: event.target.value as ConcurrencyPolicy }))
                    }
                  >
                    <option value="skip">{t('automation.concurrencySkip')}</option>
                    <option value="parallel">{t('automation.concurrencyParallel')}</option>
                    <option value="queue">{t('automation.concurrencyQueue')}</option>
                    <option value="replace">{t('automation.concurrencyReplace')}</option>
                  </select>
                </SettingsRow>
                <SettingsRow label="最大重试次数">
                  <Input
                    type="number"
                    size="sm"
                    min="0"
                    max="10"
                    value={editor.maxRetries}
                    onChange={(event) => setEditor((prev) => ({ ...prev, maxRetries: event.target.value }))}
                    className="w-20"
                  />
                </SettingsRow>
                <SettingsRow
                  label="启用"
                  description={editor.enabled ? '任务将按计划运行' : '任务已暂停'}
                  action={
                    <Switch
                      checked={editor.enabled}
                      onCheckedChange={(checked) => setEditor((prev) => ({ ...prev, enabled: checked }))}
                      ariaLabel={t('automation.enabled')}
                    />
                  }
                />
              </SettingsCard>
            </SettingsSection>

            {formError && (
              <div
                className="rounded-xl border border-destructive/50 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                role="alert"
              >
                {formError}
              </div>
            )}
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border/50 px-5 py-4">
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            {t('automation.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={saving}
            onClick={() => { void handleSubmit(); }}
          >
            {saving ? (
              <>
                <SpinnerGapIcon size={16} className="animate-spin" />
                {t('automation.saving')}
              </>
            ) : (
              <>{cron ? t('automation.saveChanges') : t('automation.createAutomation')}</>
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

// Cron Detail Component
interface CronDetailProps {
  cron: AutomationCron;
  runs: AutomationCronRun[];
  onRun: () => void;
  onDelete: () => void;
  onEdit: () => void;
  onViewSession?: (run: AutomationCronRun) => void;
}

function CronDetail({ cron, runs, onRun, onDelete, onEdit, onViewSession }: CronDetailProps) {
  const { t } = useTranslation();
  const [showMoreMenu, setShowMoreMenu] = useState(false);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  const detailScheduleDraft = useMemo(() => scheduleToDraft(cron), [cron]);

  useEffect(() => {
    if (!showMoreMenu) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!moreMenuRef.current?.contains(event.target as Node)) {
        setShowMoreMenu(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    return () => window.removeEventListener('pointerdown', onPointerDown);
  }, [showMoreMenu]);

  const concurrencyLabels: Record<ConcurrencyPolicy, string> = {
    skip: t('automation.concurrencySkip'),
    parallel: t('automation.concurrencyParallel'),
    queue: t('automation.concurrencyQueue'),
    replace: t('automation.concurrencyReplace'),
  };

  return (
    <>
      {/* Header */}
      <div className="flex items-start justify-between border-b border-border/50 px-8 pt-7 pb-5">
        <div className="min-w-0">
          <p className="mb-1 text-xs text-accent">{getFriendlySchedule(cron)}</p>
          <h3 className="truncate text-lg font-semibold text-foreground">{cron.name}</h3>
        </div>
        <div className="flex items-center gap-2">
          <Button type="button" variant="primary" size="sm" onClick={onRun}>
            <PlayIcon size={16} />
            立即运行
          </Button>
          <div className="relative" ref={moreMenuRef}>
            <IconButton
              type="button"
              aria-label="更多操作"
              aria-expanded={showMoreMenu}
              variant="default"
              shape="round"
              size="md"
              onClick={() => setShowMoreMenu((visible) => !visible)}
            >
              <DotsThreeIcon size={22} />
            </IconButton>
            {showMoreMenu && (
              <div className="absolute right-0 top-11 z-20 w-36 overflow-hidden rounded-xl border border-border/50 bg-[var(--surface)] py-1 shadow-lg">
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start px-3 py-2 text-left text-sm"
                  onClick={() => { setShowMoreMenu(false); onEdit(); }}
                >
                  编辑计划
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="w-full justify-start px-3 py-2 text-left text-sm"
                  onClick={() => { setShowMoreMenu(false); onRun(); }}
                >
                  立即运行
                </Button>
                <Button
                  type="button"
                  variant="danger"
                  size="sm"
                  className="w-full justify-start px-3 py-2 text-left text-sm"
                  onClick={() => { setShowMoreMenu(false); onDelete(); }}
                >
                  删除计划
                </Button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-8 pb-8 pt-5 scrollbar-thin">
        <SettingsSection title="任务" description="名称和每次运行执行的提示词">
          <SettingsCard>
            <SettingsRow label="名称" onClick={onEdit} action={<span className="text-sm text-muted-foreground truncate max-w-[200px]">{cron.name}</span>} />
            <SettingsRow
              label="提示词"
              description={cron.prompt}
              onClick={onEdit}
              action={<span className="text-sm text-muted-foreground">›</span>}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="计划" description="运行频率和下次执行时间">
          <SettingsCard>
            <SettingsRow label="频率" onClick={onEdit} action={<span className="text-sm text-muted-foreground">{describeScheduleDraft(detailScheduleDraft)}</span>} />
            <SettingsRow label="下次运行" action={<span className="text-sm text-muted-foreground">{formatDateShort(cron.next_run_at)}</span>} />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="设置" description="模型、工作目录和运行参数">
          <SettingsCard>
            <SettingsRow label="模型" onClick={onEdit} action={<span className="text-sm text-muted-foreground truncate max-w-[200px]">{cron.model}</span>} />
            <SettingsRow label="工作目录" onClick={onEdit} action={<span className="text-sm text-muted-foreground truncate max-w-[200px]">{cron.working_directory || '默认'}</span>} />
            <SettingsRow
              label="输入参数"
              description={cron.input_params || '{ }'}
              onClick={onEdit}
              action={<span className="text-sm text-muted-foreground">›</span>}
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="高级" description="并发策略、重试和开关">
          <SettingsCard>
            <SettingsRow label="并发策略" onClick={onEdit} action={<span className="text-sm text-muted-foreground">{concurrencyLabels[cron.concurrency_policy]}</span>} />
            <SettingsRow label="最大重试次数" onClick={onEdit} action={<span className="text-sm text-muted-foreground">{cron.max_retries}</span>} />
            <SettingsRow
              label="状态"
              description={cron.status === 'enabled' ? '按计划运行' : '已暂停'}
              onClick={onEdit}
              action={
                <span
                  className={`inline-flex h-2.5 w-2.5 rounded-full ${
                    cron.status === 'enabled' ? 'bg-[var(--success)]' : 'bg-muted'
                  }`}
                />
              }
            />
          </SettingsCard>
        </SettingsSection>

        <SettingsSection title="运行历史">
          {runs.length === 0 ? (
            <SettingsCard divided={false} className="py-8 text-center text-sm text-muted-foreground">
              {t('automation.statusNoRuns')}
            </SettingsCard>
          ) : (
            <SettingsCard>
              {runs.slice(0, 5).map((run, index) => {
                const hasSession = !!run.session_id && !!onViewSession;
                return (
                  <SettingsRow
                    key={run.id}
                    label={
                      <div className="flex items-center gap-3">
                        <RunStatusIndicator status={run.run_status} />
                        <span>{formatDateShort(run.started_at)}</span>
                      </div>
                    }
                    description={run.error_message || undefined}
                    className={index > 0 ? 'border-t border-border/20' : undefined}
                    action={
                      hasSession ? (
                        <Button type="button" variant="ghost" size="sm" onClick={() => onViewSession!(run)}>
                          {t('automation.viewLogs')}
                        </Button>
                      ) : (
                        <span className="text-sm text-muted-foreground capitalize">{run.run_status}</span>
                      )
                    }
                  />
                );
              })}
            </SettingsCard>
          )}
        </SettingsSection>
      </div>
    </>
  );
}

function RunStatusIndicator({ status }: { status: string }) {
  switch (status) {
    case 'success':
      return <span className="h-3 w-3 flex-shrink-0 rounded-full bg-[var(--success)]" aria-label="成功" />;
    case 'failed':
      return <XCircleIcon size={14} className="flex-shrink-0 text-destructive" />;
    case 'running':
      return <SpinnerGapIcon size={14} className="flex-shrink-0 animate-spin text-accent" />;
    default:
      return <ClockIcon size={14} className="flex-shrink-0 text-muted-foreground" />;
  }
}
