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
  ChatCirclePlusIcon,
  TrashIcon,
  FolderIcon,
  GlobeIcon,
  PlusIcon,
} from '@/components/icons';
import { PageFrame, PageHeader, PageCard, EmptyState } from '@/components/ui/page';
import {
  listWorkflowDefsIPC,
  triggerWorkflowRunIPC,
  deleteWorkflowDefIPC,
  type WorkflowDefinitionSummary,
  type WorkflowRunRow,
} from '@/lib/workflow-ipc';

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
  padding: '6px 0',
  borderBottom: '1px solid var(--border-weak)',
};

const scopeTitleStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-2, 8px)',
  fontSize: '13px',
  fontWeight: 500,
  color: 'var(--text-faint)',
  textTransform: 'uppercase',
  letterSpacing: '0.04em',
};

const scopeCountStyle: CSSProperties = {
  fontSize: '11px',
  color: 'var(--text-faint)',
  background: 'var(--bg-surface-2, rgba(255,255,255,0.05))',
  padding: '1px 8px',
  borderRadius: '999px',
};

const createButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: '4px',
  padding: '4px 10px',
  background: 'transparent',
  color: 'var(--accent)',
  border: 'none',
  borderRadius: '6px',
  cursor: 'pointer',
  fontSize: '12px',
};

const cardGridStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))',
  gap: 'var(--space-3, 12px)',
};

const cardStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--space-2, 8px)',
  padding: '14px',
  background: 'var(--bg-surface-1, transparent)',
  border: '1px solid var(--border-weak)',
  borderRadius: '8px',
  cursor: 'pointer',
  transition: 'border-color 120ms ease, background 120ms ease',
  position: 'relative',
};

const cardHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  justifyContent: 'space-between',
  gap: 'var(--space-2, 8px)',
};

const cardNameStyle: CSSProperties = {
  fontSize: '14px',
  fontWeight: 500,
  color: 'var(--text)',
  fontFamily: 'var(--font-mono, ui-monospace, "SF Mono", monospace)',
};

const cardDescriptionStyle: CSSProperties = {
  fontSize: '12px',
  color: 'var(--text-faint)',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflow: 'hidden',
  lineHeight: 1.4,
};

const cardFooterStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'space-between',
  gap: 'var(--space-2, 8px)',
  marginTop: 'var(--space-2, 8px)',
};

const statusStyle = (color: string): CSSProperties => ({
  display: 'inline-flex',
  alignItems: 'center',
  gap: '6px',
  fontSize: '11px',
  color,
});

const statusDotStyle = (bg: string): CSSProperties => ({
  width: '6px',
  height: '6px',
  borderRadius: '50%',
  background: bg,
});

const cardActionsStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--space-1, 4px)',
};

const iconButtonStyle: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  width: '28px',
  height: '28px',
  padding: 0,
  background: 'transparent',
  color: 'var(--text-faint)',
  border: '1px solid var(--border-weak)',
  borderRadius: '6px',
  cursor: 'pointer',
};

const runButtonStyle: CSSProperties = {
  ...iconButtonStyle,
  background: 'var(--accent)',
  color: 'var(--accent-on, #fff)',
  borderColor: 'transparent',
};

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
  const [defs, setDefs] = useState<WorkflowDefinitionSummary[]>([]);
  const [runs, setRuns] = useState<WorkflowRunRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [list, runsList] = await Promise.all([
        listWorkflowDefsIPC(projectDir),
        import('@/lib/workflow-ipc').then((m) => m.listWorkflowRunsIPC({ limit: 200 })),
      ]);
      setDefs(list ?? []);
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

  // Group defs by scope
  const globalDefs = useMemo(() => defs.filter((d) => d.scope === 'global'), [defs]);
  const projectDefs = useMemo(() => defs.filter((d) => d.scope === 'project'), [defs]);

  // Last-run status lookup by workflow name
  const lastRunByName = useMemo(() => {
    const map = new Map<string, WorkflowRunRow>();
    for (const r of runs) {
      if (!map.has(r.workflowName)) map.set(r.workflowName, r);
    }
    return map;
  }, [runs]);

  const renderCard = (def: WorkflowDefinitionSummary) => {
    const lastRun = lastRunByName.get(def.name);
    const status = lastRun?.status ?? null;
    const statusColor =
      status === 'complete'
        ? 'var(--accent-emerald, #10b981)'
        : status === 'failed'
          ? 'var(--accent-rose, #f43f5e)'
          : 'var(--text-faint)';
    const statusDotBg = statusColor;
    const statusLabel = status ? (t(`workflow.runStatus.${status}` as never) ?? status) : t('workflow.neverRun');

    return (
      <div
        key={`${def.scope}:${def.name}`}
        style={cardStyle}
        onClick={() => onOpenDetail?.(def.name, def.scope, projectDir)}
      >
        <div style={cardHeaderStyle}>
          <div style={cardNameStyle}>{def.name}</div>
          <button
            style={{ ...iconButtonStyle, border: 'none' }}
            onClick={(e) => {
              e.stopPropagation();
            }}
            aria-label="more"
          >
            <DotsThreeIcon size={14} />
          </button>
        </div>
        <div style={cardDescriptionStyle}>{def.description || '—'}</div>
        <div style={cardFooterStyle}>
          <span style={statusStyle(statusColor)}>
            <span style={statusDotStyle(statusDotBg)} />
            {statusLabel}
          </span>
          <div style={cardActionsStyle} onClick={(e) => e.stopPropagation()}>
            <button
              style={runButtonStyle}
              onClick={async () => {
                await triggerWorkflowRunIPC({ name: def.name, projectDir });
              }}
              aria-label={t('workflow.action.run')}
              title={t('workflow.action.run')}
            >
              <PlayIcon size={12} />
            </button>
            <button
              style={iconButtonStyle}
              onClick={async () => {
                if (!window.confirm(`Delete workflow "${def.name}"?`)) return;
                await deleteWorkflowDefIPC({ name: def.name, scope: def.scope, projectDir });
                reload();
              }}
              aria-label={t('workflow.action.delete')}
              title={t('workflow.action.delete')}
            >
              <TrashIcon size={12} />
            </button>
          </div>
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

      {!error && !loading && defs.length === 0 && (
        <PageCard>
          <EmptyState
            icon={<ChatCirclePlusIcon size={32} />}
            title={t('automation.empty.title')}
            description={t('automation.empty.description')}
            action={
              onCreateViaConversation ? (
                <button
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '6px',
                    padding: '8px 14px',
                    background: 'var(--accent)',
                    color: 'var(--accent-on, #fff)',
                    border: 'none',
                    borderRadius: '6px',
                    cursor: 'pointer',
                  }}
                  onClick={() => onCreateViaConversation('global', projectDir)}
                >
                  <ChatCirclePlusIcon size={14} />
                  {t('automation.create.viaConversation')}
                </button>
              ) : undefined
            }
          />
        </PageCard>
      )}

      {/* Global group */}
      {!error && !loading && globalDefs.length > 0 && (
        <div style={scopeGroupStyle}>
          <div style={scopeHeaderStyle}>
            <div style={scopeTitleStyle}>
              <GlobeIcon size={14} />
              {t('workflow.scopeGlobal')}
              <span style={scopeCountStyle}>{globalDefs.length}</span>
            </div>
            {onCreateViaConversation && (
              <button
                style={createButtonStyle}
                onClick={() => onCreateViaConversation('global', projectDir)}
              >
                <PlusIcon size={12} />
                {t('automation.create.viaConversation')}
              </button>
            )}
          </div>
          <div style={cardGridStyle}>{globalDefs.map(renderCard)}</div>
        </div>
      )}

      {/* Project group */}
      {!error && !loading && projectDefs.length > 0 && projectDir && (
        <div style={scopeGroupStyle}>
          <div style={scopeHeaderStyle}>
            <div style={scopeTitleStyle}>
              <FolderIcon size={14} />
              {projectName ?? projectDir.split(/[\\/]/).pop() ?? 'Project'}
              <span style={scopeCountStyle}>{projectDefs.length}</span>
            </div>
            {onCreateViaConversation && (
              <button
                style={createButtonStyle}
                onClick={() => onCreateViaConversation('project', projectDir)}
              >
                <PlusIcon size={12} />
                {t('automation.create.viaConversation')}
              </button>
            )}
          </div>
          <div style={cardGridStyle}>{projectDefs.map(renderCard)}</div>
        </div>
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
        title={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2, 8px)' }}>
            <RepeatIcon size={18} />
            {t('nav.workflow')}
          </span>
        }
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