"use client";

import { useTranslation } from "@/hooks/useTranslation";
import { CheckCircleIcon, SparkleIcon, ArrowRightIcon, CommandIcon, AtSignIcon, FileTextIcon, EraserIcon } from "@/components/icons";

interface CompleteStepProps {
  onEnter: () => void;
}

const SHORTCUTS = [
  { key: "/", icon: CommandIcon, descKey: "onboarding.shortcutCommands" as const },
  { key: "@", icon: AtSignIcon, descKey: "onboarding.shortcutMention" as const },
  { key: "Ctrl+E", icon: EraserIcon, descKey: "onboarding.shortcutClear" as const },
];

export function CompleteStep({ onEnter }: CompleteStepProps) {
  const { t } = useTranslation();

  return (
    <div className="flex flex-col items-center justify-center h-full text-center space-y-8">
      {/* Success animation */}
      <div className="relative">
        <div className="w-24 h-24 rounded-full bg-[var(--accent)]/10 flex items-center justify-center">
          <CheckCircleIcon size={48} className="text-[var(--accent)]" />
        </div>
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-24 h-24 rounded-full border-2 border-[var(--accent)]/20 animate-ping" />
        </div>
      </div>

      {/* Title */}
      <div className="space-y-2">
        <h2
          className="text-2xl font-bold"
          style={{
            color: "var(--text)",
            fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif",
          }}
        >
          {t("onboarding.completeTitle")}
        </h2>
        <p className="text-base text-muted-foreground max-w-sm mx-auto">
          {t("onboarding.completeDesc")}
        </p>
      </div>

      {/* Shortcuts */}
      <div className="w-full max-w-sm">
        <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide mb-4">
          {t("onboarding.shortcutsTitle")}
        </h3>
        <div className="space-y-2">
          {SHORTCUTS.map((shortcut) => (
            <div
              key={shortcut.key}
              className="flex items-center gap-3 p-3 rounded-xl bg-[var(--chip)]/50 border border-[var(--border)]"
            >
              <div className="w-8 h-8 rounded-lg bg-[var(--accent)]/10 flex items-center justify-center shrink-0">
                <shortcut.icon size={16} className="text-[var(--accent)]" />
              </div>
              <div className="flex-1 text-left">
                <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
                  {t(shortcut.descKey)}
                </span>
              </div>
              <kbd className="px-2 py-1 rounded bg-[var(--bg-input)] border border-[var(--border)] text-xs font-mono text-muted-foreground">
                {shortcut.key}
              </kbd>
            </div>
          ))}
        </div>
      </div>

      {/* CTA Button */}
      <button
        onClick={onEnter}
        className="inline-flex items-center gap-2 px-8 py-3 bg-[var(--accent)] text-white rounded-xl text-base font-medium hover:opacity-90 transition-all shadow-lg shadow-[var(--accent)]/20"
      >
        <SparkleIcon size={20} />
        {t("onboarding.enterDuya")}
        <ArrowRightIcon size={18} />
      </button>
    </div>
  );
}
