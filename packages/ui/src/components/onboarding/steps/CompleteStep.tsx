"use client";

import { useTranslation } from "@/hooks/useTranslation";
import { CheckCircleIcon, CommandIcon, AtSignIcon, EraserIcon, SparkleIcon, ArrowRightIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";

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
    <div className="flex h-full min-h-0 flex-col items-center text-center">
      <div className="flex min-h-0 w-full flex-1 flex-col items-center justify-center space-y-3 overflow-y-auto px-1 py-1">
        {/* Success animation */}
        <div className="relative shrink-0">
          <div className="flex h-20 w-20 items-center justify-center rounded-full bg-[var(--accent)]/10">
            <CheckCircleIcon size={40} className="text-[var(--accent)]" />
          </div>
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="h-20 w-20 rounded-full border-2 border-[var(--accent)]/20 animate-ping" />
          </div>
        </div>

        {/* Title */}
        <div className="space-y-1 shrink-0">
          <h2
            className="text-2xl font-bold"
            style={{
              color: "var(--text)",
              fontFamily: "'Copernicus', Georgia, 'Times New Roman', serif",
            }}
          >
            {t("onboarding.completeTitle")}
          </h2>
          <p className="mx-auto max-w-sm text-sm text-muted-foreground">
            {t("onboarding.completeDesc")}
          </p>
        </div>

        {/* Shortcuts */}
        <div className="w-full max-w-sm shrink-0">
          <h3 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {t("onboarding.shortcutsTitle")}
          </h3>
          <div className="space-y-1.5">
            {SHORTCUTS.map((shortcut) => (
              <div
                key={shortcut.key}
                className="flex items-center gap-3 rounded-xl border border-white/10 bg-[var(--chip)]/60 p-2.5 backdrop-blur-xl"
              >
                <div className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-[var(--accent)]/10">
                  <shortcut.icon size={15} className="text-[var(--accent)]" />
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <span className="text-sm font-medium" style={{ color: "var(--text)" }}>
                    {t(shortcut.descKey)}
                  </span>
                </div>
                <kbd className="rounded border border-[var(--border)] bg-[var(--bg-input)] px-2 py-1 font-mono text-[11px] text-muted-foreground">
                  {shortcut.key}
                </kbd>
              </div>
            ))}
          </div>
        </div>
      </div>

      <Button
        variant="primary"
        size="md"
        onClick={onEnter}
        className="mt-1 shrink-0 rounded-xl shadow-lg shadow-[var(--accent)]/20"
      >
        <SparkleIcon size={18} />
        {t("onboarding.enterDuya")}
        <ArrowRightIcon size={16} />
      </Button>
    </div>
  );
}
