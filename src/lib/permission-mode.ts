import type { AppSettings } from "@/types";
import type { PermissionMode } from "@/components/chat/PermissionModeSelector";
import type { AgentPermissionMode } from "@/lib/permission-profile";

export function settingsPermissionModeToUi(mode?: AppSettings["permissionMode"]): PermissionMode {
  if (mode === "auto") return "auto";
  if (mode === "bypass") return "bypass";
  return "ask";
}

export function uiPermissionModeToSettings(mode: PermissionMode): AppSettings["permissionMode"] {
  if (mode === "auto") return "auto";
  if (mode === "bypass") return "bypass";
  return "default";
}

export function uiPermissionModeToAgentModeOverride(
  mode?: PermissionMode,
): AgentPermissionMode | undefined {
  if (mode === "auto") return "auto";
  if (mode === "bypass") return "bypassPermissions";
  if (mode === "ask") return "default";
  return undefined;
}

