"use client";

import { useTranslation } from "@/hooks/useTranslation";
import { ArrowRightIcon } from "@/components/icons";
import type { Locale } from "@/i18n";

interface WelcomeStepProps {
  onStart: () => void;
  locale: Locale;
  onSetLocale: (locale: Locale) => void;
}

export function WelcomeStep({ onStart, locale, onSetLocale }: WelcomeStepProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-full text-center space-y-8">
      {/* Language toggle */}
      <div className="flex items-center gap-1 p-1 rounded-lg bg-[var(--chip)] border border-[var(--border)]">
        <button
          onClick={() => onSetLocale("en")}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            locale === "en"
              ? "bg-[var(--bg-surface)] text-[var(--text)] shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          English
        </button>
        <button
          onClick={() => onSetLocale("zh")}
          className={`px-3 py-1.5 text-xs font-medium rounded-md transition-all ${
            locale === "zh"
              ? "bg-[var(--bg-surface)] text-[var(--text)] shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          }`}
        >
          中文
        </button>
      </div>

      {/* Hero section */}
      <div className="space-y-4">
        <div className="inline-flex items-center justify-center w-24 h-24 rounded-2xl overflow-hidden">
          <img
            src="/icon.png"
            alt="DUYA"
            className="w-full h-full object-cover"
          />
        </div>
        <div className="flex items-center justify-center gap-3">
          <h1
            className="text-3xl font-bold"
            style={{
              color: "var(--text)",
              fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif",
            }}
          >
            {t("onboarding.welcomeTitle")}
          </h1>
          <span
            className="px-2 py-0.5 text-xs font-semibold rounded-md"
            style={{
              background: 'var(--accent)',
              color: 'white',
              letterSpacing: '0.5px',
            }}
          >
            BETA
          </span>
        </div>
        <p className="text-base text-muted-foreground max-w-sm mx-auto leading-relaxed">
          {t("onboarding.welcomeDesc")}
        </p>
      </div>

      {/* Start button */}
      <button
        onClick={onStart}
        className="inline-flex items-center gap-2 px-8 py-3 bg-[var(--accent)] text-white rounded-xl text-base font-medium hover:opacity-90 transition-all shadow-lg shadow-[var(--accent)]/20"
      >
        {t("onboarding.getStarted")}
        <ArrowRightIcon size={18} />
      </button>
    </div>
  );
}