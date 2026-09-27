import { useEffect, useMemo, useState, useCallback } from 'react';
import type {
  AutomationCron,
  AutomationTemplate,
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
import { CronHistoryPanel } from './CronHistoryPanel';
import { ModelSelector, type ModelOption } from '@/components/chat/ModelSelector';
import { listProvidersIPC, getOllamaModelsIPC, type Provider } from '@/lib/ipc-client';
import {
  PlayIcon,
  ClockIcon,
  WarningCircleIcon,
  SpinnerGapIcon,
  SquaresFourIcon,
  ChatCirclePlusIcon,
  ClockCounterClockwiseIcon,
  TrashIcon,
} from '@/components/icons';
import { AutomationEmptyState } from './AutomationEmptyState';
import { CronEditorModal } from './CronEditorModal';
import { MacPermissionsCard } from './MacPermissionsCard';
import { QuickCronChatModal } from './QuickCronChatModal';
import { TemplateMarketModal } from './TemplateMarketModal';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Switch } from '@/components/ui/Switch';
import {
  PageFrame,
  PageHeader,
  PageTabs,
  PageCard,
  EmptyState,
} from '@/components/ui/page';

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

type TabKey = 'configured' | 'history' | 'templates';

function formatDateShort(value: number | null): string {
  if (!value) return '-';
  const d = new Date(value);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
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
  if (!s) {
    return cron.eventTriggers?.length
      ? `事件触发 · ${cron.eventTriggers.length} 个监听器`
      : '未设置计划';
  }
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

  const handleOpenChat = (_cron: AutomationCron, sessionId: string) => {
    // Cron runs are ordinary sessions (id prefix `cron:`) grouped in the
    // sidebar's cron section — open them in the normal chat view.
    if (sessionId) {
      void setActiveThread(sessionId);
    }
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
      // executes in the background, so jump straight into the new session to
      // watch it live in the normal chat view. setActiveThread loads the
      // thread, switches to the chat view, and refreshes the sidebar so the
      // session appears in the cron group. Provider errors surface
      // synchronously as a thrown error.
      if (handle && handle.sessionId) {
        await setActiveThread(handle.sessionId);
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
    <PageFrame>
      <PageHeader
        title={t('automation.title')}
        subtitle={t('automation.subtitle')}
        actions={
          <>
            <Button
              className="whitespace-nowrap"
              onClick={handleCreateNew}
              type="button"
              variant="secondary"
              size="md"
            >
              {t('automation.manualCreate')}
            </Button>
            <Button
              className="whitespace-nowrap"
              onClick={handleChatCreate}
              type="button"
              variant="primary"
              size="md"
            >
              <ChatCirclePlusIcon size={16} />
              {t('automation.createInChat')}
            </Button>
          </>
        }
      />

      <PageTabs
        tabs={[
          { id: 'configured', label: t('automation.configured') },
          { id: 'history', label: t('automation.executionHistory') },
          { id: 'templates', label: t('automation.taskTemplates') },
        ]}
        active={activeTab}
        onChange={(id) => setActiveTab(id as TabKey)}
      />

      {/* macOS TCC onboarding for the computer-use stack (plan 572).
          Self-hiding on Windows / when nothing needs attention. */}
      <MacPermissionsCard />

      {/* Error Banner */}
      {error && (
        <div className="rounded-lg border border-error/40 bg-error-soft px-4 py-3 flex items-center gap-2">
          <WarningCircleIcon size={16} className="text-error shrink-0" />
          <span className="text-sm text-error">{error}</span>
        </div>
      )}

      {/* Main Content */}
        {showEmptyState ? (
          <AutomationEmptyState
            onManualCreate={handleCreateNew}
            onChatCreate={handleChatCreate}
            onViewTemplates={handleViewTemplates}
          />
        ) : activeTab === 'configured' ? (
          <div className="flex flex-col">
            {/* Cron list */}
            {loading ? (
              <div className="flex items-center justify-center h-32 text-muted-foreground">
                <SpinnerGapIcon size={20} className="animate-spin mr-2" />
                {t('automation.loading')}
              </div>
            ) : crons.length === 0 ? (
              <EmptyState
                icon={<ClockIcon size={32} />}
                title={t('automation.noAutomations')}
              />
            ) : (
              <PageCard padding="none">
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
              </PageCard>
            )}
          </div>
        ) : activeTab === 'history' ? (
          <CronHistoryPanel
            sessions={allSessions}
            onOpenChat={handleOpenChat}
            onRefresh={reloadAllSessions}
          />
        ) : (
          <div className="flex flex-col gap-4">
            <div className="flex items-center justify-between gap-4">
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
            {templates.length === 0 ? (
              <EmptyState
                icon={<SquaresFourIcon size={40} />}
                title={t('automation.noTemplates')}
              />
            ) : (
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {templates.map((template) => (
                  <button
                    key={template.id}
                    type="button"
                    onClick={() => handleTemplateSelect(template)}
                    className="page-card page-card-hover flex flex-col items-start p-4 text-left"
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

      {/* Create / Edit Cron Modal */}
      <CronEditorModal
        cron={editingCron}
        isOpen={editModalOpen}
        onClose={handleCloseEditModal}
        onSave={handleSaveCron}
        onDelete={(deleted) => {
          handleCloseEditModal();
          void removeCron(deleted);
        }}
        availableModels={availableModels}
        modelsLoading={modelsLoading}
        saving={saving}
      />
    </PageFrame>
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
      className="grid items-center gap-4 px-4 py-3 text-sm border-b border-border/20 transition-colors last:border-b-0 hover:bg-[var(--surface-hover)] cursor-pointer"
      style={{ gridTemplateColumns: '2fr 1.5fr 100px 140px' }}
      onClick={onEdit}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          onEdit();
        }
      }}
    >
      {/* Task name */}
      <div className="flex items-center gap-2 min-w-0">
        <span className="truncate font-medium text-foreground">{cron.name}</span>
        {cron.agent && (
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-xs"
            style={{ border: '1px solid var(--border)', color: 'var(--text-muted)' }}
            title={cron.agent}
          >
            {t('automation.botBound')}
          </span>
        )}
      </div>

      {/* Schedule */}
      <div className="truncate text-muted-foreground">{getFriendlySchedule(cron)}</div>

      {/* Status */}
      <div className="flex items-center gap-2" onClick={(event) => event.stopPropagation()}>
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
      <div
        className="flex items-center justify-end gap-1"
        onClick={(event) => event.stopPropagation()}
      >
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

