"use client";

import { useEffect, useState } from "react";
import { WarningIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Modal } from "@/components/ui/page";
import { useTranslation } from "@/hooks/useTranslation";
import { cn } from "@/lib/utils";
import type { MCPServerConfig } from "@/types";

interface MCPSettingsDialogProps {
  server: MCPServerConfig | null;
  onClose: () => void;
  onSave: (server: MCPServerConfig) => void;
}

export function MCPSettingsDialog({
  server,
  onClose,
  onSave,
}: MCPSettingsDialogProps) {
  const { t } = useTranslation();
  const [jsonText, setJsonText] = useState("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (server) {
      setJsonText(JSON.stringify(server, null, 2));
      setError(null);
    }
  }, [server]);

  if (!server) return null;

  const handleSave = () => {
    try {
      const parsed = JSON.parse(jsonText) as unknown;
      if (!parsed || typeof parsed !== "object") {
        setError(t("extensions.mcp.settings.invalidObject"));
        return;
      }
      const config = parsed as Record<string, unknown>;
      if (typeof config.name !== "string" || config.name.length === 0) {
        setError(t("extensions.mcp.settings.nameRequired"));
        return;
      }
      if (typeof config.command !== "string" || config.command.length === 0) {
        setError(t("extensions.mcp.settings.commandRequired"));
        return;
      }

      const normalized: MCPServerConfig = {
        name: config.name,
        command: config.command,
        args: Array.isArray(config.args)
          ? config.args.filter((a): a is string => typeof a === "string")
          : undefined,
        env:
          config.env && typeof config.env === "object" && !Array.isArray(config.env)
            ? Object.fromEntries(
                Object.entries(config.env).filter(([, v]) => typeof v === "string")
              )
            : undefined,
        enabled: config.enabled !== false,
      };

      onSave(normalized);
    } catch {
      setError(t("extensions.mcp.settings.invalidJson"));
    }
  };

  return (
    <Modal
      open={!!server}
      onClose={onClose}
      title={t("extensions.mcp.settings.title", { name: server.name })}
      size="sm"
      footer={
        <>
          <Button variant="secondary" size="sm" onClick={onClose}>
            {t("extensions.mcp.settings.cancel")}
          </Button>
          <Button variant="primary" size="sm" onClick={handleSave}>
            {t("extensions.mcp.settings.save")}
          </Button>
        </>
      }
    >
      <p className="mb-2 text-xs text-muted-foreground">
        {t("extensions.mcp.settings.hint")}
      </p>
      <textarea
        value={jsonText}
        onChange={(e) => {
          setJsonText(e.target.value);
          if (error) setError(null);
        }}
        className={cn(
          "w-full h-80 resize-none rounded-lg border bg-[var(--surface)] p-3 font-mono text-xs text-foreground focus:outline-none focus:ring-2 focus:ring-accent/40",
          error ? "border-red-500/50" : "border-border/50"
        )}
        spellCheck={false}
      />
      {error && (
        <div className="mt-2 flex items-center gap-1.5 text-xs text-red-500">
          <WarningIcon size={14} />
          {error}
        </div>
      )}
    </Modal>
  );
}