"use client";

import { SettingsCard } from "@/components/settings/ui";
import { useTranslation } from "@/hooks/useTranslation";
import type { PluginRegistryEntry, PluginPermission } from "@/lib/plugin-types";

interface PluginPermissionReviewProps {
  plugin: PluginRegistryEntry;
  allPermissions: PluginPermission[];
  onGrant: (permissionName: string) => void;
  onRevoke: (permissionName: string) => void;
}

export function PluginPermissionReview({
  plugin,
  allPermissions,
  onGrant,
  onRevoke,
}: PluginPermissionReviewProps) {
  const { t } = useTranslation();
  const grantedSet = new Set(plugin.permissionsGranted);

  return (
    <SettingsCard>
      <div className="space-y-4">
        <h3 className="font-medium text-foreground">
          {t("settings.capabilities.permissions.title" as never)}
        </h3>

        {allPermissions.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            This plugin does not require any permissions.
          </p>
        ) : (
          <div className="space-y-2">
            {allPermissions.map((perm) => {
              const isGranted = grantedSet.has(perm.name);
              return (
                <div
                  key={perm.name}
                  className="flex items-center justify-between gap-3 py-2 px-3 rounded-md border border-border/30"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-foreground">
                        {perm.name}
                      </span>
                      <span
                        className={`text-[10px] px-1.5 py-0.5 rounded-full ${
                          isGranted
                            ? "bg-emerald-500/15 text-emerald-400"
                            : "bg-zinc-500/15 text-zinc-400"
                        }`}
                      >
                        {isGranted
                          ? t("settings.capabilities.permissions.granted" as never)
                          : t("settings.capabilities.permissions.denied" as never)}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 mt-1 text-[11px] text-muted-foreground">
                      {perm.scope && (
                        <span>
                          {t("settings.capabilities.permissions.scopeLabel" as never)}: {perm.scope}
                        </span>
                      )}
                      {perm.domains && perm.domains.length > 0 && (
                        <span>
                          {t("settings.capabilities.permissions.domainsLabel" as never)}: {perm.domains.join(", ")}
                        </span>
                      )}
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      isGranted ? onRevoke(perm.name) : onGrant(perm.name)
                    }
                    className={`text-xs px-2 py-1 rounded ${
                      isGranted
                        ? "bg-red-500/10 text-red-400 hover:bg-red-500/20"
                        : "bg-accent/10 text-accent hover:bg-accent/20"
                    }`}
                  >
                    {isGranted
                      ? t("settings.capabilities.permissions.revoke" as never)
                      : "Grant"}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </SettingsCard>
  );
}