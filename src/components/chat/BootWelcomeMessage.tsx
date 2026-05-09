"use client";

import { useTranslation } from "@/hooks/useTranslation";
import { FolderOpenIcon, CommandIcon, MessageCircleIcon } from "@/components/icons";

interface BootWelcomeMessageProps {
  onSelectProject?: () => void;
}

export function BootWelcomeMessage({ onSelectProject }: BootWelcomeMessageProps) {
  const { t } = useTranslation();

  return (
    <div className="flex justify-start px-4 mb-6">
      <div className="max-w-[80%] bg-[var(--bg-surface)] border border-[var(--border)] rounded-2xl rounded-bl-md px-5 py-4 shadow-sm">
        <div className="space-y-3">
          <p className="text-sm font-semibold" style={{ color: "var(--text)" }}>
            {t("bootWelcome.greeting")}
          </p>
          <p className="text-sm text-muted-foreground leading-relaxed">
            {t("bootWelcome.intro")}
          </p>

          <div className="space-y-2 pt-2 border-t border-[var(--border)]">
            <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
              {t("bootWelcome.quickActions")}
            </p>

            {onSelectProject && (
              <button
                onClick={onSelectProject}
                className="flex items-center gap-2 w-full px-3 py-2 rounded-lg text-left transition-colors hover:bg-[var(--chip)]"
              >
                <FolderOpenIcon size={16} className="text-[var(--accent)] shrink-0" />
                <span className="text-sm text-[var(--accent)]">{t("bootWelcome.actionSelectProject")}</span>
              </button>
            )}

            <div className="flex items-center gap-2 px-3 py-2 rounded-lg">
              <CommandIcon size={16} className="text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">{t("bootWelcome.actionTryHelp")}</span>
            </div>

            <div className="flex items-center gap-2 px-3 py-2 rounded-lg">
              <MessageCircleIcon size={16} className="text-muted-foreground shrink-0" />
              <span className="text-sm text-muted-foreground">{t("bootWelcome.actionStartChat")}</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}