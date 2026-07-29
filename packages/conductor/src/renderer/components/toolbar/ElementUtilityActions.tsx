"use client";

import React from "react";
import { ArrowClockwiseIcon, CopySimpleIcon, XIcon, TrashIcon } from "@/components/icons";
import { useTranslation } from "@/hooks/useTranslation";
import {
  CAPSULE_BTN_BASE,
  CAPSULE_DIVIDER,
  CapsuleMoreMenu,
} from "./CapsuleToolbar";

export interface ElementUtilityActionsProps {
  onDuplicate: () => void;
  onRotate: () => void;
  onBringToFront: () => void;
  onSendToBack: () => void;
  onDismiss: () => void;
  onDelete: (event: React.MouseEvent) => void;
  deleteTitle: string;
  leadingDivider?: boolean;
  showDuplicate?: boolean;
  showRotate?: boolean;
  locked: boolean;
  onToggleLock: () => void;
}

export function ElementUtilityActions({
  onDuplicate,
  onRotate,
  onBringToFront,
  onSendToBack,
  onDismiss,
  onDelete,
  deleteTitle,
  leadingDivider = true,
  showDuplicate = true,
  showRotate = true,
  locked,
  onToggleLock,
}: ElementUtilityActionsProps) {
  const { t } = useTranslation();
  return (
    <>
      {leadingDivider && <div style={CAPSULE_DIVIDER} />}
      {showRotate && (
        <button type="button" title={t("conductor.utility.rotate")} onClick={onRotate} style={CAPSULE_BTN_BASE}>
          <ArrowClockwiseIcon size={16} />
        </button>
      )}
      {showDuplicate && (
        <button type="button" title={t("conductor.utility.duplicate")} onClick={onDuplicate} style={CAPSULE_BTN_BASE}>
          <CopySimpleIcon size={16} />
        </button>
      )}
      <CapsuleMoreMenu
        title={t("conductor.utility.moreActions")}
        items={[
          { label: locked ? t("conductor.utility.unlockPosition") : t("conductor.utility.lockPosition"), onSelect: onToggleLock },
          { label: t("conductor.utility.bringToFront"), onSelect: onBringToFront },
          { label: t("conductor.utility.sendToBack"), onSelect: onSendToBack },
        ]}
      />
      <button type="button" title={deleteTitle} onClick={onDelete} style={CAPSULE_BTN_BASE}>
        <TrashIcon size={16} />
      </button>
      <button type="button" title={t("conductor.utility.closeToolbar")} onClick={onDismiss} style={CAPSULE_BTN_BASE}>
        <XIcon size={16} />
      </button>
    </>
  );
}
