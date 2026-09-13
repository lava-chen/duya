"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import {
  FolderOpenIcon,
  PlusIcon,
  XIcon,
  FolderIcon,
  StarIcon,
  BookOpenIcon,
  NotePencilIcon,
  PencilIcon,
  CodeIcon,
  TerminalIcon,
  DatabaseIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  ChartLineIcon,
  ChatCircleIcon,
  CubeIcon,
  CpuIcon,
  GearSixIcon,
  KeyIcon,
  CloudIcon,
  MonitorIcon,
  ClockIcon,
  SparkleIcon,
  LightningIcon,
  PaperPlaneRightIcon,
  HouseIcon,
} from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Modal } from "@/components/ui/page";
import { useTranslation } from "@/hooks/useTranslation";

/**
 * CreateProjectDialog — Plan 471 v7, reworked for Plan 525 multi-path
 * projects (2026-09-13).
 *
 *   ┌──────────────────────────────────────────┐
 *   │ 创建项目                             ✕  │
 *   │ ┌───┬──────────────────────────────────┐ │
 *   │ │ 🗂 │ 项目名称                          │ │   ← avatar button opens the picker
 *   │ └───┴──────────────────────────────────┘ │
 *   │ 源文件夹                                  │
 *   │ ┌──────────────────────────────────────┐ │
 *   │ │ 🗀 duya                           ✕ │ │   ← one row per path, removable
 *   │ │ 🗀 duya-website                   ✕ │ │
 *   │ │ 🗀+ 添加文件夹                        │ │   ← always-available add row
 *   │ └──────────────────────────────────────┘ │
 *   │                        取消  创建项目     │
 *   └──────────────────────────────────────────┘
 *
 * Confirm semantics (Plan 525): the dialog returns name + paths[] +
 * avatar (icon/color). The parent creates the project ENTITY via
 * `projects.register` (paths land in `projects.paths`, migration 0012;
 * icon/color in migration 0013) and opens a thread bound to paths[0].
 */

/** Avatar accent palette — keywords stored on `projects.color` (migration 0013). */
export const PROJECT_COLOR_PALETTE: Array<{ key: string; hex: string }> = [
  { key: "zinc", hex: "#52525b" },
  { key: "red", hex: "#ef4444" },
  { key: "orange", hex: "#f97316" },
  { key: "yellow", hex: "#eab308" },
  { key: "green", hex: "#22c55e" },
  { key: "blue", hex: "#3b82f6" },
  { key: "purple", hex: "#a855f7" },
  { key: "pink", hex: "#ec4899" },
];

/** Icon registry — `projects.icon` stores the component name (migration 0013). */
export const PROJECT_ICON_REGISTRY: Record<string, React.ComponentType<{ size?: number | string; style?: React.CSSProperties }>> = {
  FolderIcon,
  FolderOpenIcon,
  StarIcon,
  BookOpenIcon,
  NotePencilIcon,
  PencilIcon,
  CodeIcon,
  TerminalIcon,
  DatabaseIcon,
  GlobeIcon,
  MagnifyingGlassIcon,
  ChartLineIcon,
  ChatCircleIcon,
  CubeIcon,
  CpuIcon,
  GearSixIcon,
  KeyIcon,
  CloudIcon,
  MonitorIcon,
  ClockIcon,
  SparkleIcon,
  LightningIcon,
  PaperPlaneRightIcon,
  HouseIcon,
};

const DEFAULT_PROJECT_ICON = "FolderIcon";

export function projectColorHex(color: string | null | undefined): string {
  return PROJECT_COLOR_PALETTE.find((c) => c.key === color)?.hex ?? PROJECT_COLOR_PALETTE[0].hex;
}

export interface CreateProjectDialogSubmit {
  name: string;
  paths: string[];
  icon: string | null;
  color: string | null;
}

/** Prefill for edit mode (ProjectsView "编辑项目"). */
export interface CreateProjectDialogInitial {
  name?: string;
  paths?: string[];
  icon?: string | null;
  color?: string | null;
}

export interface CreateProjectDialogProps {
  isOpen: boolean;
  onCancel: () => void;
  /** Called when the user confirms; the parent creates the project entity + thread. */
  onConfirm: (input: CreateProjectDialogSubmit) => void;
  /** 'edit' prefills from `initial` and relabels the dialog for updates. */
  mode?: "create" | "edit";
  initial?: CreateProjectDialogInitial;
}

function basename(p: string): string {
  return p.split(/[\\/]/).filter(Boolean).slice(-1)[0] ?? p;
}

export function CreateProjectDialog({ isOpen, onCancel, onConfirm, mode = "create", initial }: CreateProjectDialogProps) {
  const { t } = useTranslation();
  const [name, setName] = useState("");
  const [paths, setPaths] = useState<string[]>([]);
  const [icon, setIcon] = useState<string | null>(DEFAULT_PROJECT_ICON);
  const [color, setColor] = useState<string | null>(null);
  const [pickingFolder, setPickingFolder] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const pickerRef = useRef<HTMLDivElement | null>(null);

  // Reset state every time the dialog opens, then focus the name field.
  // Edit mode prefills from `initial` (paths/icon/color fall back to the
  // create defaults so the picker still works untouched).
  useEffect(() => {
    if (isOpen) {
      setName(mode === "edit" ? initial?.name ?? "" : "");
      setPaths(mode === "edit" ? [...(initial?.paths ?? [])] : []);
      setIcon(mode === "edit" ? initial?.icon ?? DEFAULT_PROJECT_ICON : DEFAULT_PROJECT_ICON);
      setColor(mode === "edit" ? initial?.color ?? null : null);
      setPickerOpen(false);
      setTimeout(() => inputRef.current?.focus(), 80);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }
  }, [isOpen, mode, initial]);
  // `initial` is an object literal from the parent; identity changes would
  // reset mid-edit, so only reopen-driven props are intentional deps.

  // Close the avatar picker on outside mousedown. The popover lives
  // inside the modal DOM (no portal), so a contained-ref check is
  // enough; listening on mousedown matches the dismiss-before-click
  // ordering that real browsers produce.
  useEffect(() => {
    if (!pickerOpen) return;
    const handleMouseDown = (e: MouseEvent) => {
      if (pickerRef.current && !pickerRef.current.contains(e.target as Node)) {
        setPickerOpen(false);
      }
    };
    document.addEventListener("mousedown", handleMouseDown);
    return () => document.removeEventListener("mousedown", handleMouseDown);
  }, [pickerOpen]);

  const addFolder = useCallback(async () => {
    if (pickingFolder) return;
    setPickingFolder(true);
    try {
      const api = window.electronAPI?.dialog;
      if (!api?.openFolder) {
        console.warn("[CreateProjectDialog] electronAPI.dialog.openFolder is unavailable");
        return;
      }
      const result = await api.openFolder({ title: t("project.selectNewProjectFolder") });
      if (!result.canceled) {
        setPaths((prev) => {
          const next: string[] = [];
          for (const p of [...prev, ...result.filePaths]) {
            if (!next.includes(p)) next.push(p);
          }
          return next;
        });
        // Prefill the name from the first folder while it's still empty.
        if (!name.trim() && result.filePaths.length > 0) {
          setName(basename(result.filePaths[0]));
        }
      }
    } catch (err) {
      console.error("[CreateProjectDialog] openFolder failed", err);
    } finally {
      setPickingFolder(false);
    }
  }, [pickingFolder, name, t]);

  const removePath = (p: string) => {
    setPaths((prev) => prev.filter((x) => x !== p));
  };

  const handleConfirm = () => {
    const trimmedName = name.trim();
    const finalName = trimmedName || (paths[0] ? basename(paths[0]) : "");
    if (!finalName) return;
    onConfirm({ name: finalName, paths, icon, color });
  };

  const canSubmit = mode === "edit" ? name.trim().length > 0 && paths.length > 0 : name.trim().length > 0 || paths.length > 0;

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !pickingFolder) {
      handleConfirm();
    }
  };

  const AvatarIcon = PROJECT_ICON_REGISTRY[icon ?? DEFAULT_PROJECT_ICON] ?? FolderIcon;
  const avatarHex = projectColorHex(color);

  return (
    <Modal
      open={isOpen}
      onClose={onCancel}
      title={mode === "edit" ? t("projects.editProject") : t("project.createProject")}
      size="sm"
      footer={
        <>
          <Button onClick={onCancel} variant="ghost" size="md">
            {t("common.cancel")}
          </Button>
          <Button onClick={handleConfirm} variant="primary" size="md" disabled={!canSubmit}>
            {mode === "edit" ? t("common.save") : t("project.createProject")}
          </Button>
        </>
      }
    >
      {/* Project name — the leading folder glyph doubles as the avatar
          picker trigger (icon + color, migration 0013 columns). */}
      <div className="relative mb-4" ref={pickerRef}>
        <div
          className="flex items-center gap-2 rounded-lg px-3 py-2"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px solid var(--border)",
          }}
        >
          <button
            type="button"
            onClick={() => setPickerOpen((v) => !v)}
            title={t("project.avatarDone")}
            className="flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
            style={{ width: 24, height: 24, flexShrink: 0, color: avatarHex }}
          >
            <AvatarIcon size={16} />
          </button>
          <Input
            ref={inputRef}
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={t("project.nameProjectPlaceholder")}
            className="border-0 bg-transparent p-0 shadow-none focus-visible:ring-0 flex-1"
            style={{ height: "auto", padding: 0 }}
          />
        </div>

        {pickerOpen && (
          <div
            className="absolute left-0 top-full z-50 mt-2 rounded-xl p-4"
            style={{
              width: 280,
              backgroundColor: "var(--surface)",
              border: "1px solid var(--border)",
              boxShadow: "0 12px 32px rgba(0,0,0,0.18)",
            }}
          >
            <div className="flex flex-wrap gap-3 mb-3">
              {PROJECT_COLOR_PALETTE.map((c) => {
                const selected = (color ?? PROJECT_COLOR_PALETTE[0].key) === c.key;
                return (
                  <button
                    key={c.key}
                    type="button"
                    onClick={() => setColor(c.key === PROJECT_COLOR_PALETTE[0].key ? null : c.key)}
                    className="rounded-full transition-transform hover:scale-110"
                    style={{
                      width: 22,
                      height: 22,
                      backgroundColor: c.hex,
                      outline: selected ? "2px solid var(--text)" : "none",
                      outlineOffset: 2,
                    }}
                    aria-label={c.key}
                  />
                );
              })}
            </div>
            <div
              className="grid grid-cols-6 gap-1 pt-3 mb-2"
              style={{ borderTop: "1px solid var(--border)" }}
            >
              {Object.entries(PROJECT_ICON_REGISTRY).map(([iconName, IconComp]) => {
                const selected = (icon ?? DEFAULT_PROJECT_ICON) === iconName;
                return (
                  <button
                    key={iconName}
                    type="button"
                    onClick={() => setIcon(iconName)}
                    className="flex items-center justify-center rounded-md transition-colors hover:bg-[var(--surface-hover)]"
                    style={{
                      width: 36,
                      height: 36,
                      color: selected ? avatarHex : "var(--muted)",
                      backgroundColor: selected ? "var(--surface-hover)" : "transparent",
                    }}
                    aria-label={iconName}
                  >
                    <IconComp size={18} />
                  </button>
                );
              })}
            </div>
            <div className="flex justify-end">
              <Button variant="ghost" size="sm" onClick={() => setPickerOpen(false)}>
                {t("project.avatarDone")}
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="text-sm font-medium mb-2" style={{ color: "var(--text)" }}>
        {t("project.sourceFolder")}
      </div>

      {paths.length === 0 ? (
        <button
          type="button"
          onClick={addFolder}
          disabled={pickingFolder}
          className="w-full flex flex-col items-center justify-center gap-2 rounded-lg py-6 transition-colors disabled:opacity-60"
          style={{
            backgroundColor: "var(--surface)",
            border: "1px dashed var(--border)",
            color: "var(--muted)",
            minHeight: 96,
          }}
        >
          <PlusIcon size={18} />
          <span className="text-sm">{t("project.addLocalFolder")}</span>
        </button>
      ) : (
        <div
          className="rounded-lg overflow-hidden mb-2"
          style={{ backgroundColor: "var(--surface)", border: "1px solid var(--border)" }}
        >
          {paths.map((p, idx) => (
            <div
              key={p}
              className="flex items-center gap-2 px-3 py-2.5"
              style={{ borderTop: idx === 0 ? "none" : "1px solid var(--border)" }}
            >
              <FolderOpenIcon size={16} style={{ color: "var(--muted)", flexShrink: 0 }} />
              <span
                className="flex-1 truncate text-sm"
                style={{ color: "var(--text)" }}
                title={p}
              >
                {basename(p)}
              </span>
              <button
                type="button"
                onClick={() => removePath(p)}
                title={t("project.removeFolder")}
                className="flex items-center justify-center rounded transition-colors hover:bg-[var(--surface-hover)]"
                style={{ width: 20, height: 20, color: "var(--muted)", flexShrink: 0 }}
              >
                <XIcon size={12} />
              </button>
            </div>
          ))}
          <button
            type="button"
            onClick={addFolder}
            disabled={pickingFolder}
            className="w-full flex items-center gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[var(--surface-hover)] disabled:opacity-60"
            style={{ borderTop: "1px solid var(--border)", color: "var(--muted)" }}
          >
            <FolderOpenIcon size={16} style={{ flexShrink: 0 }} />
            <span className="text-sm">{t("project.addFolder")}</span>
          </button>
        </div>
      )}
    </Modal>
  );
}
