import type { AppSettings, PermissionMode } from "@/types";

export function uiPermissionModeToSettings(mode: PermissionMode): AppSettings["permissionMode"] {
  if (mode === "auto") return "auto";
  if (mode === "bypass") return "bypass";
  return "default";
}

