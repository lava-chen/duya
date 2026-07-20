// PermissionPrompt.tsx - Permission prompt UI component
// Uses the compact sub-agent chrome styles from globals.css.

'use client';

import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import type { PermissionRequestEvent } from '@/types/stream';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';
import {
  ShieldIcon,
  QuestionIcon,
  CaretRightIcon,
  CaretLeftIcon,
  CircleNotchIcon,
  CheckIcon,
  XIcon,
  InfoIcon,
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
 * AskUserQuestion mode - shows multi-option questions, one at a time.
 *
 * Layout (Codex-style, overlays the chat input):
 *   Header:    question text + "< N of M >" switcher (hidden for single-question)
 *   Options:   numbered rows with (i) info button per option (when description present)
 *   Last row:  fixed "No, tell duya what to do differently" — opens a textarea
 *   Footer:    "Dismiss ESC" hint on the left, "Continue ↩" primary button on the right
 *
 * Keyboard: ESC dismisses, Enter submits (only when current question is answered
 * OR the "tell duya differently" textarea has text).
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
  const total = questions.length;

  const [currentIdx, setCurrentIdx] = useState(0);
  // answers[questionText] = selected label(s) joined with " || " (matches legacy format)
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // feedbacks[questionText] = inline free-text answer for that question.
  const [feedbacks, setFeedbacks] = useState<Record<string, string>>({});
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  // Which option's (i) description popover is open (by option label)
  const [openInfo, setOpenInfo] = useState<string | null>(null);

  const current = questions[currentIdx];
  if (!current) return null;

  const currentAnswer = answers[current.question] || '';
  const feedback = feedbacks[current.question] || '';
  const hasSelection = currentAnswer.length > 0;
  const hasFeedback = feedback.trim().length > 0;
  // canSubmit requires either: an option selected, or the "tell duya" textarea filled
  const canSubmit = hasSelection || hasFeedback;
  const isLast = currentIdx === total - 1;
  const isMulti = current.multiSelect;

  useEffect(() => {
    const recommended = current.options.find((opt) => opt.label.includes('(Recommended)'));
    if (!recommended || answers[current.question] || feedbackOpen || feedbacks[current.question]) return;
    setAnswers((prev) => ({ ...prev, [current.question]: recommended.label }));
  }, [answers, current.options, current.question, feedbackOpen, feedbacks]);

  // Toggle / set an option for the current question
  const handleSelectOption = (label: string) => {
    setAnswers((prev) => {
      const existing = prev[current.question] || '';
      if (isMulti) {
        const set = new Set(existing.split(' || ').filter(Boolean));
        if (set.has(label)) set.delete(label); else set.add(label);
        return { ...prev, [current.question]: Array.from(set).join(' || ') };
      }
      // Single-select: clicking the same label again deselects it
      if (existing === label) {
        const next = { ...prev };
        delete next[current.question];
        return next;
      }
      return { ...prev, [current.question]: label };
    });
    // Selecting an option closes the feedback textarea (mutually exclusive per question)
    setFeedbacks((prev) => {
      const next = { ...prev };
      delete next[current.question];
      return next;
    });
    setFeedbackOpen(false);
  };

  const handleToggleFeedback = () => {
    setFeedbackOpen((v) => !v);
    // Toggling feedback clears any option selection for this question
    if (!feedbackOpen && hasSelection) {
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[current.question];
        return next;
      });
    }
  };

  const moveToQuestion = (idx: number) => {
    setCurrentIdx(Math.max(0, Math.min(total - 1, idx)));
    setFeedbackOpen(false);
    setOpenInfo(null);
  };

  const getAnswerForQuestion = (question: string, sourceAnswers: Record<string, string>) => {
    const inlineFeedback = feedbacks[question]?.trim();
    return inlineFeedback ? `User feedback: ${inlineFeedback}` : sourceAnswers[question];
  };

  const handleContinue = () => {
    if (!canSubmit) return;

    const updatedAnswers: Record<string, string> = { ...answers };
    if (hasFeedback) {
      // Free-text feedback replaces any option answer for this question
      updatedAnswers[current.question] = `User feedback: ${feedback.trim()}`;
    }

    if (!isLast) {
      setAnswers(updatedAnswers);
      moveToQuestion(currentIdx + 1);
      return;
    }

    const finalAnswers: Record<string, string> = {};
    for (const question of questions) {
      const answer = getAnswerForQuestion(question.question, updatedAnswers);
      if (answer?.trim()) {
        finalAnswers[question.question] = answer;
      }
    }

    const firstMissingIdx = questions.findIndex((question) => !finalAnswers[question.question]?.trim());
    if (firstMissingIdx >= 0) {
      setAnswers(updatedAnswers);
      moveToQuestion(firstMissingIdx);
      return;
    }
    onSubmit('allow', { questions: toolInput.questions, answers: finalAnswers });
  };

  const handleDismiss = () => {
    onSubmit('allow', { questions: toolInput.questions, answers: {}, _dismissed: true });
  };

  // Document-level keyboard shortcuts: ESC dismiss, Enter submit
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Don't hijack typing in the feedback textarea or in the chat input
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT' ||
          (target as HTMLElement).isContentEditable)) {
        if (e.key === 'Escape' && feedbackOpen) {
          e.preventDefault();
          handleDismiss();
        } else if (e.key === 'Enter' && canSubmit && feedbackOpen) {
          e.preventDefault();
          handleContinue();
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        handleDismiss();
      } else if (e.key === 'Enter' && canSubmit) {
        e.preventDefault();
        handleContinue();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSubmit, feedbackOpen, feedback, answers, currentIdx]);

  return (
    <div className="ask-question-sheet">
      <div className="ask-question-sheet-header">
        <div className="flex-1 min-w-0">
          <p className="ask-question-title">{current.question}</p>
        </div>
        {total > 1 && (
          <div className="ask-question-pager">
            <button
              type="button"
              onClick={() => moveToQuestion(currentIdx - 1)}
              disabled={currentIdx === 0}
              className="ask-question-pager-btn"
              aria-label="Previous question"
            >
              <CaretLeftIcon size={12} />
            </button>
            <span className="ask-question-pager-count">
              {t('permission.questionSwitcher', { current: currentIdx + 1, total })}
            </span>
            <button
              type="button"
              onClick={() => moveToQuestion(currentIdx + 1)}
              disabled={isLast}
              className="ask-question-pager-btn"
              aria-label="Next question"
            >
              <CaretRightIcon size={12} />
            </button>
          </div>
        )}
      </div>

      <div className="ask-question-options">
        {current.options.map((opt, i) => {
          const isSelected = currentAnswer === opt.label || (isMulti && currentAnswer.split(' || ').includes(opt.label));
          const isRecommended = opt.label.includes('(Recommended)');
          const cleanLabel = opt.label.replace(' (Recommended)', '');
          const showInfo = !!opt.description && openInfo === opt.label;
          return (
            <div key={opt.label} className="ask-question-option-wrap">
              <div
                role="button"
                tabIndex={0}
                onClick={() => handleSelectOption(opt.label)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    handleSelectOption(opt.label);
                  }
                }}
                className={`ask-question-option ${isSelected ? 'selected' : ''}`}
              >
                <span className="ask-question-option-number">
                  {i + 1}.
                </span>
                <span className="ask-question-option-label">
                  {cleanLabel}
                  {isRecommended && (
                    <span className="ask-question-recommended">推荐</span>
                  )}
                </span>
                {isMulti ? (
                  <span
                    className={`ask-question-check ${isSelected ? 'selected' : ''}`}
                    aria-hidden
                  >
                    {isSelected && <CheckIcon size={10} weight="bold" />}
                  </span>
                ) : (
                  <span
                    className={`ask-question-radio ${isSelected ? 'selected' : ''}`}
                    aria-hidden
                  >
                    {isSelected && <span />}
                  </span>
                )}
                {opt.description && (
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setOpenInfo((v) => (v === opt.label ? null : opt.label));
                    }}
                    className="ask-question-info"
                    aria-label="Show description"
                  >
                    <InfoIcon size={12} weight="regular" />
                  </button>
                )}
              </div>
              {showInfo && opt.description && (
                <div
                  className="ask-question-description"
                  role="tooltip"
                >
                  {opt.description}
                </div>
              )}
            </div>
          );
        })}
      </div>

      <div className="ask-question-footer">
        <div
          role="button"
          tabIndex={0}
          onClick={handleToggleFeedback}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              handleToggleFeedback();
            }
          }}
          className={`ask-question-option feedback ${feedbackOpen || hasFeedback ? 'selected' : ''}`}
        >
          <span className="ask-question-option-number">
            {current.options.length + 1}.
          </span>
          {feedbackOpen ? (
            <input
              autoFocus
              value={feedback}
              onClick={(e) => e.stopPropagation()}
              onChange={(e) => setFeedbacks((prev) => ({ ...prev, [current.question]: e.target.value }))}
              placeholder={t('permission.feedbackPlaceholder')}
              className="ask-question-feedback-input"
            />
          ) : (
            <span className="ask-question-option-label">
              {t('permission.tellDuyaWhatToDoDifferently')}
            </span>
          )}
        </div>
        <div className="ask-question-footer-actions">
        <button type="button" onClick={handleDismiss} className="ask-question-dismiss">
          <span>{t('permission.dismissHint')}</span>
          <kbd>ESC</kbd>
        </button>
        <button
          type="button"
          onClick={handleContinue}
          disabled={!canSubmit}
          className="ask-question-continue"
        >
          <span>{t('permission.continueHint')}</span>
          <kbd>
            ⏎
          </kbd>
        </button>
        </div>
      </div>
    </div>
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

  const isInteractiveQuestion =
    pendingPermission?.toolName === 'AskUserQuestion' ||
    pendingPermission?.mode === 'ask_user_question';

  // Full-access mode skips permission prompts, but AskUserQuestion is
  // user input rather than a permission gate, so it must stay visible.
  if (permissionProfile === 'full_access' && !isInteractiveQuestion) return null;

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
    <div className={`permission-prompt-wrapper ${toolName === 'AskUserQuestion' ? 'ask-user-question' : ''}`}>
      <div className={`permission-prompt-panel ${toolName === 'AskUserQuestion' ? 'ask-user-question-panel' : ''}`}>
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
