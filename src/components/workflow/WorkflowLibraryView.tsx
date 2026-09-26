/**
 * WorkflowLibraryView — full-screen workflow library (plan 552 Phase 9).
 *
 * Page motto: "保存在已打开项目里的工作流，填好参数就能再跑一次"
 *
 * Layout:
 *   1. Page header with refresh
 *   2. Scope groups (全局 + per-project)
 *      - Each group has a "+ 通过对话创建" button (creates via chat session)
 *      - Cards: name + description + last run status + ▶ run + ··· menu
 *      - Group title with count
 *
 * Click a card → WorkflowDetailView
 */

import { useEffect, useState, useCallback, useMemo, type CSSProperties } from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import {
  PlayIcon,
  DotsThreeIcon,
  IconRefresh,
  RepeatIcon,
  TrashIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
  CheckCircleIcon,
  XCircleIcon,
  CircleNotchIcon,
  CircleIcon,
} from '@/components/icons';
import { DropdownMenu, type MenuAction } from '@/components/ui/DropdownMenu';
import { PageFrame, PageHeader, PageCard, EmptyState } from '@/components/ui/page';
import {
  listDwfWorkflowsIPC,
  deleteDwfWorkflowIPC,
  listWorkflowRunsIPC,
  onDwfWorkflowsChangedIPC,
} from '@/lib/workflow-ipc';
import type { WorkflowRunRow } from '@/components/layout/panels/WorkflowPanel';
import { WorkflowLaunchDialog } from '@/components/workflow/WorkflowLaunchDialog';

/** One entry of the dwf library list — what a card renders and the dialog needs. */
type LibraryEntry = Awaited<ReturnType<typeof listDwfWorkflowsIPC>>['entries'][number];

// ─── styles ────────────────────────────────────────────────────────────────

const mottoStyle: CSSProperties = {
  fontSize: '13px',
  color: 'var(--text-faint)',
  marginTop: '4px',
};

const scopeGroupStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2, 8px)',
};

const scopeHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  padding: '0',
};

const scopeTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: '8px',
  fontSize: '13px',
  fontWeight: 500,
  lineHeight: '20px',
  color: 'var(--text)',
};

const scopeCountStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  background: 'var(--bg-surface-2, rgba(255,255,255,0.05))',
  padding: '1px 8px',
  borderRadius: '999px',
};

/** Group-header create button: solid primary, ZCode Button size="lg" metrics (h-8, rounded-lg, 14px). */
const createButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '32px',
  padding: '0 12px',
  background: 'var(--accent)',
  color: 'var(--accent-on, #fff)',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  fontSize: '13px',
  lineHeight: '20px',
  whiteSpace: 'nowrap',
};

/** ZCode-style empty card: large bordered container, centered title + hint + primary CTA. */
const emptyCardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  justifyContent: 'center',
  gap: '20px',
  minHeight: '226px',
  width: '100%',
  border: '1px solid var(--border-weak)',
  borderRadius: '16px',
  background: 'transparent',
  padding: '0 16px',
  textAlign: 'center',
};

const emptyTextStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'center',
  gap: '6px',
};

const emptyTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: '14px',
  fontWeight: 500,
  lineHeight: '20px',
  color: 'var(--text-faint)',
};

const emptyHintStyle: CSSProperties = {
  margin: 0,
  fontSize: '14px',
  lineHeight: '20px',
  color: 'var(--text-faint)',
  maxWidth: '420px',
};

const primaryButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  height: '32px',
  padding: '0 12px',
  background: 'var(--accent)',
  color: 'var(--accent-on, #fff)',
  border: 'none',
  borderRadius: '8px',
  cursor: 'pointer',
  fontSize: '13px',
  lineHeight: '20px',
  whiteSpace: 'nowrap',
};

/**
 * Card metrics follow the compact grid: fixed 132px row, 12px padding,
 * 20px line-height text. 12 + 20 + 12 + 40 + 12 + 24 + 12 = 132.
 */
const cardGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gridAutoRows: '132px',
  gap: '16px',
};

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
  padding: '12px',
  // Flat card: same base as the page, separated by border only (ZCode bg-background + card-border).
  background: 'transparent',
  border: '1px solid var(--border-weak)',
  borderRadius: '12px',
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
  position: 'relative',
  overflow: 'hidden',
  minHeight: 0,
};

const cardNameStyle: CSSProperties = {
  fontSize: '14px',
  fontWeight: 500,
  lineHeight: '20px',
  color: 'var(--text)',
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  minWidth: 0,
  // Reserve room for the absolutely-positioned run + ⋯ actions (ZCode uses pr-28).
  paddingRight: '104px',
};

const cardDescriptionStyle: CSSProperties = {
  fontSize: '14px',
  lineHeight: '20px',
  height: '40px',
  color: 'var(--text-faint)',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
};

const cardActionsStyle: CSSProperties = {
  position: 'absolute',
  top: '12px',
  right: '12px',
  display: 'flex',
  alignItems: 'center',
  gap: '4px',
};

const runButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '3px 10px',
  background: 'transparent',
  color: 'var(--text)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '12px',
  lineHeight: '18px',
};

const menuTriggerStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '24px',
  height: '24px',
  padding: 0,
  background: 'transparent',
  color: 'var(--text-faint)',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
};

const cardFooterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: '8px',
  marginTop: 'auto',
  minHeight: 0,
};

/** Last-run badge: tinted pill (bg = status color at 10% alpha), icon + "状态 · N 前" (ZCode style). */
const statusStyle = (color: string, pill: boolean): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  fontSize: '14px',
  lineHeight: '20px',
  color,
  minWidth: 0,
  overflow: 'hidden',
  whiteSpace: 'nowrap',
  textOverflow: 'ellipsis',
  ...(pill
    ? {
        padding: '1px 8px 1px 6px',
        borderRadius: '8px',
        background: `color-mix(in srgb, ${color} 10%, transparent)`,
      }
    : {}),
});

/** Relative "N 分钟/小时/天前" suffix for the last-run badge (zh strings, repo precedent in CodeReviewPanel). */
function relativeTimeSuffix(ts: number): string {
  const diff = Date.now() - ts;
  const minutes = Math.floor(diff / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(diff / 3_600_000);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(diff / 86_400_000)} 天前`;
}

// ─── component ─────────────────────────────────────────────────────────────

export interface WorkflowLibraryViewProps {
  /** Optional project dir to also show project-scoped workflows. */
  projectDir?: string;
  /** Open a chat session to create a workflow via conversation. */
  onCreateViaConversation?: (scope: 'global' | 'project', projectDir?: string) => void;
  /** Navigate to a workflow's detail page. */
  onOpenDetail?: (name: string, scope: 'global' | 'project', projectDir?: string) => void;
  /** Optional project display name for the project group. */
  projectName?: string;
  /**
   * Render only the content, without the PageFrame/PageHeader shell —
   * used when a parent page (WorkflowPage) owns the header and the
   * tab bar. Vertical rhythm matches `.page-frame-inner` so the switch
   * is visually seamless.
   */
  embedded?: boolean;
}

export function WorkflowLibraryView({
  projectDir,
  onCreateViaConversation,
  onOpenDetail,
  projectName,
  embedded = false,
}: WorkflowLibraryViewProps) {
  const { t } = useTranslation();
  const [entries, setEntries] = useState<Awaited<ReturnType<typeof listDwfWorkflowsIPC>>['entries']>([]);
  const [invalidFiles, setInvalidFiles] = useState<Awaited<ReturnType<typeof listDwfWorkflowsIPC>>['invalid']>([]);
  const [runs, setRuns] = useState<Awaited<ReturnType<typeof listWorkflowRunsIPC>>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /**
   * Plan 560 §7.5: ▶ opens the 实参窗 — it picks the run's working directory and
   * the argument values before anything is launched. Firing straight from the
   * card would leave the agent nodes with no working directory at all.
   */
  const [launching, setLaunching] = useState<LibraryEntry | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [listResult, runsList] = await Promise.all([
        listDwfWorkflowsIPC(projectDir),
        listWorkflowRunsIPC({ limit: 200 }),
      ]);
      setEntries(listResult?.entries ?? []);
      setInvalidFiles(listResult?.invalid ?? []);
      setRuns(runsList ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [projectDir]);

  useEffect(() => {
    reload();
  }, [reload]);

  // Auto-refresh when a watched library directory changes on disk (files
  // created outside the UI: agent-authored workflows, manual edits). The
  // main process already debounces the fs events.
  useEffect(() => {
    return onDwfWorkflowsChangedIPC(() => {
      void reload();
    });
  }, [reload]);

  // Group entries by scope
  const globalEntries = useMemo(() => entries.filter((d) => d.scope === 'global'), [entries]);
  const projectEntries = useMemo(() => entries.filter((d) => d.scope === 'project'), [entries]);

  // Last-run status lookup by workflow name
  const lastRunByName = useMemo(() => {
    const map = new Map<string, WorkflowRunRow>();
    for (const r of runs) {
      if (!map.has(r.workflowName)) map.set(r.workflowName, r);
    }
    return map;
  }, [runs]);

  const renderCard = (def: typeof entries[number]) => {
    const lastRun = lastRunByName.get(def.name);
    const status = lastRun?.status ?? null;
    const running = status === 'running';
    const statusColor =
      status === 'complete'
        ? 'var(--accent-emerald, #10b981)'
        : status === 'failed'
          ? 'var(--accent-rose, #f43f5e)'
          : running
            ? 'var(--accent)'
            : 'var(--text-faint)';
    const statusLabel = status
      ? (t(`workflow.runStatus.${status}` as never) ?? status)
      : t('workflow.neverRun');
    const badgeLabel =
      lastRun && !running ? `${statusLabel} · ${relativeTimeSuffix(lastRun.updatedAt)}` : statusLabel;
    const statusIcon =
      status === 'complete' ? (
        <CheckCircleIcon size={14} />
      ) : status === 'failed' ? (
        <XCircleIcon size={14} />
      ) : running ? (
        <CircleNotchIcon size={14} />
      ) : status ? (
        <CircleIcon size={14} />
      ) : null;

    const cardMenu: MenuAction[] = [
      {
        kind: 'action',
        id: 'delete',
        label: t('workflow.action.delete'),
        iconLeft: <TrashIcon size={14} />,
        danger: true,
        onSelect: () => {
          if (!window.confirm(`Delete workflow "${def.name}"?`)) return;
          void deleteDwfWorkflowIPC({ name: def.name, scope: def.scope, projectDir }).then(reload);
        },
      },
    ];

    return (
      <div
        key={`${def.scope}:${def.name}`}
        style={cardStyle}
        onClick={() => onOpenDetail?.(def.name, def.scope, projectDir)}
      >
        <div style={cardNameStyle}>{def.name}</div>
        <div style={cardDescriptionStyle}>{def.description || '—'}</div>
        <div style={cardFooterStyle}>
          <span style={statusStyle(statusColor, status !== null)}>
            {statusIcon}
            {badgeLabel}
          </span>
        </div>

        {/* Card-face actions layer above the whole-card click, mirroring ZCode's top-right run + ⋯. */}
        <div
          style={cardActionsStyle}
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <button
            style={runButtonStyle}
            onClick={() => setLaunching(def)}
            aria-label={t('workflow.action.run')}
            title={t('workflow.action.run')}
          >
            <PlayIcon size={12} />
            {t('workflow.action.run')}
          </button>
          <DropdownMenu
            trigger={
              <button style={menuTriggerStyle} aria-label="more" title="more">
                <DotsThreeIcon size={14} />
              </button>
            }
            items={cardMenu}
            align="end"
          />
        </div>
      </div>
    );
  };

  const content = (
    <>
      {error && (
        <PageCard>
          <EmptyState
            icon={<RepeatIcon size={24} />}
            title={t('workflow.error.title')}
            description={error}
          />
        </PageCard>
      )}

      {!error && loading && (
        <PageCard>
          <EmptyState title={t('workflow.loading')} icon={<RepeatIcon size={20} />} />
        </PageCard>
      )}

      {/* Files that exist on disk but fail to parse: show them loudly instead of
          letting them silently vanish from the list (a typo'd frontmatter key
          would otherwise look like the workflow never got created). */}
      {!error && invalidFiles.length > 0 && (
        <PageCard>
          <div style={{ padding: '10px 14px', display: 'grid', gap: 6 }}>
            <div style={{ ...emptyTitleStyle, fontSize: 13 }}>
              {invalidFiles.length} 个 workflow 文件无法识别（不会出现在列表中）
            </div>
            {invalidFiles.map((item) => {
              const raw = item as { path?: string; error?: string; reason?: string; detail?: string };
              const why = raw.error ?? raw.reason ?? '未知原因';
              const detail = raw.detail ? ` — ${raw.detail}` : '';
              return (
                <div key={raw.path} style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                  <span style={{ color: 'var(--accent-rose, #f43f5e)' }}>●</span>{' '}
                  <code>{raw.path}</code>
                  <div style={{ color: 'var(--text-faint)' }}>{why}{detail}</div>
                </div>
              );
            })}
          </div>
        </PageCard>
      )}

      {/* Global-only surface with nothing at all: general empty card. When a project is
          present the project-empty card below carries the CTA instead (ZCode behavior). */}
      {!error && !loading && entries.length === 0 && !projectDir && (
        <div style={emptyCardStyle}>
          <div style={emptyTextStyle}>
            <p style={emptyTitleStyle}>{t('automation.empty.title')}</p>
            <p style={emptyHintStyle}>{t('automation.empty.description')}</p>
          </div>
          {onCreateViaConversation && (
            <button
              style={primaryButtonStyle}
              onClick={() => onCreateViaConversation('global', projectDir)}
            >
              <PlusIcon size={14} />
              {t('automation.create.viaConversation')}
            </button>
          )}
        </div>
      )}

      {/* Global group */}
      {!error && !loading && globalEntries.length > 0 && (
        <div style={scopeGroupStyle}>
          <div style={scopeHeaderStyle}>
            <div style={scopeTitleStyle}>
              <GlobeIcon size={14} />
              {t('workflow.scopeGlobal')}
              <span style={scopeCountStyle}>{globalEntries.length}</span>
            </div>
            {onCreateViaConversation && (
              <button
                style={createButtonStyle}
                onClick={() => onCreateViaConversation('global', projectDir)}
              >
                <PlusIcon size={14} />
                {t('automation.create.viaConversation')}
              </button>
            )}
          </div>
          <div style={cardGridStyle}>{globalEntries.map(renderCard)}</div>
        </div>
      )}

      {/* Project group, or the ZCode-style "no saved workflows in this project" card */}
      {!error && !loading && projectDir && projectEntries.length > 0 && (
        <div style={scopeGroupStyle}>
          <div style={scopeHeaderStyle}>
            <div style={scopeTitleStyle}>
              <FolderIcon size={14} />
              {projectName ?? projectDir.split(/[\\/]/).pop() ?? 'Project'}
              <span style={scopeCountStyle}>{projectEntries.length}</span>
            </div>
            {onCreateViaConversation && (
              <button
                style={createButtonStyle}
                onClick={() => onCreateViaConversation('project', projectDir)}
              >
                <PlusIcon size={14} />
                {t('automation.create.viaConversation')}
              </button>
            )}
          </div>
          <div style={cardGridStyle}>{projectEntries.map(renderCard)}</div>
        </div>
      )}
      {!error && !loading && projectDir && projectEntries.length === 0 && (
        <div style={emptyCardStyle}>
          <div style={emptyTextStyle}>
            <p style={emptyTitleStyle}>{t('workflow.projectEmpty.title')}</p>
            <p style={emptyHintStyle}>{t('workflow.projectEmpty.hint')}</p>
          </div>
          {onCreateViaConversation && (
            <button
              style={primaryButtonStyle}
              onClick={() => onCreateViaConversation('project', projectDir)}
            >
              <PlusIcon size={14} />
              {t('automation.create.viaConversation')}
            </button>
          )}
        </div>
      )}
      {launching && (
        <WorkflowLaunchDialog
          entry={launching}
          defaultProjectDir={projectDir}
          onClose={() => setLaunching(null)}
          onLaunched={() => void reload()}
        />
      )}
    </>
  );

  if (embedded) {
    return (
      <div
        data-testid="workflow-library-embedded"
        style={{ display: 'flex', flexDirection: 'column', gap: 'var(--page-gap, 16px)' }}
      >
        {content}
      </div>
    );
  }

  return (
    <PageFrame>
      <PageHeader
        title={t('nav.workflow')}
        actions={
          <button
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: '4px',
              padding: '6px 10px',
              background: 'transparent',
              color: 'var(--text-faint)',
              border: '1px solid var(--border-weak)',
              borderRadius: '6px',
              cursor: 'pointer',
            }}
            onClick={reload}
            aria-label="refresh"
          >
            <IconRefresh size={14} />
          </button>
        }
      />

      <div style={mottoStyle}>{t('automation.motto')}</div>

      {content}
    </PageFrame>
  );
}