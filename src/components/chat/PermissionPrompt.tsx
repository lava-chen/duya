// PermissionPrompt.tsx - Permission prompt UI component
// Style aligned with SubAgentPanel (globals.css .sub-agent-*).

'use client';

import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { PermissionRequestEvent } from '@/types/stream';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import {
  ShieldIcon,
  QuestionIcon,
  CaretRightIcon,
  CircleNotchIcon,
  CheckIcon,
  XIcon,
} from '@/components/icons';

interface PermissionPromptProps {
  /** Current pending permission request */
  pendingPermission: PermissionRequestEvent | null;
  /** The decision that was made for the last permission */
  permissionResolved: 'allow' | 'deny' | null;
  /** Callback when user responds to permission */
  onPermissionResponse: (decision: 'allow' | 'allow_session' | 'deny', updatedInput?: Record<string, unknown>, denyMessage?: string) => void;
  /** Permission profile - 'full_access' skips prompts */
  permissionProfile?: 'default' | 'auto' | 'full_access';
  /** Auto mode related info from the backend */
  autoModeInfo?: {
    active: boolean;
    circuitBroken?: boolean;
    denialReason?: string;
  } | null;
}

const MAX_INPUT_LINES = 8;
const MAX_INPUT_CHARS = 500;

function summarizePermission(request: PermissionRequestEvent): { title: string; summary: string } {
  const input = request.toolInput || {};
  const filePath = (input.file_path || input.path) ? String(input.file_path || input.path) : null;

  if (request.toolName === 'Edit') {
    return {
      title: 'Edit',
      summary: filePath ? `将更新文件内容：${filePath}` : '将更新文件内容',
    };
  }
  if (request.toolName === 'Write') {
    return {
      title: 'Write',
      summary: filePath ? `将写入文件：${filePath}` : '将写入文件',
    };
  }
  if (request.toolName === 'Bash') {
    return {
      title: 'Bash',
      summary: '将执行一条命令',
    };
  }
  return {
    title: request.toolName,
    summary: '需要你的确认后继续执行',
  };
}

function getHeaderIcon(toolName: string | undefined) {
  if (toolName === 'AskUserQuestion') return QuestionIcon;
  if (toolName === 'ExitPlanMode') return ShieldIcon;
  return ShieldIcon;
}

function formatToolInput(inp: Record<string, unknown>): string {
  if (inp.command) {
    const cmd = String(inp.command);
    const extraKeys = Object.keys(inp).filter(k => k !== 'command' && k !== 'description');
    if (extraKeys.length > 0) {
      return JSON.stringify(inp, null, 2);
    }
    return cmd;
  }
  if (inp.file_path) {
    const keys = Object.keys(inp);
    if (keys.length === 1) return String(inp.file_path);
    return JSON.stringify(inp, null, 2);
  }
  if (inp.path) {
    const keys = Object.keys(inp);
    if (keys.length === 1) return String(inp.path);
    return JSON.stringify(inp, null, 2);
  }
  return JSON.stringify(inp, null, 2);
}

interface PanelHeaderProps {
  toolName: string | undefined;
  title: string;
  summary: string;
  detailCount?: number;
  expanded: boolean;
  onToggle: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function PanelHeader({ toolName, title, summary, detailCount, expanded, onToggle }: PanelHeaderProps) {
  const Icon = getHeaderIcon(toolName);
  return (
    <div className="permission-prompt-header">
      <button
        type="button"
        className="permission-prompt-header-toggle"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <Icon size={14} className="permission-prompt-icon" />
        <CaretRightIcon
          size={12}
          className={`permission-prompt-caret ${expanded ? 'rotate-90' : ''}`}
        />
        <span className="permission-prompt-tag">{title}</span>
        <span className="permission-prompt-summary" title={summary}>{summary}</span>
        {detailCount !== undefined && detailCount > 0 && (
          <span className="permission-prompt-status-spinner" aria-hidden>
            <CircleNotchIcon size={12} weight="bold" className="animate-spin" />
          </span>
        )}
      </button>
    </div>
  );
}

interface CollapsibleDetailsProps {
  children: React.ReactNode;
  expanded: boolean;
  onToggle: () => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

function CollapsibleDetails({ children, expanded, onToggle, t }: CollapsibleDetailsProps) {
  return (
    <AnimatePresence initial={false}>
      {expanded && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ duration: 0.2, ease: 'easeInOut' }}
          className="overflow-hidden"
        >
          <div className="permission-prompt-body">{children}</div>
          <div className="permission-prompt-actions">
            <button
              type="button"
              onClick={onToggle}
              className="permission-prompt-expand-btn"
            >
              ▲ {t('permission.collapse')}
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

function ToolInputBlock({ input, t }: { input: Record<string, unknown>; t: (key: TranslationKey, params?: Record<string, string | number>) => string }) {
  const [expanded, setExpanded] = useState(false);
  const formatted = formatToolInput(input);
  const lineCount = formatted.split('\n').length;
  const isTruncated = lineCount > MAX_INPUT_LINES || formatted.length > MAX_INPUT_CHARS;
  const truncated = !expanded && isTruncated
    ? formatted.slice(0, MAX_INPUT_CHARS).split('\n').slice(0, MAX_INPUT_LINES).join('\n') + '\n…'
    : formatted;
  return (
    <div className={`permission-prompt-tool-input ${expanded ? 'expanded' : ''}`}>
      <pre>{truncated}</pre>
      {isTruncated && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="permission-prompt-expand-btn"
        >
          {expanded ? '▲ ' + t('permission.collapse') : '▼ ' + t('permission.showMore')}
        </button>
      )}
    </div>
  );
}

/**
 * Generic confirmation prompt for tool permission requests
 */
function GenericPermissionPrompt({
  pendingPermission,
  onPermissionResponse,
  t,
}: {
  pendingPermission: PermissionRequestEvent;
  onPermissionResponse: (decision: 'allow' | 'allow_session' | 'deny') => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [expanded, setExpanded] = useState(false);
  const { title, summary } = summarizePermission(pendingPermission);
  const reason = pendingPermission.decisionReason;
  return (
    <>
      <PanelHeader
        toolName={pendingPermission.toolName}
        title={title}
        summary={summary}
        detailCount={reason ? 1 : 0}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        t={t}
      />
      {reason && <p className="permission-prompt-reason">{reason}</p>}
      <CollapsibleDetails expanded={expanded} onToggle={() => setExpanded((v) => !v)} t={t}>
        <ToolInputBlock input={pendingPermission.toolInput} t={t} />
      </CollapsibleDetails>
      <div className="permission-prompt-actions">
        <button
          type="button"
          onClick={() => onPermissionResponse('deny')}
          className="permission-prompt-btn permission-prompt-btn-danger"
        >
          {t('permission.deny')}
        </button>
        <button
          type="button"
          onClick={() => onPermissionResponse('allow')}
          className="permission-prompt-btn"
        >
          {t('permission.allowOnce')}
        </button>
        <button
          type="button"
          onClick={() => onPermissionResponse('allow_session')}
          className="permission-prompt-btn permission-prompt-btn-primary"
        >
          {t('permission.allowForSession')}
        </button>
      </div>
    </>
  );
}

/**
 * AskUserQuestion mode - shows multi-option questions
 */
function AskUserQuestionUI({
  toolInput,
  onSubmit,
  t,
}: {
  toolInput: Record<string, unknown>;
  onSubmit: (decision: 'allow', updatedInput: Record<string, unknown>) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const questions = (toolInput.questions || []) as Array<{
    question: string;
    options: Array<{ label: string; description?: string }>;
    multiSelect: boolean;
    header?: string;
  }>;
  const questionCount = questions.length;
  const firstHeader = questions[0]?.header;
  const [expanded, setExpanded] = useState(true);
  const [selections, setSelections] = useState<Record<string, Set<string>>>({});
  const [otherTexts, setOtherTexts] = useState<Record<string, string>>({});
  const [useOther, setUseOther] = useState<Record<string, boolean>>({});

  const toggleOption = (qIdx: string, label: string, multi: boolean) => {
    setSelections((prev) => {
      const current = new Set(prev[qIdx] || []);
      if (multi) {
        if (current.has(label)) { current.delete(label); } else { current.add(label); }
      } else {
        current.clear();
        current.add(label);
      }
      return { ...prev, [qIdx]: current };
    });
    setUseOther((prev) => ({ ...prev, [qIdx]: false }));
  };

  const toggleOther = (qIdx: string, multi: boolean) => {
    if (!multi) {
      setSelections((prev) => ({ ...prev, [qIdx]: new Set() }));
    }
    setUseOther((prev) => ({ ...prev, [qIdx]: !prev[qIdx] }));
  };

  const handleSubmit = () => {
    const answers: Record<string, string> = {};
    questions.forEach((q, i) => {
      const qIdx = String(i);
      const selected = Array.from(selections[qIdx] || []);
      if (useOther[qIdx] && otherTexts[qIdx]?.trim()) {
        selected.push(`Other: ${otherTexts[qIdx].trim()}`);
      }
      answers[q.question] = selected.join(' || ');
    });
    onSubmit('allow', { questions: toolInput.questions, answers });
  };

  const hasAnswer = questions.some((_, i) => {
    const qIdx = String(i);
    return (selections[qIdx]?.size || 0) > 0 || (useOther[qIdx] && otherTexts[qIdx]?.trim());
  });

  return (
    <>
      <PanelHeader
        toolName="AskUserQuestion"
        title="AskUserQuestion"
        summary={
          firstHeader
            ? `${questionCount} 个问题 · ${firstHeader}${questionCount > 1 ? ' …' : ''}`
            : `${questionCount} 个问题`
        }
        detailCount={questions.length}
        expanded={expanded}
        onToggle={() => setExpanded((v) => !v)}
        t={t}
      />
      <AnimatePresence initial={false}>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="permission-prompt-questions">
              {questions.map((q, i) => {
                const qIdx = String(i);
                const selected = selections[qIdx] || new Set<string>();
                return (
                  <div key={qIdx} className="permission-prompt-question">
                    {q.header && (
                      <span className="permission-prompt-question-header">{q.header}</span>
                    )}
                    <p className="permission-prompt-question-text">{q.question}</p>
                    <div className="permission-prompt-options">
                      {q.options.map((opt) => {
                        const isSelected = selected.has(opt.label);
                        const isRecommended = opt.label.includes('(Recommended)');
                        const cleanLabel = opt.label.replace(' (Recommended)', '');
                        return (
                          <button
                            key={opt.label}
                            type="button"
                            onClick={() => toggleOption(qIdx, opt.label, q.multiSelect)}
                            className={`permission-prompt-option ${isSelected ? 'selected' : ''}`}
                            title={opt.description}
                          >
                            {q.multiSelect && (
                              <span className="permission-prompt-option-check">
                                {isSelected ? '☑' : '☐'}
                              </span>
                            )}
                            <span>{cleanLabel}</span>
                            {isRecommended && (
                              <span className="permission-prompt-option-star" aria-label="recommended">★</span>
                            )}
                          </button>
                        );
                      })}
                      <button
                        type="button"
                        onClick={() => toggleOther(qIdx, q.multiSelect)}
                        className={`permission-prompt-option ${useOther[qIdx] ? 'selected' : ''}`}
                      >
                        {t('permission.other')}
                      </button>
                    </div>
                    {useOther[qIdx] && (
                      <input
                        type="text"
                        placeholder={t('permission.typeAnswer')}
                        value={otherTexts[qIdx] || ''}
                        onChange={(e) => setOtherTexts((prev) => ({ ...prev, [qIdx]: e.target.value }))}
                        className="permission-prompt-other-input"
                        autoFocus
                      />
                    )}
                  </div>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
      <div className="permission-prompt-actions">
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!hasAnswer}
          className="permission-prompt-btn permission-prompt-btn-primary"
        >
          {t('permission.submit')}
        </button>
      </div>
    </>
  );
}

/**
 * ExitPlanMode UI - Plan mode completion approval
 */
function ExitPlanModeUI({
  pendingPermission,
  onApprove,
  onDeny,
  onDenyWithMessage,
  t,
}: {
  pendingPermission: PermissionRequestEvent;
  onApprove: () => void;
  onDeny: () => void;
  onDenyWithMessage: (message: string) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  const [feedback, setFeedback] = useState('');
  const toolInput = pendingPermission.toolInput as Record<string, unknown>;
  const allowedPrompts = (toolInput.allowedPrompts || []) as Array<{
    tool: string;
    prompt: string;
  }>;
  const summary = allowedPrompts.length
    ? `${allowedPrompts.length} 项计划操作需要授权`
    : '需要你的确认后继续执行';

  return (
    <>
      <PanelHeader
        toolName="ExitPlanMode"
        title="ExitPlanMode"
        summary={summary}
        detailCount={allowedPrompts.length}
        expanded
        onToggle={() => undefined}
        t={t}
      />
      <div className="permission-prompt-plan-card">
        <div className="permission-prompt-plan-title">
          <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="9 11 12 14 22 4" />
            <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
          </svg>
          <span>{t('permission.planComplete')}</span>
        </div>
        {allowedPrompts.length > 0 && (
          <div className="permission-prompt-plan-section">
            <span className="permission-prompt-plan-label">{t('permission.requestedPermissions')}</span>
            <ul className="permission-prompt-plan-list">
              {allowedPrompts.map((p, i) => (
                <li key={i} className="permission-prompt-plan-list-item">
                  <span className="permission-prompt-plan-tool">{p.tool}</span>
                  <span>{p.prompt}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="permission-prompt-actions" style={{ padding: 0 }}>
          <button
            type="button"
            onClick={onDeny}
            className="permission-prompt-btn permission-prompt-btn-danger"
          >
            {t('permission.reject')}
          </button>
          <button
            type="button"
            onClick={onApprove}
            className="permission-prompt-btn permission-prompt-btn-primary"
          >
            {t('permission.approveExecute')}
          </button>
        </div>
        <div className="permission-prompt-feedback-row">
          <input
            type="text"
            placeholder={t('permission.provideFeedback')}
            value={feedback}
            onChange={(e) => setFeedback(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && feedback.trim()) {
                onDenyWithMessage(feedback.trim());
              }
            }}
            className="permission-prompt-feedback-input"
          />
          <button
            type="button"
            onClick={() => {
              if (feedback.trim()) onDenyWithMessage(feedback.trim());
            }}
            disabled={!feedback.trim()}
            className="permission-prompt-btn"
          >
            {t('permission.doThisInstead')}
          </button>
        </div>
      </div>
    </>
  );
}

function ResolvedStatus({
  toolName,
  permissionResolved,
  t,
}: {
  toolName: string | undefined;
  permissionResolved: 'allow' | 'deny';
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}) {
  if (toolName === 'AskUserQuestion') {
    return (
      <p className="permission-prompt-resolved allowed">{t('permission.answerSubmitted')}</p>
    );
  }
  if (toolName === 'ExitPlanMode') {
    return (
      <p className={`permission-prompt-resolved ${permissionResolved === 'allow' ? 'allowed' : 'denied'}`}>
        {permissionResolved === 'allow' ? t('permission.planApproved') : t('permission.planRejected')}
      </p>
    );
  }
  return (
    <p className={`permission-prompt-resolved ${permissionResolved === 'allow' ? 'allowed' : 'denied'}`}>
      <span>{permissionResolved === 'allow' ? <CheckIcon size={12} weight="bold" /> : <XIcon size={12} weight="bold" />}</span>
      <span>{permissionResolved === 'allow' ? t('permission.allowed') : t('permission.denied')}</span>
    </p>
  );
}

/**
 * PermissionPrompt - Displays permission requests and handles user responses
 */
export function PermissionPrompt({
  pendingPermission,
  permissionResolved,
  onPermissionResponse,
  permissionProfile,
  autoModeInfo,
}: PermissionPromptProps) {
  const { t } = useTranslation();

  // Don't render permission UI when full_access
  if (permissionProfile === 'full_access') return null;

  // Nothing to show
  if (!pendingPermission && !permissionResolved) return null;

  const isResolved = !!permissionResolved;
  const toolName = pendingPermission?.toolName;

  // Resolved-only rendering: smaller, fully rounded card
  if (isResolved && !pendingPermission) {
    return (
      <div className="permission-prompt-wrapper">
        <div className="permission-prompt-panel resolved">
          <ResolvedStatus toolName={undefined} permissionResolved={permissionResolved} t={t} />
        </div>
      </div>
    );
  }

  if (!pendingPermission) return null;

  return (
    <div className="permission-prompt-wrapper">
      <div className="permission-prompt-panel">
        {/* Auto mode indicator */}
        {autoModeInfo?.active && (
          <div className="permission-prompt-auto-chip">
            {autoModeInfo.circuitBroken
              ? t('permission.autoModeCircuitBroken')
              : t('permission.autoModeActive')}
          </div>
        )}

        {isResolved ? (
          <ResolvedStatus toolName={toolName} permissionResolved={permissionResolved} t={t} />
        ) : toolName === 'AskUserQuestion' ? (
          <AskUserQuestionUI
            toolInput={pendingPermission.toolInput as Record<string, unknown>}
            onSubmit={(decision, updatedInput) => onPermissionResponse(decision, updatedInput)}
            t={t}
          />
        ) : toolName === 'ExitPlanMode' ? (
          <ExitPlanModeUI
            pendingPermission={pendingPermission}
            onApprove={() => onPermissionResponse('allow')}
            onDeny={() => onPermissionResponse('deny')}
            onDenyWithMessage={(msg) => onPermissionResponse('deny', undefined, msg)}
            t={t}
          />
        ) : (
          <GenericPermissionPrompt
            pendingPermission={pendingPermission}
            onPermissionResponse={(decision) => onPermissionResponse(decision)}
            t={t}
          />
        )}
      </div>
    </div>
  );
}
