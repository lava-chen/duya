"use client";

/**
 * BotAskCard — Plan 494: in-chat AskUserQuestion question card for the
 * bot-direct transcript.
 *
 * Bot-direct does not mount ChatView/PermissionPrompt, so the agent's
 * AskUserQuestion tool call would otherwise deadlock the stream (the
 * permission_request event has no renderer). This card renders the
 * pending question inline (rakazo AskCard/ChoiceCard visual language:
 * letter-badge option rows, header pill, answered state) and submits
 * through the SAME permission channel the workspace sheet uses:
 *
 *   onSubmit({ questions, answers }) → respondToPermission('allow', …)
 *   → permission:resolve → agent storePendingAnswer → tool Phase 2.
 *
 * Answer conventions copied from AskUserQuestionUI (PermissionPrompt.tsx)
 * so the agent-side parser stays compatible:
 *   - multi-select joins labels with " || "
 *   - free-text feedback becomes "User feedback: <text>"
 *   - dismiss submits { answers: {}, _dismissed: true }
 *
 * All questions render stacked (no pager) — a chat card should show the
 * full ask at once, Telegram-bot style. No global keyboard shortcuts:
 * the composer owns ESC/Enter while the card is on screen.
 */

import { useEffect, useMemo, useState } from 'react';
import type { PermissionRequestEvent } from '@/types/stream';
import type { TranslationKey } from '@/i18n';
import { CheckIcon, InfoIcon } from '@/components/icons';

interface AskOption {
  label: string;
  description?: string;
}

interface AskQuestion {
  question: string;
  header?: string;
  options: AskOption[];
  multiSelect?: boolean;
}

export interface BotAskCardProps {
  request: PermissionRequestEvent;
  /** Submit answers via the permission channel ('allow' + updatedInput). */
  onSubmit: (updatedInput: Record<string, unknown>) => void;
  t: (key: TranslationKey, params?: Record<string, string | number>) => string;
}

/** Letter badge for an option row (A/B/C/…, rakazo ChoiceCard style). */
function optionLetter(index: number): string {
  return String.fromCharCode(65 + Math.min(index, 25));
}

/** Multi-select answers share one string per question, joined by " || ". */
function splitAnswer(answer: string): string[] {
  return answer.split(' || ').filter(Boolean);
}

export function BotAskCard({ request, onSubmit, t }: BotAskCardProps) {
  const questions = useMemo<AskQuestion[]>(() => {
    const raw = (request.toolInput as { questions?: unknown } | undefined)?.questions;
    if (!Array.isArray(raw)) return [];
    return raw.filter((q): q is AskQuestion =>
      !!q && typeof q === 'object' &&
      typeof (q as AskQuestion).question === 'string' &&
      Array.isArray((q as AskQuestion).options),
    );
  }, [request.toolInput]);

  // answers[questionText] = selected label(s) joined with " || "
  const [answers, setAnswers] = useState<Record<string, string>>({});
  // feedbacks[questionText] = free-text answer (mutually exclusive with options)
  const [feedbacks, setFeedbacks] = useState<Record<string, string>>({});
  const [feedbackOpen, setFeedbackOpen] = useState<Record<string, boolean>>({});
  // Option description popovers, keyed `${questionIndex}:${optionLabel}`.
  const [openInfo, setOpenInfo] = useState<Record<string, boolean>>({});

  const isAnswered = (q: AskQuestion) => {
    const feedback = feedbacks[q.question]?.trim();
    return feedback ? true : (answers[q.question]?.length ?? 0) > 0;
  };
  const canSubmit = questions.length > 0 && questions.every(isAnswered);

  // Auto-preselect the "(Recommended)" option once per single-select
  // question (AskUserQuestionUI sheet parity). Skipped when the question
  // already has an answer or free-text feedback.
  useEffect(() => {
    setAnswers((prev) => {
      let changed = false;
      const next = { ...prev };
      for (const q of questions) {
        if (q.multiSelect) continue;
        if (next[q.question] || feedbacks[q.question]?.trim()) continue;
        const recommended = q.options.find((opt) => opt.label.includes('(Recommended)'));
        if (recommended) {
          next[q.question] = recommended.label;
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [questions, feedbacks]);

  const selectOption = (q: AskQuestion, label: string) => {
    setAnswers((prev) => {
      const existing = prev[q.question] || '';
      if (q.multiSelect) {
        const set = new Set(splitAnswer(existing));
        if (set.has(label)) set.delete(label); else set.add(label);
        return { ...prev, [q.question]: Array.from(set).join(' || ') };
      }
      if (existing === label) {
        const next = { ...prev };
        delete next[q.question];
        return next;
      }
      return { ...prev, [q.question]: label };
    });
    // Selecting an option clears that question's free-text feedback.
    setFeedbacks((prev) => {
      const next = { ...prev };
      delete next[q.question];
      return next;
    });
    setFeedbackOpen((prev) => ({ ...prev, [q.question]: false }));
  };

  const toggleFeedback = (q: AskQuestion) => {
    const opening = !feedbackOpen[q.question];
    setFeedbackOpen((prev) => ({ ...prev, [q.question]: opening }));
    if (opening) {
      // Opening the textarea clears the option selection for this question.
      setAnswers((prev) => {
        const next = { ...prev };
        delete next[q.question];
        return next;
      });
    }
  };

  const handleSubmit = () => {
    if (!canSubmit) return;
    const finalAnswers: Record<string, string> = {};
    for (const q of questions) {
      const feedback = feedbacks[q.question]?.trim();
      const answer = feedback ? `User feedback: ${feedback}` : answers[q.question];
      if (answer) finalAnswers[q.question] = answer;
    }
    onSubmit({ questions: request.toolInput.questions, answers: finalAnswers });
  };

  const handleDismiss = () => {
    onSubmit({ questions: request.toolInput.questions, answers: {}, _dismissed: true });
  };

  if (questions.length === 0) return null;

  return (
    <div className="bot-ask-card" data-permission-id={request.id}>
      <div className="bot-ask-card__head">
        <span className="bot-ask-card__pill">
          {t('bot.ask.cardTitle', { count: questions.length })}
        </span>
      </div>

      {questions.map((q, qi) => {
        const currentAnswer = answers[q.question] || '';
        const selected = splitAnswer(currentAnswer);
        const feedback = feedbacks[q.question] || '';
        const feedbackIsOpen = !!feedbackOpen[q.question];
        return (
          <section className="bot-ask-card__question" key={`${qi}-${q.question}`}>
            <div className="bot-ask-card__question-head">
              {q.header && <span className="bot-ask-card__tag">{q.header}</span>}
              <p className="bot-ask-card__question-text">{q.question}</p>
            </div>

            <div className="bot-ask-card__options" role={q.multiSelect ? 'group' : 'radiogroup'} aria-label={q.question}>
              {q.options.map((opt, oi) => {
                const isSelected = selected.includes(opt.label);
                const isRecommended = opt.label.includes('(Recommended)');
                const cleanLabel = opt.label.replace(' (Recommended)', '');
                const infoKey = `${qi}:${opt.label}`;
                const showInfo = !!opt.description && !!openInfo[infoKey];
                return (
                  <div className="bot-ask-card__option-wrap" key={opt.label}>
                    <div
                      role="button"
                      tabIndex={0}
                      aria-pressed={q.multiSelect ? isSelected : undefined}
                      aria-checked={q.multiSelect ? undefined : isSelected}
                      onClick={() => selectOption(q, opt.label)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                          e.preventDefault();
                          selectOption(q, opt.label);
                        }
                      }}
                      className={`bot-ask-card__option${isSelected ? ' selected' : ''}`}
                    >
                      <span className="bot-ask-card__letter">{optionLetter(oi)}</span>
                      <span className="bot-ask-card__option-label">
                        {cleanLabel}
                        {isRecommended && <span className="bot-ask-card__recommended">{t('bot.ask.recommended')}</span>}
                      </span>
                      <span className={`bot-ask-card__mark${isSelected ? ' selected' : ''}`} aria-hidden>
                        {isSelected && <CheckIcon size={11} />}
                      </span>
                      {opt.description && (
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            setOpenInfo((prev) => ({ ...prev, [infoKey]: !prev[infoKey] }));
                          }}
                          className="bot-ask-card__info"
                          aria-label="Show description"
                        >
                          <InfoIcon size={12} />
                        </button>
                      )}
                    </div>
                    {showInfo && opt.description && (
                      <div className="bot-ask-card__description" role="tooltip">{opt.description}</div>
                    )}
                  </div>
                );
              })}

              {/* Free-text feedback row — mutually exclusive with options */}
              <div
                className={`bot-ask-card__option bot-ask-card__feedback${feedbackIsOpen || feedback.trim() ? ' selected' : ''}`}
                role="button"
                tabIndex={0}
                onClick={() => toggleFeedback(q)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    toggleFeedback(q);
                  }
                }}
              >
                {feedbackIsOpen ? (
                  <textarea
                    autoFocus
                    value={feedback}
                    onClick={(e) => e.stopPropagation()}
                    onChange={(e) => setFeedbacks((prev) => ({ ...prev, [q.question]: e.target.value }))}
                    placeholder={t('permission.feedbackPlaceholder')}
                    className="bot-ask-card__feedback-input"
                    rows={2}
                  />
                ) : (
                  <span className="bot-ask-card__option-label">
                    {t('permission.tellDuyaWhatToDoDifferently')}
                  </span>
                )}
              </div>
            </div>
          </section>
        );
      })}

      <div className="bot-ask-card__footer">
        <button type="button" onClick={handleDismiss} className="bot-ask-card__dismiss">
          <span>{t('permission.dismissHint')}</span>
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!canSubmit}
          className="bot-ask-card__submit"
        >
          <span>{t('permission.continueHint')}</span>
        </button>
      </div>
    </div>
  );
}
