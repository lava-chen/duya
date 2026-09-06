"use client";

/**
 * GroupSettingsDialog — shared-room create/edit/delete (Plan 478 P3.2,
 * visual pattern from rakazo's GroupPanel: name field + member picker with
 * GROUP_MEMBER_MAX=6 enforcement).
 *
 *  - create mode: name + member picker → `groups.create` (id allocated
 *    main-side, returned and surfaced through onSaved).
 *  - edit mode: pre-filled name/members → `groups.update`, plus a
 *    destructive delete action (`groups.delete`).
 *
 * Members are chosen from the live bot roster (`listBots()`). Room identity
 * lives in `~/.duya/groups.toml` only — no session is created here; the
 * room transcript session materializes on first post / room:ensure.
 */

import React, { useEffect, useMemo, useState } from "react";
import { XIcon } from "@/components/icons";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { listBots, deleteConfigAgent } from "@/lib/agent-profile-ipc";
import { BotCharacterAvatar } from "@/components/layout/sidebar/BotCharacterAvatar";
import { useBotContacts } from "@/components/layout/sidebar/use-bot-contacts";

export const GROUP_MEMBER_MAX = 6;

export interface GroupSettingsDialogProps {
  isOpen: boolean;
  /** "create" builds a new room; "edit" updates/deletes `groupId`. */
  mode: "create" | "edit";
  groupId?: string;
  initialName?: string;
  initialMemberIds?: string[];
  onCancel: () => void;
  /** Called after a successful create/update (parent reloads rooms). */
  onSaved: (groupId: string) => void;
  /** Called after a successful delete (edit mode only). */
  onDeleted?: (groupId: string) => void;
}

interface PickerBot {
  id: string;
  name: string;
  avatarColor?: string;
  avatarUrl?: string;
}

export function GroupSettingsDialog({
  isOpen,
  mode,
  groupId,
  initialName = "",
  initialMemberIds = [],
  onCancel,
  onSaved,
  onDeleted,
}: GroupSettingsDialogProps) {
  const { allContacts } = useBotContacts();
  const [name, setName] = useState(initialName);
  const [selected, setSelected] = useState<string[]>(initialMemberIds);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setName(initialName);
    setSelected(initialMemberIds);
    setError(null);
  }, [isOpen, mode, groupId, initialName, initialMemberIds]);

  const bots: PickerBot[] = useMemo(
    () =>
      allContacts.map((contact) => ({
        id: contact.agentId,
        name: contact.name,
        avatarColor: contact.avatarColor,
        avatarUrl: contact.avatarUrl,
      })),
    [allContacts],
  );

  const canSubmit =
    !submitting && name.trim().length > 0 && selected.length >= 1 && selected.length <= GROUP_MEMBER_MAX;

  if (!isOpen) return null;

  const toggleMember = (id: string) => {
    setSelected((prev) => {
      if (prev.includes(id)) return prev.filter((m) => m !== id);
      if (prev.length >= GROUP_MEMBER_MAX) return prev;
      return [...prev, id];
    });
  };

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    setError(null);
    try {
      const api = window.electronAPI?.groups;
      if (!api) throw new Error("groups IPC unavailable");
      if (mode === "create") {
        const created = await api.create({ name: name.trim(), memberIds: selected });
        onSaved(created?.id ?? "");
      } else if (groupId) {
        await api.update(groupId, { name: name.trim(), memberIds: selected });
        onSaved(groupId);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  const remove = async () => {
    if (mode !== "edit" || !groupId) return;
    if (!window.confirm(`删除群聊「${name.trim()}」？`)) return;
    setSubmitting(true);
    try {
      await window.electronAPI?.groups?.delete(groupId);
      onDeleted?.(groupId);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  };

  void deleteConfigAgent; // reserved — room deletion never touches bots

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40" role="dialog" aria-modal="true">
      <div
        className="w-[420px] max-h-[80vh] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--bg-canvas)] p-5 shadow-xl"
        data-testid="group-settings-dialog"
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-semibold text-[var(--text)]">
            {mode === "create" ? "新建群聊" : "群聊设置"}
          </h2>
          <button
            type="button"
            className="rounded-md p-1 text-[var(--text-muted)] hover:bg-[var(--bg-hover)]"
            onClick={onCancel}
            aria-label="Close"
          >
            <XIcon size={16} />
          </button>
        </div>

        <label className="mb-1 block text-[12.5px] font-medium text-[var(--text-muted)]">群名称</label>
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="例如：产品讨论组"
          autoFocus
          maxLength={48}
        />

        <div className="mt-4 mb-1 flex items-center justify-between">
          <span className="text-[12.5px] font-medium text-[var(--text-muted)]">成员</span>
          <span
            className={`text-[12px] ${
              selected.length >= GROUP_MEMBER_MAX ? "text-[var(--accent-warning,#e9c46a)]" : "text-[var(--text-muted)]"
            }`}
          >
            {selected.length}/{GROUP_MEMBER_MAX}
          </span>
        </div>
        <div className="max-h-[260px] overflow-y-auto rounded-xl border border-[var(--border)]">
          {bots.length === 0 && (
            <div className="px-3 py-6 text-center text-[13px] text-[var(--text-muted)]">
              还没有可加入的 Bot — 先创建 Bot 再建群。
            </div>
          )}
          {bots.map((bot) => {
            const checked = selected.includes(bot.id);
            const disabled = !checked && selected.length >= GROUP_MEMBER_MAX;
            return (
              <button
                key={bot.id}
                type="button"
                onClick={() => toggleMember(bot.id)}
                disabled={disabled}
                className={`flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-[var(--bg-hover)] disabled:opacity-40 ${
                  checked ? "bg-[var(--bg-hover)]" : ""
                }`}
              >
                <BotCharacterAvatar
                  name={bot.name}
                  agentId={bot.id}
                  avatarColor={bot.avatarColor}
                  avatarUrl={bot.avatarUrl}
                  size={32}
                />
                <span className="flex-1 truncate text-[13.5px] text-[var(--text)]">{bot.name}</span>
                {checked && (
                  <span className="text-[13px] font-semibold text-[var(--accent,#7c9cff)]" aria-hidden>
                    ✓
                  </span>
                )}
              </button>
            );
          })}
        </div>

        {error && (
          <p className="mt-3 rounded-lg bg-[var(--bg-hover)] px-3 py-2 text-[12.5px] text-[var(--accent-danger,#ef4444)]">
            {error}
          </p>
        )}

        <div className="mt-5 flex items-center justify-between">
          {mode === "edit" ? (
            <Button variant="ghost" onClick={remove} disabled={submitting} data-testid="group-delete">
              删除群聊
            </Button>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button variant="ghost" onClick={onCancel} disabled={submitting}>
              取消
            </Button>
            <Button onClick={submit} disabled={!canSubmit} data-testid="group-save">
              {mode === "create" ? "创建" : "保存"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
