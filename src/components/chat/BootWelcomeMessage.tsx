"use client";

import { useTranslation } from "@/hooks/useTranslation";
import { FolderOpenIcon, CommandIcon, MessageCircleIcon } from "@/components/icons";

interface BootWelcomeMessageProps {
  onSelectProject?: () => void;
}

export function BootWelcomeMessage({ onSelectProject }: BootWelcomeMessageProps) {
  const { t } = useTranslation();

  return (
    <div className="flex justify-center mb-8">
      <div className="w-full max-w-[600px] text-center">
        <div className="space-y-4">
          <div className="space-y-2">
            <p className="text-base font-semibold" style={{ color: "var(--text)" }}>
              {t("bootWelcome.greeting")}
            </p>
            <p className="text-sm text-muted-foreground leading-relaxed">
              {t("bootWelcome.intro")}
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-center gap-2">
            {onSelectProject && (
              <button
                onClick={onSelectProject}
                className="flex items-center gap-2 px-4 py-2 rounded-full text-sm transition-colors bg-[var(--chip)] hover:bg-[var(--border)] text-[var(--accent)]"
              >
                <FolderOpenIcon size={14} className="shrink-0" />
                <span>{t("bootWelcome.actionSelectProject")}</span>
              </button>
            )}

            <div className="flex items-center gap-2 px-4 py-2 rounded-full text-sm bg-[var(--bg-surface)] text-muted-foreground border border-[var(--border)]">
              <CommandIcon size={14} className="shrink-0" />
              <span>{t("bootWelcome.actionTryHelp")}</span>
            </div>

            <div className="flex items-center gap-2 px-4 py-2 rounded-full text-sm bg-[var(--bg-surface)] text-muted-foreground border border-[var(--border)]">
              <MessageCircleIcon size={14} className="shrink-0" />
              <span>{t("bootWelcome.actionStartChat")}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}