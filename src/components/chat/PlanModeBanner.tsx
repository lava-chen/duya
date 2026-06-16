/**
 * PlanModeBanner - Top-of-chat indicator shown when the agent is in a
 * read-only mode (plan / explore / verify / code-review).
 *
 * The renderer learns the current mode by watching the streaming tool
 * list: when an EnterPlanMode / ExitPlanMode / SwitchMode tool_use is
 * paired with its result, the JSON `currentMode` field is parsed and
 * fed back into this banner via the `mode` prop. Without this banner
 * the user has no way to tell whether the agent is still in plan mode
 * — the LLM is supposed to call ExitPlanMode on its own, but it
 * sometimes forgets and silently keeps planning.
 */

import React from 'react';
import { useTranslation } from '@/hooks/useTranslation';
import type { TranslationKey } from '@/i18n';

export type RuntimeAgentMode = 'general' | 'plan' | 'explore' | 'verify' | 'code-review';

const MODE_LABEL_KEY: Record<RuntimeAgentMode, TranslationKey> = {
  general: 'planMode.general',
  plan: 'planMode.plan',
  explore: 'planMode.explore',
  verify: 'planMode.verify',
  'code-review': 'planMode.codeReview',
};

const MODE_DESC_KEY: Record<RuntimeAgentMode, TranslationKey> = {
  general: 'planMode.generalDesc',
  plan: 'planMode.planDesc',
  explore: 'planMode.exploreDesc',
  verify: 'planMode.verifyDesc',
  'code-review': 'planMode.codeReviewDesc',
};

interface PlanModeBannerProps {
  mode: RuntimeAgentMode;
  onRequestExit?: () => void;
}

export function PlanModeBanner({ mode, onRequestExit }: PlanModeBannerProps) {
  const { t } = useTranslation();

  // Only render for read-only modes; 'general' means no banner needed.
  if (mode === 'general') return null;

  return (
    <div className="plan-mode-banner" role="status" aria-live="polite">
      <span className="plan-mode-banner-icon" aria-hidden="true">
        <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
        </svg>
      </span>
      <span className="plan-mode-banner-label">{t(MODE_LABEL_KEY[mode])}</span>
      <span className="plan-mode-banner-message">{t(MODE_DESC_KEY[mode])}</span>
      {onRequestExit && (
        <button
          type="button"
          className="plan-mode-banner-exit"
          onClick={onRequestExit}
          aria-label={t('planMode.requestExit')}
        >
          {t('planMode.requestExit')}
        </button>
      )}
    </div>
  );
}

export default PlanModeBanner;