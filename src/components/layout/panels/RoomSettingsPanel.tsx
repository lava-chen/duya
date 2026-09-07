"use client";

/**
 * RoomSettingsPanel — right-panel page for a shared room (group chat).
 * Opened from the room chat header / sidebar row via
 * `openOrActivatePage("room-settings", { roomId, title })` — the same
 * entry pattern as `bot-settings` (plan 483).
 *
 * Single view, no sub-pages:
 *   - name + description: live-saved with a 600ms debounce (mirrors the
 *     `BotSettingsPanel` identity form; no save button).
 *   - members: bot-roster picker, immediate `groups.update` on toggle
 *     (patch semantics keep it from clobbering the debounced text saves).
 *   - delete: destructive action with confirm; afterwards the panel shows a
 *     "deleted" state.
 *
 * Every successful mutation dispatches `duya:room-identity-updated`
 * (chat header refreshes its meta) and `duya:rooms-changed` (sidebar
 * reloads the room list). Routine binding is a later iteration — the
 * section slot is intentionally left out for now.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { AutoResizeTextarea } from "../../ui/AutoResizeTextarea";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import { useTranslation } from "@/hooks/useTranslation";
import { listBots, type BotListItem } from "@/lib/agent-profile-ipc";
import { GROUP_MEMBER_MAX } from "@/lib/room-session";
import type { PageTab } from "./registry";

/** Narrow adapter: the panel only ever receives its own params shape. */
function roomIdFromParams(params: Record<string, unknown> | undefined): string | null {
  const value = params?.roomId;
  return typeof value === "string" && value.trim() ? value : null;
}

/** Room identity slice the panel edits (groups.get resolved shape). */
interface RoomIdentity {
  id: string;
  name: string;
  description: string;
  memberIds: string[];
}

function PanelNotice({ text }: { text: string }) {
  return (
    <div className="bot-settings-panel bot-settings-panel--notice">
      <p style={{ color: "var(--text-muted)", fontSize: 13, margin: 0 }}>{text}</p>
    </div>
  );
}

export function RoomSettingsPanel({ tab }: { tab: PageTab; embedded: boolean }) {
  const { t } = useTranslation();
  const roomId = roomIdFromParams(tab.params);
  const [room, setRoom] = useState<RoomIdentity | null>(null);
  const [allBots, setAllBots] = useState<BotListItem[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [deleted, setDeleted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busyRef = useRef(false);

  const notifyChanged = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("duya:room-identity-updated", { detail: { roomId } })
    );
    window.dispatchEvent(new CustomEvent("duya:rooms-changed", { detail: { roomId } }));
  }, [roomId]);

  const reload = useCallback(async () => {
    if (!roomId) {
      setRoom(null);
      return;
    }
    try {
      const [declared, bots] = await Promise.all([
        window.electronAPI?.groups?.get?.(roomId) ?? null,
        listBots(),
      ]);
      setAllBots(bots);
      if (!declared) {
        setRoom(null);
        return;
      }
      setRoom({
        id: declared.id,
        name: declared.name,
        description: declared.description ?? "",
        memberIds: declared.memberIds ?? [],
      });
      setName(declared.name);
      setDescription(declared.description ?? "");
      setSelected(declared.memberIds ?? []);
      setDeleted(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [roomId]);

  useEffect(() => {
    void reload();
  }, [reload]);

  // Live-save name/description (600ms debounce). Skipped while the fields
  // still mirror the loaded identity (seed echo) and while the name is
  // empty (groups.update requires one). Patch semantics mean a concurrent
  // member-toggle update never clobbers these.
  const [liveError, setLiveError] = useState<string | null>(null);
  useEffect(() => {
    if (!room || deleted) return;
    const unchanged = name === room.name && description === room.description;
    if (unchanged || !name.trim()) return;
    const timer = setTimeout(async () => {
      try {
        await window.electronAPI?.groups?.update?.(roomId!, { name: name.trim(), description: description.trim() });
        setRoom((prev) => (prev ? { ...prev, name: name.trim(), description: description.trim() } : prev));
        setLiveError(null);
        notifyChanged();
      } catch (err) {
        setLiveError(err instanceof Error ? err.message : String(err));
      }
    }, 600);
    return () => clearTimeout(timer);
  }, [room, deleted, name, description, roomId, notifyChanged]);

  const toggleMember = async (id: string) => {
    if (!room || deleted || busyRef.current) return;
    const isSelected = selected.includes(id);
    if (!isSelected && selected.length >= GROUP_MEMBER_MAX) return;
    const next = isSelected ? selected.filter((m) => m !== id) : [...selected, id];
    const prev = selected;
    setSelected(next);
    setBusy(true);
    busyRef.current = true;
    setError(null);
    try {
      await window.electronAPI?.groups?.update?.(roomId!, { memberIds: next });
      setRoom((prev) => (prev ? { ...prev, memberIds: next } : prev));
      notifyChanged();
    } catch (err) {
      setSelected(prev); // revert the optimistic toggle
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  };

  const handleDelete = async () => {
    if (!room || deleted) return;
    if (!window.confirm(t("room.settings.deleteConfirm", { name: room.name }))) return;
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI?.groups?.delete?.(roomId!);
      setDeleted(true);
      setRoom(null);
      notifyChanged();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (deleted) return <PanelNotice text={t("room.settings.deleted")} />;
  if (!roomId) return <PanelNotice text={t("room.settings.missing")} />;
  if (!room) return <PanelNotice text={t("room.settings.notFound")} />;

  return (
    <div className="bot-settings-panel">
      <div className="mb-1" style={{ color: "var(--text-muted)", fontSize: 13 }}>
        {t("room.settings.name")}
      </div>
      <Input
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder={t("room.settings.namePlaceholder")}
        className="w-full mb-3 h-11"
      />

      <div className="mb-1" style={{ color: "var(--text-muted)", fontSize: 13 }}>
        {t("room.settings.description")}
      </div>
      <AutoResizeTextarea
        value={description}
        onChange={setDescription}
        maxHeight={160}
        placeholder={t("room.settings.descriptionPlaceholder")}
        className="w-full mb-4 rounded-lg border px-3 py-2 text-sm resize-none focus:outline-none focus:ring-2 focus:ring-accent/50"
        style={{
          background: "var(--surface)",
          borderColor: "var(--border)",
          color: "var(--text)",
        }}
      />

      <div className="mb-1 flex items-center justify-between">
        <span style={{ color: "var(--text-muted)", fontSize: 13 }}>
          {t("room.settings.members")}
        </span>
        <span
          style={{
            color: selected.length >= GROUP_MEMBER_MAX ? "var(--accent-warning, #e9c46a)" : "var(--text-muted)",
            fontSize: 12,
          }}
        >
          {selected.length}/{GROUP_MEMBER_MAX}
        </span>
      </div>
      <div
        className="max-h-[280px] overflow-y-auto rounded-lg border mb-5"
        style={{ borderColor: "var(--border)", background: "var(--surface)" }}
      >
        {allBots.length === 0 && (
          <div className="px-3 py-6 text-center text-[13px]" style={{ color: "var(--text-muted)" }}>
            {t("room.settings.emptyMembers")}
          </div>
        )}
        {allBots.map((bot) => {
          const checked = selected.includes(bot.id);
          const disabled = busy || (!checked && selected.length >= GROUP_MEMBER_MAX);
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => void toggleMember(bot.id)}
              disabled={disabled}
              className={`flex w-full items-center gap-3 px-3 py-2 text-left disabled:opacity-40 ${
                checked ? "" : ""
              }`}
              style={checked ? { background: "var(--bg-hover)" } : undefined}
            >
              <BotCharacterAvatar
                name={bot.name}
                agentId={bot.id}
                avatarColor={bot.avatarColor}
                avatarUrl={bot.avatarUrl}
                size={32}
              />
              <span className="flex-1 truncate text-[13.5px]" style={{ color: "var(--text)" }}>
                {bot.name}
              </span>
              {checked && (
                <span className="text-[13px] font-semibold" style={{ color: "var(--accent, #7c9cff)" }} aria-hidden>
                  ✓
                </span>
              )}
            </button>
          );
        })}
      </div>

      {(error || liveError) && (
        <div className="text-sm mb-3" style={{ color: "var(--error, #ef4444)" }}>
          {error ?? liveError}
        </div>
      )}

      <div className="flex justify-end">
        <Button variant="ghost" disabled={busy} onClick={() => void handleDelete()}>
          {t("room.settings.delete")}
        </Button>
      </div>
    </div>
  );
}
