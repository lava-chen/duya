/**
 * WorkflowLaunchDialog.tsx — plan 560 §7.5: the 实参窗 for a library run.
 *
 * Extracted from `WorkflowPanel.tsx` (same testids, same i18n keys) so all three
 * ▶ entry points — the definition card, the library card and the detail page —
 * share one dialog. Redrawn after the ZCode reference: the run's project is
 * picked from the known projects rather than typed as a raw path, every arg
 * carries its own helper text, and the dialog says what will happen before it
 * does it.
 *
 * What changed on the way in is the ANCHOR. This used to submit to
 * `api().run()`, the session anchor: the run was executed by whichever chat
 * worker happened to be alive, and its card only existed inside that session's
 * stream. It now submits to `api().trigger()`, the run anchor — its own runId,
 * its own process, its own event stream — and opens that run's panel on success.
 *
 * The project field is not a cosmetic input: it is the run's cwd and the
 * `workingDirectory` every agent node inherits. Under the run anchor it is
 * mandatory — an agent node without a working directory has nothing to act on
 * (plan 560 D6).
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from '@/hooks/useTranslation';
import { InfoIcon, PlayIcon, RepeatIcon, XIcon } from '@/components/icons';
import {
  normalizeWorkingDirectoryForCompare,
  useProjectsStore,
} from '@/stores/projects-store';
import type { DwfArgDeclaration } from '@/lib/workflow-ipc';
import { triggerLibraryRunIPC } from '@/lib/workflow-ipc';

/** Sentinel option for "type a path that is not a known project". */
const CUSTOM_DIR = '__custom__';

/**
 * Where the user last launched each workflow. "运行位置有记忆"：一次成功的
 * 启动会同时记下按 workflow 名的目录和全局最近目录，下一次打开实参窗时
 * 直接预填，而不是每次都让用户重新选。localStorage 够用——这是 UI 偏好，
 * 不是运行数据。
 */
const LAUNCH_DIR_STORAGE_KEY = 'duya:workflow:launch-dirs:v1';

interface LaunchDirMemory {
  last?: string;
  byName?: Record<string, string>;
}

function loadLaunchDirMemory(): LaunchDirMemory {
  try {
    const raw = window.localStorage.getItem(LAUNCH_DIR_STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as LaunchDirMemory;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveLaunchDirMemory(workflowName: string, dir: string): void {
  try {
    const memory = loadLaunchDirMemory();
    const next: LaunchDirMemory = {
      ...memory,
      last: dir,
      byName: { ...(memory.byName ?? {}), [workflowName]: dir },
    };
    window.localStorage.setItem(LAUNCH_DIR_STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota / private mode — the launch itself still proceeds.
  }
}

/**
 * The project a project-scoped workflow file belongs to: the segment before
 * `<project>/.duya/workflows/<name>.dwf.ts`. This is the natural default run
 * location — a workflow saved in duya's own `.duya/workflows` defaults to the
 * duya project. Callers gate on `scope === 'project'`: a global file's path
 * roots at the home directory, which must never become the default run
 * location.
 */
export function owningProjectDirOf(entryPath: string | undefined): string | null {
  if (!entryPath) return null;
  const match = entryPath.match(/^(.*)[/\\]\.duya[/\\]workflows[/\\][^/\\]+$/);
  return match && match[1] ? match[1] : null;
}

const LAUNCH_INPUT_CLS =
  'w-full rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-xs text-[var(--text)] outline-none focus:border-[var(--accent)]';

/**
 * The fields the dialog needs from a saved-workflow list entry.
 *
 * Deliberately structural rather than imported from `WorkflowPanel`: the two
 * callers hand it slightly different (but compatible) shapes — the panel's own
 * `DwfWorkflowEntry` and the dwf-list IPC entry — and neither should have to
 * pretend to be the other.
 */
export interface WorkflowLaunchDialogEntry {
  name: string;
  /** One-paragraph description shown under the header. */
  description?: string;
  scope?: 'project' | 'global';
  args?: Record<string, DwfArgDeclaration>;
  /**
   * Absolute path of the workflow file, when the caller has it. Used only to
   * derive the default run location (the owning project of a project-scoped
   * file); absent paths fall back to `defaultProjectDir`.
   */
  path?: string;
}

function ArgInput({
  decl,
  value,
  onChange,
}: {
  decl: DwfArgDeclaration;
  value: string;
  onChange: (v: string) => void;
}) {
  if (decl.type === 'boolean') {
    return (
      <input
        type="checkbox"
        checked={value === 'true'}
        onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        className="h-3.5 w-3.5 accent-[var(--accent)]"
      />
    );
  }
  if (decl.type === 'json') {
    return (
      <textarea
        value={value}
        rows={3}
        placeholder={decl.default !== undefined ? JSON.stringify(decl.default) : undefined}
        onChange={(e) => onChange(e.target.value)}
        className={`${LAUNCH_INPUT_CLS} font-mono`}
      />
    );
  }
  return (
    <input
      type={decl.type === 'number' ? 'number' : 'text'}
      value={value}
      placeholder={decl.default !== undefined ? String(decl.default) : undefined}
      onChange={(e) => onChange(e.target.value)}
      className={LAUNCH_INPUT_CLS}
    />
  );
}

/**
 * ZCode's 实参窗: pick the target project, fill the declared args, then launch.
 * Absent args fall back to the declared defaults child-side.
 */
export function WorkflowLaunchDialog({
  entry,
  defaultProjectDir,
  onClose,
  onLaunched,
}: {
  entry: WorkflowLaunchDialogEntry;
  defaultProjectDir?: string;
  onClose: () => void;
  onLaunched?: (runId: string) => void;
}) {
  const { t } = useTranslation();
  const projects = useProjectsStore((s) => s.projects);
  const loadProjects = useProjectsStore((s) => s.loadProjects);

  // 运行位置的解析顺序（"有默认 + 有记忆"）：
  //   1. 这个 workflow 上次成功启动用的目录（用户改过 → 记住的就是它）
  //   2. project 档工作流文件所属的项目（存在 duya 的 .duya/workflows 里
  //      就默认在 duya 里跑）
  //   3. 调用方给的 defaultProjectDir（会话工作目录）
  //   4. 全局最近一次启动目录
  const [projectDir, setProjectDir] = useState(() => {
    const memory = loadLaunchDirMemory();
    return (
      memory.byName?.[entry.name] ??
      (entry.scope === 'project' ? owningProjectDirOf(entry.path) : null) ??
      defaultProjectDir ??
      memory.last ??
      ''
    );
  });
  const [customDir, setCustomDir] = useState(false);
  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const [name, decl] of Object.entries(entry.args ?? {})) {
      if (decl.default !== undefined) {
        seed[name] = decl.type === 'json' ? JSON.stringify(decl.default) : String(decl.default);
      } else if (decl.type === 'boolean') {
        seed[name] = 'false';
      } else {
        seed[name] = '';
      }
    }
    return seed;
  });
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const argEntries = useMemo(() => Object.entries(entry.args ?? {}), [entry]);

  /** Known project roots, plus the current value if it is not one of them. */
  const dirOptions = useMemo(() => {
    const roots = projects.map((p) => p.canonical_root);
    const current = projectDir.trim();
    const known = roots.some(
      (root) =>
        normalizeWorkingDirectoryForCompare(root) === normalizeWorkingDirectoryForCompare(current),
    );
    if (current && !known) roots.unshift(current);
    return roots;
  }, [projects, projectDir]);

  const submit = useCallback(async () => {
    const params: Record<string, unknown> = {};
    for (const [name, decl] of argEntries) {
      const raw = (values[name] ?? '').trim();
      if (raw === '' || (decl.type === 'boolean' && raw === 'false')) {
        if (decl.required === true && raw === '') {
          setError(`${name}: ${t('panel.workflow.argRequired')}`);
          return;
        }
        continue; // absent → declared default applies child-side
      }
      if (decl.type === 'number') {
        const n = Number(raw);
        if (!Number.isFinite(n)) {
          setError(`${name}: not a number`);
          return;
        }
        params[name] = n;
      } else if (decl.type === 'boolean') {
        params[name] = raw === 'true';
      } else if (decl.type === 'json') {
        try {
          params[name] = JSON.parse(raw);
        } catch {
          setError(`${name}: invalid JSON`);
          return;
        }
      } else {
        params[name] = raw;
      }
    }
    if (!projectDir.trim()) {
      setError(t('panel.workflow.launchProject'));
      return;
    }
    setLaunching(true);
    setError(null);
    try {
      // `scope` is not a user choice (§7.5): the definition already resolved
      // it, so the run row just records which file won the shadowing.
      const res = await triggerLibraryRunIPC({
        name: entry.name,
        params,
        projectDir: projectDir.trim(),
        scope: entry.scope ?? null,
      });
      if (!res || res.ok === false || !res.runId) {
        setError(res?.error ?? t('panel.workflow.launchFailed'));
        return;
      }
      // Remember where this workflow was launched — the next 实参窗 for the
      // same workflow pre-fills it (and any dialog pre-fills the global last).
      saveLaunchDirMemory(entry.name, projectDir.trim());
      // The run panel is keyed by runId, so the event is the whole handshake
      // (plan 560 D5 — the panel then subscribes to the run's own SSE stream).
      window.dispatchEvent(
        new CustomEvent('duya:open-workflow-run-panel', { detail: { runId: res.runId } }),
      );
      onLaunched?.(res.runId);
      onClose();
    } finally {
      setLaunching(false);
    }
  }, [argEntries, values, projectDir, entry.name, entry.scope, onLaunched, onClose, t]);

  const scopeLabel =
    entry.scope === 'project'
      ? t('panel.workflow.scopeProject')
      : entry.scope === 'global'
        ? t('panel.workflow.scopeGlobal')
        : null;

  return createPortal(
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      data-testid={`workflow-launch-${entry.name}`}
      onClick={onClose}
    >
      <div
        className="w-[440px] max-w-[90vw] rounded-lg border border-[var(--border)] bg-[var(--bg-canvas)] shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header — glyph + mono name + scope badge, like the definition card. */}
        <div className="flex items-center gap-2 border-b border-[var(--border)] px-4 py-2.5">
          <RepeatIcon className="shrink-0 text-[var(--muted)]" size={14} />
          <span className="min-w-0 truncate font-mono text-sm font-semibold text-[var(--text)]">
            {entry.name}
          </span>
          {scopeLabel && (
            <span className="shrink-0 rounded bg-[var(--bg-surface)] px-1.5 py-0.5 text-[10px] text-[var(--muted)]">
              {scopeLabel}
            </span>
          )}
          <button
            type="button"
            className="ml-auto inline-flex shrink-0 items-center justify-center text-[var(--muted)] hover:text-[var(--text)]"
            onClick={onClose}
            aria-label="close"
            data-testid="workflow-launch-close"
          >
            <XIcon size={14} />
          </button>
        </div>

        {entry.description && (
          <p className="px-4 pt-2.5 text-xs leading-relaxed text-[var(--muted)]">{entry.description}</p>
        )}

        <div className="flex flex-col gap-3 px-4 py-3 text-xs">
          {/* Where the run executes — this is the agent nodes' workingDirectory. */}
          <div>
            <label className="block pb-1 text-[var(--text)]">{t('panel.workflow.launchRunIn')}</label>
            {dirOptions.length > 0 && !customDir ? (
              <select
                value={projectDir}
                onChange={(e) => {
                  if (e.target.value === CUSTOM_DIR) {
                    setCustomDir(true);
                    setProjectDir('');
                  } else {
                    setProjectDir(e.target.value);
                  }
                }}
                data-testid="workflow-launch-project-select"
                className={LAUNCH_INPUT_CLS}
              >
                {!projectDir && <option value="">{t('panel.workflow.launchPickProject')}</option>}
                {dirOptions.map((root) => (
                  <option key={root} value={root}>
                    {root}
                  </option>
                ))}
                <option value={CUSTOM_DIR}>{t('panel.workflow.launchCustomDir')}</option>
              </select>
            ) : (
              <input
                value={projectDir}
                onChange={(e) => setProjectDir(e.target.value)}
                placeholder={t('panel.workflow.launchProjectPlaceholder')}
                data-testid="workflow-launch-project"
                className={LAUNCH_INPUT_CLS}
              />
            )}
            <p className="pt-1 text-[10px] text-[var(--muted)]">{t('panel.workflow.launchProjectHint')}</p>
          </div>

          {argEntries.length > 0 && (
            <div>
              <div className="pb-1 text-[var(--text)]">{t('panel.workflow.launchArgs')}</div>
              <div className="flex flex-col gap-2">
                {argEntries.map(([name, decl]) => (
                  <div key={name} className="flex flex-col gap-0.5" data-testid={`workflow-launch-arg-${name}`}>
                    <label className="flex items-center gap-1.5 text-[var(--text)]">
                      <span className="font-mono">{name}</span>
                      <span className="text-[10px] text-[var(--muted)]">{decl.type}</span>
                      {decl.required === true && (
                        <span className="text-[10px] text-amber-500">{t('panel.workflow.argRequired')}</span>
                      )}
                    </label>
                    <ArgInput
                      decl={decl}
                      value={values[name] ?? ''}
                      onChange={(v) => setValues((cur) => ({ ...cur, [name]: v }))}
                    />
                    {decl.description && (
                      <span className="text-[10px] leading-relaxed text-[var(--muted)]">{decl.description}</span>
                    )}
                  </div>
                ))}
              </div>
            </div>
          )}

          {error && (
            <div className="text-red-500" data-testid="workflow-launch-error">
              {error}
            </div>
          )}

          {/* Say what is about to happen — a launch is not a draft save. */}
          <div
            className="flex items-start gap-1.5 rounded border border-[var(--border)] bg-[var(--bg-surface)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--muted)]"
            data-testid="workflow-launch-immediate-hint"
          >
            <InfoIcon className="mt-px shrink-0" size={11} />
            <span>{t('panel.workflow.launchImmediateHint')}</span>
          </div>
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-[var(--border)] px-4 py-2.5">
          <button
            type="button"
            className="rounded border border-[var(--border)] px-2.5 py-1 text-xs text-[var(--text-muted)] hover:text-[var(--text)]"
            onClick={onClose}
            data-testid="workflow-launch-cancel"
          >
            {t('panel.workflow.dialogCancel')}
          </button>
          <button
            type="button"
            disabled={launching}
            className="inline-flex items-center gap-1 rounded border border-[var(--accent)] px-2.5 py-1 text-xs text-[var(--accent)] hover:bg-[var(--bg-surface)] disabled:cursor-not-allowed disabled:opacity-50"
            onClick={() => void submit()}
            data-testid="workflow-launch-confirm"
          >
            <PlayIcon size={11} />
            {launching ? t('panel.workflow.pending') : t('panel.workflow.launch')}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
