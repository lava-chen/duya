import { useEffect, useMemo, useState, useCallback } from 'react';
import type {
  AutomationCron,
  AutomationTemplate,
  ConcurrencyPolicy,
  CreateAutomationCronInput,
  CronRunHandle,
  CronSessionSummary,
} from '@/types/automation';
import {
  createAutomationCronIPC,
  deleteAutomationCronIPC,
  listAutomationCronSessionsIPC,
  listAutomationCronsIPC,
  listAutomationTemplatesIPC,
  runAutomationCronIPC,
  updateAutomationCronIPC,
} from '@/lib/automation-ipc';
import { CronChatModal } from './CronChatModal';
import { CronHistoryPanel } from './CronHistoryPanel';
import { ModelSelector, type ModelOption } from '@/components/chat/ModelSelector';
import { listProvidersIPC, getOllamaModelsIPC, type Provider } from '@/lib/ipc-client';
import {
  PlayIcon,
  ClockIcon,
  WarningCircleIcon,
  SpinnerGapIcon,
  SquaresFourIcon,
  XIcon,
  ChatCirclePlusIcon,
  MonitorIcon,
  PencilIcon,
  ClockCounterClockwiseIcon,
  TrashIcon,
} from '@/components/icons';
import { AutomationEmptyState } from './AutomationEmptyState';
import { QuickCronChatModal } from './QuickCronChatModal';
import { TemplateMarketModal } from './TemplateMarketModal';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Switch } from '@/components/ui/Switch';
import {
  createDefaultScheduleDraft,
  describeScheduleDraft,
  draftToSchedule,
  scheduleToDraft,
  type ScheduleDraft,
  PRESET_LABELS,
  WEEKDAYS,
} from './cron-schedule';

function buildCronCreationPrompt(userPrompt: string, templatePrompt?: string): string {
  const sections = [
    'Create a cron job automation. Here is the user request:',
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
    '1. There is no dedicated "cron" tool — create the job by running the `duya_cli` command with argv ["cron", "create", "--cron", "<json>", "--yes"].',
    '2. The --cron JSON must match this shape:',
    '   { "name": "...", "prompt": "...", "schedule": { "kind": "cron", "expr": "0 9 * * *" } }',
    '   schedule kinds: "every" ({ "every": "1d" }), "cron" ({ "expr": "0 9 * * *", "tz": "Asia/Shanghai" }), or "once" ({ "at": "2026-12-31T23:59:00Z" }).',
    '3. Analyze the request to determine the schedule (cron expression, interval, or specific time).',
    '4. Extract a concise but descriptive name for the cron job.',
    '5. The "prompt" field should contain the task description for each execution.',
    '6. Omit "enabled" (defaults to true).',
  );

  return sections.join('\n');
}

type EditorState = {
  id?: string;
  name: string;
  prompt: string;
  concurrencyPolicy: ConcurrencyPolicy;
  maxRetries: string;
  enabled: boolean;
  model: string;
  workingDirectory: string;
  scheduleDraft: ScheduleDraft;
};

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
  const fixedMinute = /^\d+$/.test(minute) ? Number(minute) : NaN;
  if (
    hour === '*' && dayOfMonth === '*' && month === '*' && dayOfWeek === '*' &&
    Number.isInteger(fixedMinute) && fixedMinute >= 0 && fixedMinute <= 59
  ) {
    return fixedMinute === 0 ? '每小时' : `每小时第 ${minute} 分钟`;
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
  const s = cron.schedule;
  switch (s.kind) {
    case 'every':
      return `每 ${s.every}`;
    case 'once':
      return s.at ? `一次性 · ${formatDateShort(Date.parse(s.at))}` : '一次性任务';
    case 'cron':
      return formatCronSchedule(s.expr);
    default:
      return '未设置计划';
  }
}

const DEFAULT_EDITOR: EditorState = {
  name: '',
  prompt: '',
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
    prompt: cron.prompt,
    concurrencyPolicy: cron.concurrencyPolicy,
    maxRetries: String(cron.maxRetries),
    enabled: cron.enabled,
    model: cron.model,
    workingDirectory: cron.workingDirectory || '',
    scheduleDraft: scheduleToDraft(cron),
  };
}

type TabKey = 'configured' | 'history' | 'templates';

export function AutomationView() {
  const { t } = useTranslation();
  const hasElectronApi = typeof window !== 'undefined' && !!window.electronAPI?.automation;
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crons, setCrons] = useState<AutomationCron[]>([]);
  const [sessionsMap, setSessionsMap] = useState<Record<string, CronSessionSummary[]>>({});
  const [activeTab, setActiveTab] = useState<TabKey>('configured');

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
  const [selectedRun, setSelectedRun] = useState<{ sessionId: string; runStatus?: string } | null>(null);
  const [selectedCronForRun, setSelectedCronForRun] = useState<AutomationCron | null>(null);

  // Models state
  const [availableModels, setAvailableModels] = useState<ModelOption[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);

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
        const defaultProvider = providers.find((p) => p.isDefault && p.hasApiKey);
        const activeProvider = defaultProvider ?? providers.find((p) => p.hasApiKey);

        if (activeProvider) {
          const isOllama =
            activeProvider.providerType === 'ollama' ||
            activeProvider.baseUrl?.includes('11434') ||
            activeProvider.baseUrl?.includes('ollama');

          if (isOllama) {
            try {
              const baseUrl = activeProvider.baseUrl || 'http://localhost:11434';
              const result = await getOllamaModelsIPC(baseUrl);
              if (result.success && result.models && result.models.length > 0) {
                setAvailableModels(
                  result.models.map((m) => ({
                    id: m.id,
                    display_name: m.name,
                  })),
                );
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
          } catch {
            /* ignore */
          }

          if (enabledModels.length > 0) {
            setAvailableModels(
              enabledModels.map((id) => {
                const cleanId = id.startsWith('"') && id.endsWith('"') ? id.slice(1, -1) : id;
                return { id: cleanId, display_name: cleanId };
              }),
            );
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

  const handleOpenChat = (cron: AutomationCron, sessionId: string) => {
    if (sessionId) {
      setSelectedCronForRun(cron);
      setSelectedRun({ sessionId });
      setChatModalOpen(true);
    }
  };

  const handleCloseChat = () => {
    setChatModalOpen(false);
    setSelectedRun(null);
    setSelectedCronForRun(null);
  };

  async function reloadCrons(): Promise<void> {
    const list = await listAutomationCronsIPC();
    setCrons(list);
  }

  async function reloadAllSessions(): Promise<void> {
    const next: Record<string, CronSessionSummary[]> = {};
    await Promise.all(
      crons.map(async (cron) => {
        try {
          const list = await listAutomationCronSessionsIPC(cron.id, 5, 0);
          next[cron.id] = list;
        } catch {
          next[cron.id] = [];
        }
      }),
    );
    setSessionsMap(next);
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
    if (!hasElectronApi || crons.length === 0) return;
    void reloadAllSessions();
  }, [hasElectronApi, crons.length]);

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

    // ChatView registers __widgetSendMessage only after it mounts, so wait
    // for the bridge instead of assuming a fixed delay. Poll up to 5s in
    // case the view is slow to appear.
    const win = window as unknown as Record<string, unknown>;
    let attempts = 0;
    const intervalId = window.setInterval(() => {
      const sendFn = win.__widgetSendMessage as ((text: string) => void) | undefined;
      if (sendFn) {
        window.clearInterval(intervalId);
        sendFn(prompt);
      } else if (++attempts >= 50) {
        window.clearInterval(intervalId);
      }
    }, 100);
  }

  async function runNow(cron: AutomationCron): Promise<void> {
    if (!hasElectronApi) return;
    try {
      setError(null);
      const handle = await runAutomationCronIPC(cron.id);
      // runCronNow returns the run handle (with session_id) immediately and
      // executes in the background, so jump straight to the run view to watch
      // it live. Provider errors surface synchronously as a thrown error.
      if (handle && handle.sessionId) {
        setSelectedCronForRun(cron);
        setSelectedRun({ sessionId: handle.sessionId, runStatus: 'running' });
        setChatModalOpen(true);
      }
      await reloadCrons();
      await reloadAllSessions();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggleCronStatus(cron: AutomationCron): Promise<void> {
    if (!hasElectronApi) return;
    try {
      setError(null);
      await updateAutomationCronIPC(cron.id, {
        enabled: !cron.enabled,
      });
      await reloadCrons();
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
        await updateAutomationCronIPC(cronId, data);
      } else {
        await createAutomationCronIPC(data);
      }
      await reloadCrons();
      handleCloseEditModal();
    } catch (err) {
      // Surface the error through the edit modal's inline formError (single
      // display point) instead of also setting the page-level banner.
      throw err;
    } finally {
      setSaving(false);
    }
  }

  const showEmptyState = !loading && crons.length === 0 && activeTab === 'configured';

  const allSessions = useMemo(() => {
    const sessions: Array<{ session: CronSessionSummary; cron: AutomationCron; scheduleLabel: string }> = [];
    Object.entries(sessionsMap).forEach(([cronId, list]) => {
      const cron = crons.find((c) => c.id === cronId);
      if (!cron) return;
      list.forEach((session) => sessions.push({ session, cron, scheduleLabel: getFriendlySchedule(cron) }));
    });
    return sessions.sort((a, b) => b.session.updatedAt - a.session.updatedAt);
  }, [sessionsMap, crons]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex items-start justify-between px-8 pt-8 pb-5 gap-4">
        <div>
          <h2
            className="text-3xl font-bold tracking-tight text-foreground"
            style={{ fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif" }}
          >
            {t('automation.title')}
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">{t('automation.subtitle')}</p>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <Button
            className="whitespace-nowrap rounded-lg"
            onClick={handleCreateNew}
            type="button"
            variant="secondary"
            size="md"
          >
            {t('automation.manualCreate')}
          </Button>
          <Button
            className="whitespace-nowrap rounded-lg"
            onClick={handleChatCreate}
            type="button"
            variant="primary"
            size="md"
          >
            <ChatCirclePlusIcon size={16} />
            {t('automation.createInChat')}
          </Button>
        </div>
      </div>

      {/* Tabs */}
      <div className="px-8 border-b border-border/50">
        <div className="flex items-center gap-6">
          {[
            { key: 'configured', label: t('automation.configured') },
            { key: 'history', label: t('automation.executionHistory') },
            { key: 'templates', label: t('automation.taskTemplates') },
          ].map((tab) => {
            const active = activeTab === tab.key;
            return (
              <button
                key={tab.key}
                type="button"
                onClick={() => setActiveTab(tab.key as TabKey)}
                className={`relative pb-3 text-sm font-medium transition-colors ${
                  active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                {tab.label}
                {active && (
                  <span className="absolute bottom-0 left-0 right-0 h-0.5 rounded-t bg-foreground" />
                )}
              </button>
            );
          })}
        </div>
      </div>

      {/* Error Banner */}
      {error && (
        <div className="mx-8 mt-4 rounded-lg border border-destructive/50 bg-destructive/10 p-3 flex items-center gap-2">
          <WarningCircleIcon size={16} className="text-destructive" />
          <span className="text-sm text-destructive">{error}</span>
        </div>
      )}

      {/* Main Content */}
      <div className="flex-1 overflow-hidden px-8 pb-8 min-h-0">
        {showEmptyState ? (
          <div className="h-full flex flex-col items-center justify-center">
            <AutomationEmptyState
              onManualCreate={handleCreateNew}
              onChatCreate={handleChatCreate}
              onViewTemplates={handleViewTemplates}
            />
          </div>
        ) : activeTab === 'configured' ? (
          <div className="h-full flex flex-col min-h-0 pt-5">
            {/* Cron list */}
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
                <div className="rounded-lg border border-border/40 bg-[var(--surface)] overflow-hidden">
                  {/* Header */}
                  <div
                    className="grid items-center gap-4 px-4 py-2 text-xs font-medium text-muted-foreground border-b border-border/30"
                    style={{ gridTemplateColumns: '2fr 1.5fr 100px 140px' }}
                  >
                    <div>{t('automation.task')}</div>
                    <div>{t('automation.schedule')}</div>
                    <div>{t('automation.status')}</div>
                    <div className="text-right">{t('automation.actions')}</div>
                  </div>
                  {/* Rows */}
                  {crons.map((cron) => (
                    <CronListItem
                      key={cron.id}
                      cron={cron}
                      onEdit={() => handleEditCron(cron)}
                      onRun={() => void runNow(cron)}
                      onDelete={() => void removeCron(cron)}
                      onToggleStatus={() => void toggleCronStatus(cron)}
                      onViewRuns={() => setActiveTab('history')}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        ) : activeTab === 'history' ? (
          <CronHistoryPanel
            sessions={allSessions}
            onOpenChat={handleOpenChat}
            onRefresh={reloadAllSessions}
          />
        ) : (
          <div className="h-full flex flex-col pt-5">
            <div className="mb-4 flex items-center justify-between">
              <p className="text-sm text-muted-foreground">{t('automation.createFromTemplateHint')}</p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                onClick={handleViewTemplates}
              >
                <SquaresFourIcon size={16} />
                {t('automation.browseAllTemplates')}
              </Button>
            </div>
            <div className="flex-1 overflow-y-auto scrollbar-thin">
              {templates.length === 0 ? (
                <div className="flex flex-col items-center justify-center h-64 text-center p-4">
                  <SquaresFourIcon size={40} className="mb-3 opacity-30 text-muted-foreground" />
                  <p className="text-sm text-muted-foreground">{t('automation.noTemplates')}</p>
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {templates.map((template) => (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => handleTemplateSelect(template)}
                      className="flex flex-col items-start rounded-xl border border-border/50 bg-[var(--surface)] p-4 text-left transition-colors hover:bg-[var(--surface-hover)]"
                    >
                      <span className="mb-3 text-2xl">{template.icon}</span>
                      <p className="text-sm font-medium text-foreground">{template.label_zh}</p>
                      <p className="mt-1 text-xs text-muted-foreground line-clamp-2">
                        {template.description_zh}
                      </p>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </div>

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
      {chatModalOpen && selectedRun && selectedCronForRun && (
        <CronChatModal
          sessionId={selectedRun.sessionId}
          sessionTitle={`[Cron] ${selectedCronForRun.name}`}
          cronName={selectedCronForRun.name}
          runStatus={selectedRun.runStatus ?? 'running'}
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

function CronListItem({
  cron,
  onEdit,
  onRun,
  onDelete,
  onToggleStatus,
  onViewRuns,
}: {
  cron: AutomationCron;
  onEdit: () => void;
  onRun: () => void;
  onDelete: () => void;
  onToggleStatus: () => void;
  onViewRuns: () => void;
}) {
  const { t } = useTranslation();

  return (
    <div
      className="grid items-center gap-4 px-4 py-3 text-sm border-b border-border/20 transition-colors last:border-b-0 hover:bg-[var(--surface-hover)]"
      style={{ gridTemplateColumns: '2fr 1.5fr 100px 140px' }}
    >
      {/* Task name */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-medium text-foreground">{cron.name}</span>
      </div>

      {/* Schedule */}
      <div className="truncate text-muted-foreground">{getFriendlySchedule(cron)}</div>

      {/* Status */}
      <div className="flex items-center gap-2">
        <Switch
          checked={cron.enabled}
          onCheckedChange={onToggleStatus}
          ariaLabel={t('automation.enabled')}
        />
        {cron.lastError ? (
          <span
            className="text-xs text-destructive"
            title={cron.lastError}
          >
            {t('automation.statusError')}
          </span>
        ) : (
          <span
            className={`text-xs ${
              cron.enabled ? 'text-[var(--success)]' : 'text-muted-foreground'
            }`}
          >
            {cron.enabled ? t('automation.enabled') : t('common.disabled')}
          </span>
        )}
      </div>

      {/* Actions */}
      <div className="flex items-center justify-end gap-1">
        <IconButton
          type="button"
          aria-label={t('automation.runNow')}
          title={t('automation.runNow')}
          variant="ghost"
          shape="square"
          size="sm"
          onClick={onRun}
        >
          <PlayIcon size={16} />
        </IconButton>
        <IconButton
          type="button"
          aria-label={t('automation.edit')}
          title={t('automation.edit')}
          variant="ghost"
          shape="square"
          size="sm"
          onClick={onEdit}
        >
          <PencilIcon size={16} />
        </IconButton>
        <IconButton
          type="button"
          aria-label={t('automation.viewHistory')}
          title={t('automation.viewHistory')}
          variant="ghost"
          shape="square"
          size="sm"
          onClick={onViewRuns}
        >
          <ClockCounterClockwiseIcon size={16} />
        </IconButton>
        <IconButton
          type="button"
          aria-label={t('automation.delete')}
          title={t('automation.delete')}
          variant="ghost"
          shape="square"
          size="sm"
          className="text-destructive hover:bg-destructive/10"
          onClick={onDelete}
        >
          <TrashIcon size={16} />
        </IconButton>
      </div>
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
      const maxRetries = Number(editor.maxRetries || '3');
      const schedule = draftToSchedule(editor.scheduleDraft);
      if (schedule.kind === 'cron' && !schedule.expr?.trim()) throw new Error('请输入 Cron 表达式。');
      if (schedule.kind === 'once' && !schedule.at) throw new Error('请选择运行时间。');
      if (editor.scheduleDraft.endRepeat === 'on' && !editor.scheduleDraft.endAt) throw new Error('请选择结束重复时间。');

      await onSave(cron?.id, {
        name: editor.name.trim(),
        schedule,
        prompt: editor.prompt.trim(),
        model: editor.model.trim(),
        workingDirectory: editor.workingDirectory.trim() || undefined,
        concurrencyPolicy: editor.concurrencyPolicy,
        maxRetries,
        enabled: editor.enabled,
      });
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const updateDraft = (patch: Partial<ScheduleDraft>) => {
    setEditor((prev) => ({ ...prev, scheduleDraft: { ...prev.scheduleDraft, ...patch } }));
  };

  const scheduleOptions: { value: ScheduleDraft['preset']; label: string }[] = [
    { value: 'daily', label: PRESET_LABELS.daily },
    { value: 'weekly', label: PRESET_LABELS.weekly },
    { value: 'weekdays', label: PRESET_LABELS.weekdays },
    { value: 'hourly', label: PRESET_LABELS.hourly },
    { value: 'monthly', label: PRESET_LABELS.monthly },
    { value: 'once', label: PRESET_LABELS.once },
    { value: 'custom', label: PRESET_LABELS.custom },
  ];

  const workingDirDisplay = editor.workingDirectory
    ? editor.workingDirectory.split(/[/\\]/).pop() || editor.workingDirectory
    : '默认工作目录';

  if (!isOpen) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="flex max-h-[90vh] w-full max-w-2xl flex-col overflow-hidden rounded-xl border border-border/50 bg-[var(--sidebar-bg)] shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border/50 px-5 py-4">
          <h3 className="text-base font-semibold text-foreground">
            {cron ? t('automation.editTask') : t('automation.newTask')}
          </h3>
          <div className="flex items-center gap-1">
            {cron && (
              <Button type="button" variant="ghost" size="sm" onClick={onClose}>
                {t('automation.viewHistory')}
              </Button>
            )}
            <IconButton variant="ghost" size="sm" aria-label={t('automation.close')} onClick={onClose}>
              <XIcon size={18} />
            </IconButton>
          </div>
        </div>

        <div className="flex-1 overflow-y-auto p-5 scrollbar-thin">
          <div className="space-y-5">
            {/* Task name */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t('automation.name')}</label>
              <Input
                type="text"
                size="md"
                placeholder={t('automation.namePlaceholder')}
                value={editor.name}
                onChange={(event) => setEditor((prev) => ({ ...prev, name: event.target.value }))}
              />
            </div>

            {/* Trigger time */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t('automation.triggerTime')}</label>
              <div className="flex items-center gap-3">
                <select
                  className="h-10 rounded-lg border border-border/50 bg-chip px-3 text-sm text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50"
                  value={editor.scheduleDraft.preset}
                  onChange={(event) => updateDraft({ preset: event.target.value as ScheduleDraft['preset'] })}
                >
                  {scheduleOptions.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
                {editor.scheduleDraft.preset !== 'once' && editor.scheduleDraft.preset !== 'custom' && (
                  <Input
                    type="time"
                    size="md"
                    value={editor.scheduleDraft.time}
                    onChange={(event) => updateDraft({ time: event.target.value })}
                    className="w-32"
                  />
                )}
                {editor.scheduleDraft.preset === 'weekly' && (
                  <select
                    className="h-10 rounded-lg border border-border/50 bg-chip px-3 text-sm text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50"
                    value={editor.scheduleDraft.weekday}
                    onChange={(event) => updateDraft({ weekday: Number(event.target.value) })}
                  >
                    {WEEKDAYS.map((day) => (
                      <option key={day.value} value={day.value}>
                        {day.label}
                      </option>
                    ))}
                  </select>
                )}
                {editor.scheduleDraft.preset === 'monthly' && (
                  <Input
                    type="number"
                    size="md"
                    min={1}
                    max={31}
                    value={editor.scheduleDraft.monthDay}
                    onChange={(event) => updateDraft({ monthDay: Number(event.target.value) })}
                    className="w-20"
                  />
                )}
                {editor.scheduleDraft.preset === 'custom' && (
                  <Input
                    type="text"
                    size="md"
                    placeholder="0 9 * * *"
                    value={editor.scheduleDraft.cronExpr}
                    onChange={(event) => updateDraft({ cronExpr: event.target.value })}
                    className="font-mono"
                  />
                )}
                {editor.scheduleDraft.preset === 'once' && (
                  <Input
                    type="datetime-local"
                    size="md"
                    value={editor.scheduleDraft.at}
                    onChange={(event) => updateDraft({ at: event.target.value })}
                  />
                )}
              </div>
              <p className="text-xs text-muted-foreground">{describeScheduleDraft(editor.scheduleDraft)}</p>
            </div>

            {/* Prompt */}
            <div className="space-y-2">
              <label className="text-sm font-medium text-foreground">{t('automation.whatToDo')}</label>
              <textarea
                className="w-full min-h-[180px] rounded-lg border border-border/50 bg-chip px-3 py-2.5 text-sm text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50 resize-y"
                placeholder={t('automation.promptPlaceholder')}
                value={editor.prompt}
                onChange={(event) => setEditor((prev) => ({ ...prev, prompt: event.target.value }))}
              />
            </div>

            {/* Model & working dir */}
            <div className="space-y-3 rounded-lg border border-border/50 bg-[var(--surface)] p-4">
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('automation.model')}</label>
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
                {modelError && <p className="text-xs text-destructive">{modelError}</p>}
              </div>
              <div className="space-y-2">
                <label className="text-sm font-medium text-foreground">{t('automation.workingDirectory')}</label>
                <Input
                  type="text"
                  size="md"
                  placeholder="~/.duya/workspace"
                  value={editor.workingDirectory}
                  onChange={(event) => setEditor((prev) => ({ ...prev, workingDirectory: event.target.value }))}
                />
              </div>
            </div>

            {/* Advanced */}
            <div className="space-y-3 rounded-lg border border-border/50 bg-[var(--surface)] p-4">
              <p className="text-sm font-medium text-foreground">{t('automation.advancedSettings')}</p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('automation.concurrencyPolicy')}</label>
                  <select
                    className="h-9 w-full rounded-lg border border-border/50 bg-chip px-3 text-sm text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50"
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
                </div>
                <div className="space-y-2">
                  <label className="text-xs text-muted-foreground">{t('automation.maxRetries')}</label>
                  <Input
                    type="number"
                    size="md"
                    min="0"
                    max="10"
                    value={editor.maxRetries}
                    onChange={(event) => setEditor((prev) => ({ ...prev, maxRetries: event.target.value }))}
                    className="w-full"
                  />
                </div>
              </div>
              <div className="flex items-center justify-between pt-1">
                <span className="text-sm text-foreground">{t('automation.enableTask')}</span>
                <Switch
                  checked={editor.enabled}
                  onCheckedChange={(checked) => setEditor((prev) => ({ ...prev, enabled: checked }))}
                  ariaLabel={t('automation.enabled')}
                />
              </div>
            </div>

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
          <div className="mr-auto flex items-center gap-2 text-xs text-muted-foreground">
            <MonitorIcon size={14} />
            <span className="truncate max-w-[200px]">{workingDirDisplay}</span>
          </div>
          <Button type="button" variant="ghost" size="md" onClick={onClose}>
            {t('automation.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            disabled={saving}
            onClick={() => {
              void handleSubmit();
            }}
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
