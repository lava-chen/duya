import { useEffect, useMemo, useRef, useState } from 'react';
import type {
  AutomationCron,
  CronPermissionMode,
  CreateAutomationCronInput,
} from '@/types/automation';
import { ModelProviderSelector } from '@/components/chat/ModelProviderSelector';
import { PermissionModeSelector, type PermissionModeUi } from '@/components/chat/MessageInput';
import { listProvidersIPC, type Provider } from '@/lib/ipc-client';
import {
  buildBotModelGroups,
  fromSelectorModelId,
  toSelectorModelId,
} from '@/lib/bot-model-options';
import {
  CaretDownIcon,
  CheckIcon,
  FolderIcon,
  SpinnerGapIcon,
  TrashIcon,
  XIcon,
} from '@/components/icons';
import { Button } from '@/components/ui/Button';
import { IconButton } from '@/components/ui/IconButton';
import { Input } from '@/components/ui/Input';
import { Modal } from '@/components/ui/page';
import { useConversationStore } from '@/stores/conversation-store';
import { useTranslation } from '@/hooks/useTranslation';
import {
  CUSTOM_REPEAT_UNIT_LABELS,
  EDITOR_PRESET_LABELS,
  WEEKDAYS,
  createCronEditorDraft,
  cronToEditorDraft,
  editorDraftToSchedule,
  editorPresetChipLabel,
  summarizeEditorDraft,
  timezoneOffsetLabel,
  type CronEditorScheduleDraft,
  type CustomRepeatUnit,
  type EditorSchedulePreset,
} from './cron-schedule';

/** Inner control chip inside the schedule row (preset / time / weekday / month-day). */
const INNER_CHIP_CLASS =
  'flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/40 bg-[var(--surface-hover)] px-2 text-[13px] text-foreground outline-none transition-colors hover:border-border';

interface MenuOption<V extends string | number> {
  value: V;
  label: string;
}

/** Chip-triggered dropdown menu with a checkmark on the active option. */
function MenuChip<V extends string | number>({
  label,
  options,
  value,
  onSelect,
  ariaLabel,
  icon,
}: {
  label: string;
  options: MenuOption<V>[];
  value: V;
  onSelect: (value: V) => void;
  ariaLabel: string;
  icon?: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('pointerdown', close);
    return () => window.removeEventListener('pointerdown', close);
  }, [open]);

  return (
    <div ref={rootRef} className="relative shrink-0">
      <button
        type="button"
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={INNER_CHIP_CLASS}
        onClick={() => setOpen((current) => !current)}
      >
        {icon}
        <span className="max-w-40 truncate">{label}</span>
        <CaretDownIcon size={12} className="shrink-0 text-muted-foreground" />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full z-50 mt-1.5 min-w-36 overflow-hidden rounded-xl border p-1"
          style={{
            background: 'var(--main-bg)',
            borderColor: 'var(--border)',
            boxShadow: '0 16px 40px -12px rgba(0, 0, 0, 0.45)',
          }}
        >
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={String(option.value)}
                type="button"
                role="option"
                aria-selected={active}
                className="flex w-full items-center justify-between gap-3 rounded-lg px-3 py-1.5 text-left text-sm text-foreground transition-colors hover:bg-[var(--surface-hover)]"
                onClick={() => {
                  onSelect(option.value);
                  setOpen(false);
                }}
              >
                <span className="whitespace-nowrap">{option.label}</span>
                {active && <CheckIcon size={14} className="shrink-0" />}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

/** Cron permission profile ↔ composer UI mode (`PermissionModeSelector`). */
function permissionToUi(mode: CronPermissionMode): PermissionModeUi {
  if (mode === 'default') return 'ask';
  if (mode === 'full_access') return 'bypass';
  return 'auto';
}

function uiToPermission(mode: PermissionModeUi): CronPermissionMode {
  if (mode === 'ask') return 'default';
  if (mode === 'bypass') return 'full_access';
  return 'auto';
}

/**
 * 自定义重复 dialog (plan 574): repeat count + unit and an end-repeat radio.
 * Rendered above the editor modal (z-60 overlay); Escape closes only this
 * dialog (capture-phase handler, so the editor modal stays open).
 */
function CustomRepeatDialog({
  draft,
  onConfirm,
  onCancel,
}: {
  draft: CronEditorScheduleDraft;
  onConfirm: (next: { count: number; unit: CustomRepeatUnit; endRepeat: 'never' | 'on'; endAt: string }) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [count, setCount] = useState(draft.customCount >= 1 ? draft.customCount : 1);
  const [unit, setUnit] = useState<CustomRepeatUnit>(draft.customUnit);
  const [endRepeat, setEndRepeat] = useState<'never' | 'on'>(draft.endRepeat);
  const [endAt, setEndAt] = useState(draft.endAt);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onCancel();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [onCancel]);

  const unitOptions = (Object.keys(CUSTOM_REPEAT_UNIT_LABELS) as CustomRepeatUnit[]).map((value) => ({
    value,
    label: CUSTOM_REPEAT_UNIT_LABELS[value],
  }));

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60"
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
    >
      <div
        className="w-[400px] max-w-[calc(100vw-48px)] rounded-xl border p-5"
        style={{ background: 'var(--main-bg)', borderColor: 'var(--border)' }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="flex items-center justify-between">
          <h3 className="text-base font-medium text-foreground">{t('automation.customRepeat')}</h3>
          <IconButton type="button" variant="ghost" size="sm" aria-label={t('common.close')} onClick={onCancel}>
            <XIcon size={16} />
          </IconButton>
        </div>

        <div className="mt-4 space-y-1">
          <span className="text-[13px] text-muted-foreground">{t('automation.repeatFrequency')}</span>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={1}
              max={999}
              className="h-9 w-24 rounded-lg border border-border/50 bg-chip px-3 text-sm text-foreground outline-none focus:border-accent/60"
              value={count}
              onChange={(event) => setCount(Math.max(1, Math.min(999, Math.round(Number(event.target.value) || 1))))}
            />
            <MenuChip
              ariaLabel={t('automation.repeatUnit')}
              label={CUSTOM_REPEAT_UNIT_LABELS[unit]}
              options={unitOptions}
              value={unit}
              onSelect={setUnit}
            />
          </div>
        </div>

        <div className="mt-4 space-y-2">
          <span className="text-[13px] text-muted-foreground">{t('automation.endRepeat')}</span>
          <div className="flex items-center gap-5">
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name="cron-end-repeat"
                className="accent-[var(--accent)]"
                checked={endRepeat === 'never'}
                onChange={() => setEndRepeat('never')}
              />
              {t('automation.neverEnds')}
            </label>
            <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
              <input
                type="radio"
                name="cron-end-repeat"
                className="accent-[var(--accent)]"
                checked={endRepeat === 'on'}
                onChange={() => setEndRepeat('on')}
              />
              {t('automation.untilDate')}
            </label>
          </div>
          <input
            type="date"
            className="h-9 rounded-lg border border-border/50 bg-chip px-3 text-sm text-foreground outline-none disabled:cursor-not-allowed disabled:opacity-40 focus:border-accent/60"
            value={endAt}
            disabled={endRepeat === 'never'}
            onChange={(event) => setEndAt(event.target.value)}
          />
        </div>

        <div className="mt-5 flex items-center justify-end gap-2">
          <Button type="button" variant="ghost" size="md" onClick={onCancel}>
            {t('automation.cancel')}
          </Button>
          <Button
            type="button"
            variant="primary"
            size="md"
            onClick={() => onConfirm({ count, unit, endRepeat, endAt })}
          >
            {t('automation.confirm')}
          </Button>
        </div>
      </div>
    </div>
  );
}

interface EditorState {
  name: string;
  prompt: string;
  model: string;
  workingDirectory: string;
  permissionMode: CronPermissionMode;
  effort: string;
  schedule: CronEditorScheduleDraft;
}

function editorStateFromCron(cron: AutomationCron): EditorState {
  return {
    name: cron.name,
    prompt: cron.prompt,
    model: cron.model,
    workingDirectory: cron.workingDirectory || '',
    permissionMode: cron.permissionMode ?? 'auto',
    effort: cron.effort ?? '',
    schedule: cronToEditorDraft(cron),
  };
}

const DEFAULT_EDITOR: EditorState = {
  name: '',
  prompt: '',
  model: '',
  workingDirectory: '',
  // Legacy cron sessions run with 'auto'; keep that as the create default so
  // existing behavior is preserved unless the user picks another profile.
  permissionMode: 'auto',
  effort: '',
  schedule: createCronEditorDraft(),
};

function workspaceLabel(path: string): string {
  return path.split(/[/\\]/).filter(Boolean).pop() || path;
}

export function CronEditorModal({
  cron,
  isOpen,
  onClose,
  onSave,
  onDelete,
  saving,
}: {
  cron: AutomationCron | null;
  isOpen: boolean;
  onClose: () => void;
  onSave: (cronId: string | undefined, data: CreateAutomationCronInput) => Promise<void>;
  onDelete: (cron: AutomationCron) => void;
  saving: boolean;
}) {
  const { t } = useTranslation();
  const initial = cron ? editorStateFromCron(cron) : DEFAULT_EDITOR;
  const [editor, setEditor] = useState<EditorState>(initial);
  const [formError, setFormError] = useState<string | null>(null);
  const [customRepeatOpen, setCustomRepeatOpen] = useState(false);
  const [providers, setProviders] = useState<Provider[]>([]);
  const [providersLoading, setProvidersLoading] = useState(false);
  const threads = useConversationStore((s) => s.threads);

  useEffect(() => {
    if (isOpen) {
      setEditor(initial);
      setFormError(null);
      setCustomRepeatOpen(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, cron]);

  // Provider catalog for the composer's ModelProviderSelector — same
  // grouping the bot forms use (bot-model-options mirrors MessageInput).
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setProvidersLoading(true);
    listProvidersIPC()
      .then((list) => {
        if (!cancelled) setProviders(list ?? []);
      })
      .catch(() => {
        if (!cancelled) setProviders([]);
      })
      .finally(() => {
        if (!cancelled) setProvidersLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen]);

  const providerGroups = useMemo(() => buildBotModelGroups(providers), [providers]);

  // cron.model stores the raw model id; the selector speaks prefixed ids.
  const selectedSelectorModelId = useMemo(
    () => toSelectorModelId(editor.model, undefined, providerGroups),
    [editor.model, providerGroups],
  );

  // Effort options for the run — same shape as the composer's fallback list
  // ('' = 自动 follows the runtime default, which for cron runs is 'off').
  const effortOptions = useMemo(
    () => [
      { value: '', label: t('messageInput.effortAuto') },
      { value: 'low', label: t('messageInput.effortLow') },
      { value: 'medium', label: t('messageInput.effortMedium') },
      { value: 'high', label: t('messageInput.effortHigh') },
      { value: 'max', label: t('messageInput.effortMax') },
    ],
    [t],
  );

  const schedule = editor.schedule;
  const patchSchedule = (patch: Partial<CronEditorScheduleDraft>) => {
    setEditor((prev) => ({ ...prev, schedule: { ...prev.schedule, ...patch } }));
  };

  const presetOptions = useMemo(
    () => (Object.keys(EDITOR_PRESET_LABELS) as EditorSchedulePreset[]).map((value) => ({
      value,
      label: EDITOR_PRESET_LABELS[value],
    })),
    [],
  );

  const handlePresetSelect = (preset: EditorSchedulePreset) => {
    if (preset === 'custom') {
      if (schedule.preset !== 'custom') {
        // Entering custom from a preset: seed a structured repeat if there is
        // none yet (raw schedules keep their own values in the dialog).
        patchSchedule(
          schedule.customCount < 1 && !schedule.rawSchedule
            ? { preset: 'custom', customCount: 1, customUnit: 'day' }
            : { preset: 'custom' },
        );
      }
      setCustomRepeatOpen(true);
      return;
    }
    patchSchedule({ preset, rawSchedule: null });
  };

  const handleCustomRepeatConfirm = (next: {
    count: number;
    unit: CustomRepeatUnit;
    endRepeat: 'never' | 'on';
    endAt: string;
  }) => {
    patchSchedule({
      preset: 'custom',
      customCount: next.count,
      customUnit: next.unit,
      rawSchedule: null,
      endRepeat: next.endRepeat,
      endAt: next.endAt,
    });
    setCustomRepeatOpen(false);
  };

  const handleSubmit = async () => {
    setFormError(null);
    if (!editor.name.trim()) {
      setFormError(t('automation.nameRequired'));
      return;
    }
    if (!editor.prompt.trim()) {
      setFormError(t('automation.promptRequired'));
      return;
    }
    if (!editor.model.trim()) {
      setFormError(t('automation.modelRequired'));
      return;
    }
    if (schedule.preset === 'once' && !schedule.at) {
      setFormError(t('automation.runTimeRequired'));
      return;
    }
    if (schedule.endRepeat === 'on' && !schedule.endAt) {
      setFormError(t('automation.endRepeatRequired'));
      return;
    }
    try {
      await onSave(cron?.id, {
        name: editor.name.trim(),
        prompt: editor.prompt.trim(),
        schedule: editorDraftToSchedule(schedule),
        model: editor.model.trim(),
        workingDirectory: editor.workingDirectory.trim() || undefined,
        concurrencyPolicy: cron?.concurrencyPolicy ?? 'skip',
        maxRetries: cron?.maxRetries ?? 3,
        enabled: cron?.enabled ?? true,
        permissionMode: editor.permissionMode,
        // Empty string resets the stored effort (run time falls back to 'off').
        effort: editor.effort,
      });
      onClose();
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    }
  };

  const handleDelete = () => {
    if (!cron) return;
    if (window.confirm(t('automation.deleteCronConfirm'))) {
      onDelete(cron);
    }
  };

  const handlePickWorkingDir = async () => {
    if (!window.electronAPI?.dialog?.openFolder) return;
    const result = await window.electronAPI.dialog.openFolder({
      title: t('automation.workingDirectory'),
      defaultPath: editor.workingDirectory || undefined,
    });
    if (!result.canceled && result.filePaths[0]) {
      setEditor((prev) => ({ ...prev, workingDirectory: result.filePaths[0] }));
    }
  };

  const knownWorkspaces = useMemo(() => {
    const seen = new Map<string, string>();
    for (const thread of threads) {
      if (!thread.workingDirectory) continue;
      if (!seen.has(thread.workingDirectory)) {
        seen.set(thread.workingDirectory, thread.projectName || workspaceLabel(thread.workingDirectory));
      }
    }
    if (editor.workingDirectory && !seen.has(editor.workingDirectory)) {
      seen.set(editor.workingDirectory, workspaceLabel(editor.workingDirectory));
    }
    return Array.from(seen.entries()).map(([path, label]) => ({ path, label }));
  }, [threads, editor.workingDirectory]);

  if (!isOpen) return null;

  // Structured minute/week repeats and preserved raw schedules carry no time
  // of day — hide the "于 [time]" pair for them.
  const showsTime =
    schedule.preset !== 'once' &&
    !(
      schedule.preset === 'custom' &&
      (schedule.rawSchedule != null || schedule.customUnit === 'minute' || schedule.customUnit === 'week')
    );

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={cron ? t('automation.editTask') : t('automation.newTask')}
      maxWidth={640}
      footer={
        <>
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
        </>
      }
    >
      <div className="space-y-5">
        <div className="space-y-2">
          <label className="text-[13px] font-medium text-foreground" htmlFor="cron-editor-name">
            {t('automation.taskTitle')}
          </label>
          <Input
            id="cron-editor-name"
            type="text"
            size="md"
            placeholder={t('automation.namePlaceholder')}
            value={editor.name}
            onChange={(event) => setEditor((prev) => ({ ...prev, name: event.target.value }))}
          />
        </div>

        <div className="space-y-2">
          <span className="text-[13px] font-medium text-foreground">{t('automation.schedule')}</span>
          <div className="flex min-h-10 items-center gap-1.5 rounded-lg border border-border/50 bg-chip px-1.5">
            <MenuChip
              ariaLabel={t('automation.schedule')}
              label={editorPresetChipLabel(schedule)}
              options={presetOptions}
              value={schedule.preset}
              onSelect={handlePresetSelect}
            />
            {schedule.preset === 'once' ? (
              <input
                type="datetime-local"
                aria-label={t('automation.runTimeRequired')}
                className="h-7 shrink-0 rounded-md border border-border/40 bg-[var(--surface-hover)] px-2 text-[13px] text-foreground outline-none"
                value={schedule.at}
                onChange={(event) => patchSchedule({ at: event.target.value })}
              />
            ) : (
              showsTime && (
                <>
                  <span className="shrink-0 text-[13px] text-muted-foreground">{t('automation.scheduleAt')}</span>
                  <input
                    type="time"
                    aria-label={t('automation.runTimeRequired')}
                    className="h-7 shrink-0 rounded-md border border-border/40 bg-[var(--surface-hover)] px-2 text-[13px] text-foreground outline-none"
                    value={schedule.time}
                    onChange={(event) => patchSchedule({ time: event.target.value })}
                  />
                </>
              )
            )}
            {schedule.preset === 'weekly' && (
              <MenuChip
                ariaLabel={t('automation.weekdayLabel')}
                label={WEEKDAYS.find((day) => day.value === schedule.weekday)?.label ?? '周一'}
                options={[...WEEKDAYS]}
                value={schedule.weekday}
                onSelect={(weekday) => patchSchedule({ weekday })}
              />
            )}
            {schedule.preset === 'monthly' && (
              <span className="flex h-7 shrink-0 items-center gap-1 rounded-md border border-border/40 bg-[var(--surface-hover)] px-2 text-[13px] text-foreground">
                <input
                  type="number"
                  min={1}
                  max={31}
                  aria-label={t('automation.monthDayLabel')}
                  className="w-8 bg-transparent text-right outline-none"
                  value={schedule.monthDay}
                  onChange={(event) =>
                    patchSchedule({ monthDay: Math.max(1, Math.min(31, Math.round(Number(event.target.value) || 1))) })
                  }
                />
                <span className="text-muted-foreground">{t('automation.daySuffix')}</span>
              </span>
            )}
            <span className="shrink-0 text-xs text-muted-foreground">{timezoneOffsetLabel(schedule.timezone)}</span>
            <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
              {summarizeEditorDraft(schedule)}
            </span>
            {cron && (
              <IconButton
                type="button"
                aria-label={t('automation.delete')}
                title={t('automation.delete')}
                variant="ghost"
                shape="square"
                size="sm"
                className="ml-auto shrink-0 text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
                onClick={handleDelete}
              >
                <TrashIcon size={15} />
              </IconButton>
            )}
          </div>
        </div>

        <div className="space-y-2">
          <span className="text-[13px] font-medium text-foreground">{t('automation.instruction')}</span>
          <textarea
            className="h-[200px] w-full resize-none rounded-lg border border-border/50 bg-chip px-3 py-2.5 text-sm leading-relaxed text-foreground outline-none focus:border-accent/60 focus:ring-2 focus:ring-accent/50"
            placeholder={t('automation.promptPlaceholder')}
            value={editor.prompt}
            onChange={(event) => setEditor((prev) => ({ ...prev, prompt: event.target.value }))}
          />
          {/* Composer-style bottom bar: workspace / approval on the left,
              model + reasoning effort on the right. Model/effort and the
              permission toggle reuse the composer's own components. */}
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1">
              <MenuChip
                ariaLabel={t('automation.workingDirectory')}
                icon={<FolderIcon size={14} className="shrink-0 text-muted-foreground" />}
                label={editor.workingDirectory ? workspaceLabel(editor.workingDirectory) : t('automation.defaultWorkspace')}
                value={editor.workingDirectory}
                onSelect={(path) => {
                  if (path === '__pick__') {
                    void handlePickWorkingDir();
                    return;
                  }
                  setEditor((prev) => ({ ...prev, workingDirectory: path }));
                }}
                options={[
                  ...knownWorkspaces.map((entry) => ({ value: entry.path, label: entry.label })),
                  { value: '__pick__', label: t('automation.chooseDirectory') },
                ]}
              />
              <PermissionModeSelector
                value={permissionToUi(editor.permissionMode)}
                onChange={(mode) => setEditor((prev) => ({ ...prev, permissionMode: uiToPermission(mode) }))}
              />
            </div>
            <ModelProviderSelector
              providerGroups={providerGroups}
              selectedModelId={selectedSelectorModelId}
              onSelectModel={(selectorId) =>
                setEditor((prev) => ({ ...prev, model: fromSelectorModelId(selectorId, providerGroups).raw }))
              }
              effortValue={editor.effort}
              effortOptions={effortOptions}
              onSelectEffort={(value) => setEditor((prev) => ({ ...prev, effort: value ?? '' }))}
              loading={providersLoading}
              portal
              showManageProviders={false}
            />
          </div>
        </div>

        {formError && (
          <div
            className="rounded-xl border border-error/40 bg-error-soft px-4 py-3 text-sm text-error"
            role="alert"
          >
            {formError}
          </div>
        )}
      </div>

      {customRepeatOpen && (
        <CustomRepeatDialog
          draft={schedule}
          onConfirm={handleCustomRepeatConfirm}
          onCancel={() => setCustomRepeatOpen(false)}
        />
      )}
    </Modal>
  );
}
