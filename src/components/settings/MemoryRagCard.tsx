"use client";

/**
 * src/components/settings/MemoryRagCard.tsx
 *
 * Memory RAG (retrievable memory) configuration card (plan 432). Lives
 * inside the Memory settings section and drives `[memory.rag]` in
 * `~/.duya/config.toml` through the config MessagePort (`memoryRag` flat
 * key → `memory.rag`).
 *
 * Controls:
 *   - enabled toggle — master switch for retrieval.
 *   - scan_paths — add/remove row list of extra scan directories.
 *   - index_path — index sqlite path (empty = default).
 *   - embedding_provider — provider picker (empty = memory provider).
 *   - embedding_model — model picker (empty = memory model).
 *   - embedding_enabled — vector embeddings toggle (off = keyword only).
 */

import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "@/hooks/useTranslation";
import { useProvidersQuery } from "@/lib/providers/hooks/useProvidersQuery";
import { getConfigValue, setConfig } from "@/lib/config-port-bus";
import { ragRebuildMemoryIPC } from "@/lib/ipc-client";
import { Button } from "@/components/ui/Button";
import {
  SettingsCard,
  SettingsRow,
  SettingsToggle,
  SettingsSelectRow,
  SettingsInputRow,
} from "@/components/settings/ui";

export interface MemoryRagConfig {
  enabled: boolean;
  index_path: string;
  scan_paths: string[];
  embedding_enabled: boolean;
  embedding_provider: string;
  embedding_model: string;
}

const DEFAULT_RAG: MemoryRagConfig = {
  enabled: false,
  index_path: "",
  scan_paths: [],
  embedding_enabled: true,
  embedding_provider: "",
  embedding_model: "",
};

export function MemoryRagCard() {
  const { t } = useTranslation();
  const { data: providers = [] } = useProvidersQuery();

  const [rag, setRag] = useState<MemoryRagConfig | null>(null);
  const [newPath, setNewPath] = useState("");
  const [pathError, setPathError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const value = await getConfigValue("memoryRag");
      if (cancelled) return;
      setRag({ ...DEFAULT_RAG, ...((value as Partial<MemoryRagConfig>) ?? {}) });
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  /** Optimistic whole-object write through the config MessagePort. */
  const patchRag = (patch: Partial<MemoryRagConfig>) => {
    const next = { ...(rag ?? DEFAULT_RAG), ...patch };
    setRag(next);
    setConfig("memoryRag", next);
  };

  const disabled = rag === null || !rag.enabled;

  const [rebuildState, setRebuildState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [rebuildMessage, setRebuildMessage] = useState<string | null>(null);

  /** Rebuild the retrievable memory index on demand via IPC. */
  const handleRebuild = async () => {
    if (disabled || rebuildState === "running") return;
    setRebuildState("running");
    setRebuildMessage(null);
    const res = await ragRebuildMemoryIPC();
    if (res.ok) {
      setRebuildState("done");
      setRebuildMessage(
        t("settings.memory.ragRebuildDone", {
          documents: res.documents ?? 0,
          embedded: res.embedded ?? 0,
        }),
      );
    } else {
      setRebuildState("error");
      setRebuildMessage(res.error ?? t("settings.memory.ragRebuildFailed"));
    }
  };

  const providerOptions = useMemo(() => {
    const opts: { value: string; label: string }[] = [
      { value: "", label: t("settings.memory.ragProviderUseDefault") },
    ];
    for (const p of providers) {
      opts.push({ value: p.id, label: p.name });
    }
    return opts;
  }, [providers, t]);

  const handleAddPath = () => {
    const trimmed = newPath.trim();
    if (!trimmed) return;
    if ((rag?.scan_paths ?? []).includes(trimmed)) {
      setPathError(t("settings.memory.ragPathExists"));
      return;
    }
    patchRag({ scan_paths: [...(rag?.scan_paths ?? []), trimmed] });
    setNewPath("");
    setPathError(null);
  };

  const handleRemovePath = (p: string) => {
    patchRag({ scan_paths: (rag?.scan_paths ?? []).filter((x) => x !== p) });
  };

  const saveIndexPath = () => {
    if (!rag) return;
    // Patch unconditionally: onChange already updated the local state, so a
    // change-guard here would always short-circuit. Idempotent writes are
    // harmless (ConfigStore persists equal values as a no-op broadcast).
    patchRag({ index_path: rag.index_path.trim() });
  };

  const saveEmbeddingModel = () => {
    if (!rag) return;
    patchRag({ embedding_model: rag.embedding_model.trim() });
  };

  return (
    <SettingsCard>
      <SettingsToggle
        label={t("settings.memory.ragEnabled")}
        description={t("settings.memory.ragEnabledDesc")}
        checked={rag?.enabled ?? false}
        onCheckedChange={(checked) => patchRag({ enabled: checked })}
        disabled={rag === null}
      />

      <SettingsRow
        label={t("settings.memory.ragScanPaths")}
        description={t("settings.memory.ragScanPathsDesc")}
        disabled={disabled}
      >
        <div className="flex gap-2">
          <input
            type="text"
            value={newPath}
            onChange={(e) => {
              setNewPath(e.target.value);
              setPathError(null);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleAddPath();
            }}
            placeholder={t("settings.memory.ragAddPath")}
            disabled={disabled}
            className="w-[220px] px-3 py-1.5 rounded-md border text-sm bg-black/30 text-foreground placeholder:text-muted-foreground/60 border-border/30 focus:outline-none focus:ring-1 focus:ring-accent/50"
          />
          <Button
            variant="secondary"
            size="sm"
            onClick={handleAddPath}
            disabled={disabled}
          >
            {t("common.add")}
          </Button>
        </div>
      </SettingsRow>

      {pathError && (
        <p className="text-sm text-destructive pl-1 pb-1">{pathError}</p>
      )}

      <div className="px-1 pb-2 space-y-1">
        {(rag?.scan_paths ?? []).length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("settings.memory.ragEmpty")}</p>
        ) : (
          rag!.scan_paths.map((p) => (
            <div
              key={p}
              className="flex items-center justify-between gap-2 px-3 py-1.5 rounded-md bg-muted/40 text-sm"
            >
              <span className="min-w-0 flex-1 font-mono break-all">{p}</span>
              <button
                type="button"
                onClick={() => handleRemovePath(p)}
                disabled={disabled}
                className="text-muted-foreground hover:text-destructive text-xs shrink-0 disabled:opacity-40"
              >
                {t("common.remove")}
              </button>
            </div>
          ))
        )}
      </div>

      <SettingsInputRow
        label={t("settings.memory.ragIndexPath")}
        description={t("settings.memory.ragIndexPathDesc")}
        value={rag?.index_path ?? ""}
        onChange={(v) => setRag((prev) => (prev ? { ...prev, index_path: v } : prev))}
        onBlur={saveIndexPath}
        placeholder="~/.duya/rag/memory-rag.db"
        disabled={disabled}
      />

      <SettingsSelectRow
        label={t("settings.memory.ragProvider")}
        description={t("settings.memory.ragProviderDesc")}
        value={rag?.embedding_provider ?? ""}
        onValueChange={(value) => patchRag({ embedding_provider: value })}
        options={providerOptions}
        disabled={disabled}
      />

      <SettingsInputRow
        label={t("settings.memory.ragModel")}
        description={t("settings.memory.ragModelDesc")}
        value={rag?.embedding_model ?? ""}
        onChange={(v) => setRag((prev) => (prev ? { ...prev, embedding_model: v } : prev))}
        onBlur={saveEmbeddingModel}
        placeholder="bge-m3 / text-embedding-3-small"
        disabled={disabled}
      />

      <SettingsToggle
        label={t("settings.memory.ragEmbeddingEnabled")}
        description={t("settings.memory.ragEmbeddingEnabledDesc")}
        checked={rag?.embedding_enabled ?? true}
        onCheckedChange={(checked) => patchRag({ embedding_enabled: checked })}
        disabled={disabled}
      />

      <SettingsRow
        label={t("settings.memory.ragRebuild")}
        description={t("settings.memory.ragRebuildDesc")}
        disabled={disabled}
      >
        <Button
          variant="secondary"
          size="sm"
          onClick={() => void handleRebuild()}
          disabled={disabled || rebuildState === "running"}
        >
          {rebuildState === "running"
            ? t("settings.memory.ragRebuildRunning")
            : t("settings.memory.ragRebuild")}
        </Button>
      </SettingsRow>

      {rebuildMessage && (
        <p
          className={`px-1 pb-1 text-sm ${
            rebuildState === "error" ? "text-destructive" : "text-muted-foreground"
          }`}
        >
          {rebuildMessage}
        </p>
      )}
    </SettingsCard>
  );
}
