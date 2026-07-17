"use client";

import React from "react";
import { ArrowClockwise, CopySimple, X } from "@phosphor-icons/react";
import { TrashIcon } from "@/components/icons";
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
  return (
    <>
      {leadingDivider && <div style={CAPSULE_DIVIDER} />}
      {showRotate && (
        <button type="button" title="Rotate 90°" onClick={onRotate} style={CAPSULE_BTN_BASE}>
          <ArrowClockwise size={16} />
        </button>
      )}
      {showDuplicate && (
        <button type="button" title="Duplicate element" onClick={onDuplicate} style={CAPSULE_BTN_BASE}>
          <CopySimple size={16} />
        </button>
      )}
      <CapsuleMoreMenu
        title="More element actions"
        items={[
          { label: locked ? "Unlock position" : "Lock position", onSelect: onToggleLock },
          { label: "Bring to front", onSelect: onBringToFront },
          { label: "Send to back", onSelect: onSendToBack },
        ]}
      />
      <button type="button" title={deleteTitle} onClick={onDelete} style={CAPSULE_BTN_BASE}>
        <TrashIcon size={16} />
      </button>
      <button type="button" title="Close selection toolbar" onClick={onDismiss} style={CAPSULE_BTN_BASE}>
        <X size={16} />
      </button>
    </>
  );
}
