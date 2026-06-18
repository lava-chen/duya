"use client";

import { useEffect, useRef, useState } from "react";
import { GearSix, X, Eye, Lightning, ShieldWarning, Check } from "@phosphor-icons/react";
import { useConductorStore } from "../stores/conductor-store";
import type { ModelOption } from "../host";

/**
 * Conductor settings popover.
 *
 * Surfaces conductor-specific runtime knobs that are persisted via
 * the host's settings store:
 *
 *   - Primary model (`conductor.model`) — the LLM that drives canvas
 *     tool calls. Reuses the same model list as the composer.
 *   - Vision model (`conductor.visionModel`) — the model used when
 *     the agent captures a canvas screenshot and needs to reason
 *     about pixels. Filtered to models that advertise vision support.
 *   - Permission mode (`conductor.permissionMode`) — how aggressive
 *     the agent is about executing destructive actions without
 *     asking first.
 *
 * The popover is anchored to the status bar gear button. It closes
 * on outside click or Escape.
 */
export function ConductorSettings() {
  const open = useConductorStore((s) => s.conductorSettingsOpen);
  const setOpen = useConductorStore((s) => s.setConductorSettingsOpen);
  const loading = useConductorStore((s) => s.conductorSettingsLoading);

  const conductorModels = useConductorStore((s) => s.conductorModels);
  const conductorModel = useConductorStore((s) => s.conductorModel);
  const setConductorModel = useConductorStore((s) => s.setConductorModel);

  const visionModel = useConductorStore((s) => s.conductorVisionModel);
  const setConductorVisionModel = useConductorStore((s) => s.setConductorVisionModel);

  const permissionMode = useConductorStore((s) => s.conductorPermissionMode);
  const setConductorPermissionMode = useConductorStore((s) => s.setConductorPermissionMode);

  if (!open) return null;

  // Heuristic: a model "supports vision" if its id or display name
  // mentions one of the common vision-capable model families. This
  // is intentionally permissive — false positives just mean the user
  // can pick a model that may not actually accept images, which the
  // agent will surface as a tool error. False negatives (a vision
  // model not in the list) are worse: the user cannot pick it at
  // all. So we lean toward inclusion.
  const VISION_KEYWORDS = [
    "gpt-4o", "gpt-4-vision", "gpt-4.1", "gpt-5",
    "claude-3", "claude-4", "claude-opus", "claude-sonnet", "claude-haiku",
    "gemini", "gemma-3", "llava", "qwen-vl", "qwen2-vl", "qwen2.5-vl",
    "internvl", "cogvlm", "pixtral", "mistral-small-vision",
  ];
  const visionModels: ModelOption[] = conductorModels.filter((m) => {
    const haystack = `${m.id} ${m.display_name}`.toLowerCase();
    return VISION_KEYWORDS.some((kw) => haystack.includes(kw));
  });

  return (
    <SettingsPopover onClose={() => setOpen(false)} loading={loading}>
      <SettingsRow
        label="Primary model"
        hint="LLM that drives canvas tool calls"
      >
        <ModelDropdown
          models={conductorModels}
          value={conductorModel}
          onChange={setConductorModel}
          placeholder="Use host default"
        />
      </SettingsRow>

      <SettingsRow
        label="Vision model"
        hint="Used when the agent captures the canvas for visual reasoning"
      >
        <ModelDropdown
          models={visionModels}
          value={visionModel}
          onChange={setConductorVisionModel}
          placeholder="Same as primary"
          emptyHint="No vision-capable models detected"
        />
      </SettingsRow>

      <SettingsRow
        label="Permission mode"
        hint="Controls how aggressive the agent is with destructive actions"
      >
        <PermissionModeSelector
          value={permissionMode}
          onChange={setConductorPermissionMode}
        />
      </SettingsRow>
    </SettingsPopover>
  );
}

// ---------------------------------------------------------------------------
// Popover shell
// ---------------------------------------------------------------------------

interface SettingsPopoverProps {
  onClose: () => void;
  loading: boolean;
  children: React.ReactNode;
}

function SettingsPopover({ onClose, loading, children }: SettingsPopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handlePointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.setTimeout(() => {
      document.addEventListener("mousedown", handlePointer);
      document.addEventListener("keydown", handleKey);
    }, 0);
    return () => {
      document.removeEventListener("mousedown", handlePointer);
      document.removeEventListener("keydown", handleKey);
    };
  }, [onClose]);

  return (
    <div
      ref={ref}
      className="conductor-popover"
      style={{
        position: "absolute",
        bottom: "calc(100% + 8px)",
        right: 0,
        width: 340,
        padding: 0,
        zIndex: 250,
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div
        className="flex items-center justify-between px-3.5 py-2.5 border-b"
        style={{ borderColor: "var(--conductor-border)" }}
      >
        <div className="flex items-center gap-2">
          <GearSix size={14} style={{ color: "var(--text-secondary)" }} />
          <span
            style={{
              color: "var(--text-primary)",
              fontSize: 13,
              fontWeight: 600,
            }}
          >
            Conductor settings
          </span>
        </div>
        <button
          type="button"
          onClick={onClose}
          className="flex items-center justify-center w-6 h-6 rounded-full transition-colors"
          style={{ color: "var(--text-tertiary)" }}
          onMouseEnter={(e) => {
            e.currentTarget.style.background = "var(--conductor-accent-soft)";
            e.currentTarget.style.color = "var(--text-primary)";
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.background = "transparent";
            e.currentTarget.style.color = "var(--text-tertiary)";
          }}
          aria-label="Close settings"
        >
          <X size={12} weight="bold" />
        </button>
      </div>

      <div className="py-1">
        {loading ? (
          <div
            className="px-3.5 py-6 text-center"
            style={{ color: "var(--text-tertiary)", fontSize: 12 }}
          >
            Loading settings…
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

interface SettingsRowProps {
  label: string;
  hint?: string;
  children: React.ReactNode;
}

function SettingsRow({ label, hint, children }: SettingsRowProps) {
  return (
    <div
      className="px-3.5 py-2.5"
      style={{ borderBottom: "1px solid var(--conductor-border)" }}
    >
      <div className="flex items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div
            style={{
              color: "var(--text-primary)",
              fontSize: 12,
              fontWeight: 500,
            }}
          >
            {label}
          </div>
          {hint && (
            <div
              className="mt-0.5 leading-snug"
              style={{
                color: "var(--text-tertiary)",
                fontSize: 11,
              }}
            >
              {hint}
            </div>
          )}
        </div>
        <div className="flex-shrink-0 max-w-[180px]">{children}</div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model dropdown
// ---------------------------------------------------------------------------

interface ModelDropdownProps {
  models: ModelOption[];
  value: string;
  onChange: (modelId: string) => void;
  placeholder: string;
  emptyHint?: string;
}

function ModelDropdown({
  models,
  value,
  onChange,
  placeholder,
  emptyHint,
}: ModelDropdownProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.setTimeout(() => document.addEventListener("mousedown", handler), 0);
    return () => document.removeEventListener("mousedown", handler);
  }, [open]);

  const selected = models.find((m) => m.id === value);
  const label = selected?.display_name || (value ? value : placeholder);

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((p) => !p)}
        className="w-full flex items-center justify-between gap-2 px-2.5 py-1.5 rounded-md transition-colors"
        style={{
          background: "var(--conductor-accent-soft)",
          border: "1px solid var(--conductor-border)",
          color: "var(--text-primary)",
          fontSize: 11,
        }}
      >
        <span className="truncate">{label}</span>
      </button>

      {open && (
        <div
          className="conductor-popover"
          style={{
            position: "absolute",
            bottom: "calc(100% + 4px)",
            right: 0,
            minWidth: 220,
            maxHeight: 260,
            padding: 4,
            zIndex: 260,
            overflow: "hidden",
          }}
        >
          <div className="overflow-y-auto scrollbar-thin" style={{ maxHeight: 220 }}>
            {/* Clear option */}
            <button
              type="button"
              onClick={() => {
                onChange("");
                setOpen(false);
              }}
              className="conductor-popover-item"
              style={{
                fontSize: 12,
                background: !value ? "var(--conductor-accent-soft)" : "transparent",
              }}
            >
              <span className="flex-1 truncate" style={{ color: "var(--text-tertiary)" }}>
                {placeholder}
              </span>
              {!value && <Check size={12} style={{ color: "var(--conductor-accent)" }} />}
            </button>

            {models.length === 0 ? (
              <div
                className="px-3 py-2 text-center"
                style={{ color: "var(--text-tertiary)", fontSize: 11 }}
              >
                {emptyHint || "No models available"}
              </div>
            ) : (
              models.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  onClick={() => {
                    onChange(m.id);
                    setOpen(false);
                  }}
                  className="conductor-popover-item"
                  style={{
                    fontSize: 12,
                    background: m.id === value ? "var(--conductor-accent-soft)" : "transparent",
                  }}
                >
                  <span className="flex-1 min-w-0">
                    <span className="block truncate" style={{ color: "var(--text-primary)" }}>
                      {m.display_name}
                    </span>
                    <span
                      className="block truncate"
                      style={{
                        color: "var(--text-tertiary)",
                        fontSize: 10,
                        fontFamily: "'Fira Mono', monospace",
                      }}
                    >
                      {m.id}
                    </span>
                  </span>
                  {m.id === value && (
                    <Check size={12} style={{ color: "var(--conductor-accent)" }} />
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Permission mode selector
// ---------------------------------------------------------------------------

type PermissionMode = "default" | "auto" | "bypass";

const PERMISSION_MODES: Array<{
  id: PermissionMode;
  label: string;
  icon: typeof Eye;
  description: string;
}> = [
  {
    id: "default",
    label: "Ask",
    icon: Eye,
    description: "Confirm before destructive actions (delete, arrange, clear)",
  },
  {
    id: "auto",
    label: "Auto",
    icon: Lightning,
    description: "Execute non-destructive actions automatically; ask for destructive ones",
  },
  {
    id: "bypass",
    label: "Bypass",
    icon: ShieldWarning,
    description: "Execute everything without asking. Fast but risky.",
  },
];

interface PermissionModeSelectorProps {
  value: PermissionMode;
  onChange: (mode: PermissionMode) => void;
}

function PermissionModeSelector({ value, onChange }: PermissionModeSelectorProps) {
  return (
    <div className="flex flex-col gap-1 w-full">
      {PERMISSION_MODES.map((mode) => {
        const Icon = mode.icon;
        const isActive = mode.id === value;
        return (
          <button
            key={mode.id}
            type="button"
            onClick={() => onChange(mode.id)}
            className="flex items-start gap-2 px-2.5 py-1.5 rounded-md transition-colors text-left w-full"
            style={{
              background: isActive ? "var(--conductor-accent-soft)" : "transparent",
              border: isActive
                ? "1px solid var(--conductor-accent)"
                : "1px solid transparent",
            }}
            onMouseEnter={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = "var(--surface-hover)";
              }
            }}
            onMouseLeave={(e) => {
              if (!isActive) {
                e.currentTarget.style.background = "transparent";
              }
            }}
          >
            <Icon
              size={12}
              weight={isActive ? "fill" : "regular"}
              style={{
                color: isActive ? "var(--conductor-accent)" : "var(--text-secondary)",
                marginTop: 1,
                flexShrink: 0,
              }}
            />
            <div className="flex-1 min-w-0">
              <div
                style={{
                  color: isActive ? "var(--conductor-accent)" : "var(--text-primary)",
                  fontSize: 11,
                  fontWeight: 600,
                }}
              >
                {mode.label}
              </div>
              <div
                className="mt-0.5 leading-snug"
                style={{
                  color: "var(--text-tertiary)",
                  fontSize: 10,
                }}
              >
                {mode.description}
              </div>
            </div>
          </button>
        );
      })}
    </div>
  );
}
