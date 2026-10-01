"use client";

/**
 * PluginHookConsentCard — informed consent for a plugin that runs local processes.
 *
 * Plan 583, seam C. A plugin's `hooks/hooks.json` may declare `command` /
 * `process` hooks, and the agent's hook executor spawns them for real:
 * `command` through the shell with `cwd` set to the session working directory,
 * `process` as a direct exec, and a `node` command rewritten onto the app's own
 * Electron runtime. The agent refuses to run any of it below the first-party
 * tier until the user has answered here.
 *
 * The card shows the actual command lines rather than asking for a blind
 * "trust this plugin?" — the decision is about those specific commands, so the
 * user needs to see them to make it.
 *
 * It renders nothing when the plugin declares no local-execution hooks, or when
 * it is first-party and therefore exempt. An undecided plugin is the only state
 * that prompts; `denied` is a recorded answer, not an absence, so the buttons
 * change but the explanation stays.
 */

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/Button";
import { WarningIcon, SpinnerGapIcon } from "@/components/icons";
import { cn } from "@/lib/utils";
import { getPluginAPI } from "@/lib/plugin-ipc";
import type { PluginHookConsentStatus, PluginHookConsentDecision } from "@/lib/plugin-types";

interface PluginHookConsentCardProps {
  pluginId: string;
  /** Re-read whenever this changes, so returning to a different plugin refetches. */
  refreshToken?: string;
}

export function PluginHookConsentCard({ pluginId, refreshToken }: PluginHookConsentCardProps) {
  const [status, setStatus] = useState<PluginHookConsentStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const api = getPluginAPI();
    if (!api) {
      setLoading(false);
      return;
    }
    try {
      const res = await api.hookConsentGet(pluginId);
      if (res.success && res.data) {
        setStatus(res.data);
        setError(null);
      } else {
        setError(res.error ?? "Failed to read hook execution status");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [pluginId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load, refreshToken]);

  const decide = useCallback(
    async (decision: PluginHookConsentDecision) => {
      const api = getPluginAPI();
      if (!api) return;
      setSaving(true);
      setError(null);
      try {
        const res = await api.hookConsentSet(pluginId, decision);
        if (!res.success) {
          setError(res.error ?? "Failed to record your choice");
          return;
        }
        // Re-read rather than patching locally: the main process is the one
        // that decides `required`, and a granted plugin must stop showing the
        // prompt while still offering a way to revoke.
        await load();
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setSaving(false);
      }
    },
    [pluginId, load],
  );

  if (loading) return null;
  if (!status || !status.required) return null;

  const granted = status.decision === "granted";

  return (
    <div className="space-y-3">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <WarningIcon size={15} className="text-amber-500" />
        Hook execution
      </h4>

      <div className="rounded-xl border border-border/35 bg-background/35 px-3 py-3">
        <p className="text-xs leading-5 text-muted-foreground">
          This plugin asks to run the following commands on your machine when a hook
          event happens. They run with your user account&rsquo;s permissions, in your
          current workspace. Until you allow it, these hooks are skipped.
        </p>

        <ul className="mt-3 space-y-2">
          {status.localExecutionHooks.map((hook, index) => (
            <li
              key={`${hook.event}:${index}`}
              className="rounded-lg border border-border/35 bg-background/50 px-3 py-2"
            >
              <div className="text-[10px] font-medium uppercase text-muted-foreground">
                {hook.event}
              </div>
              <code className="mt-1 block break-all text-xs text-foreground">
                {hook.handler}
              </code>
            </li>
          ))}
        </ul>

        <div className="mt-3 flex items-center gap-2">
          {granted ? (
            <>
              <span className={cn("text-xs font-medium", "text-emerald-600")}>Allowed</span>
              <Button
                variant="danger"
                size="sm"
                disabled={saving}
                onClick={() => void decide("denied")}
              >
                {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : null}
                Revoke
              </Button>
            </>
          ) : (
            <>
              <Button
                variant="danger"
                size="sm"
                disabled={saving}
                onClick={() => void decide("denied")}
              >
                Deny
              </Button>
              <Button
                variant="primary"
                size="sm"
                disabled={saving}
                onClick={() => void decide("granted")}
              >
                {saving ? <SpinnerGapIcon size={14} className="animate-spin" /> : null}
                Allow
              </Button>
            </>
          )}
        </div>

        {error && <p className="mt-2 text-xs text-red-500">{error}</p>}
      </div>
    </div>
  );
}
