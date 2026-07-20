import { useCallback, useEffect, useRef, useState } from "react";
import { useConductorStore } from "../../../stores/conductor-store";

type ExitMode = "save" | "cancel" | null;

interface ElementEditSessionOptions<TDraft, TSource> {
  elementId: string;
  source: TSource;
  createDraft: (source: TSource) => TDraft;
  onCommit: (draft: TDraft) => void;
  onCancel?: () => void;
  focusEditor?: () => void;
}

/**
 * Shared lifecycle for canvas element editors.
 *
 * Every editor gets the same enter/focus, IME, blur-save, Escape-cancel, and
 * external-exit behavior. Element components remain responsible only for
 * translating their draft into an element-specific config patch.
 */
export function useElementEditSession<TDraft, TSource>({
  elementId,
  source,
  createDraft,
  onCommit,
  onCancel,
  focusEditor,
}: ElementEditSessionOptions<TDraft, TSource>) {
  const editingElementId = useConductorStore((state) => state.editingElementId);
  const setEditingElementId = useConductorStore((state) => state.setEditingElementId);
  const isEditing = editingElementId === elementId;
  const [draft, setDraftState] = useState<TDraft>(() => createDraft(source));
  const draftRef = useRef(draft);
  const exitModeRef = useRef<ExitMode>(null);
  const wasEditingRef = useRef(isEditing);
  const isComposingRef = useRef(false);
  const commitRef = useRef(onCommit);
  const focusRef = useRef(focusEditor);

  commitRef.current = onCommit;
  focusRef.current = focusEditor;

  const setDraft = useCallback((next: TDraft | ((current: TDraft) => TDraft)) => {
    setDraftState((current) => {
      const resolved = typeof next === "function"
        ? (next as (value: TDraft) => TDraft)(current)
        : next;
      draftRef.current = resolved;
      return resolved;
    });
  }, []);

  useEffect(() => {
    // Preserve the pending draft during the first render after an external
    // editing-state exit. The transition effect below must commit that draft
    // before source synchronization is allowed to replace it.
    if (isEditing || wasEditingRef.current) return;
    const next = createDraft(source);
    draftRef.current = next;
    setDraftState(next);
  }, [createDraft, elementId, isEditing, source]);

  useEffect(() => {
    if (!isEditing) return;
    exitModeRef.current = null;
    const frame = window.requestAnimationFrame(() => focusRef.current?.());
    return () => window.cancelAnimationFrame(frame);
  }, [isEditing]);

  const save = useCallback(() => {
    if (exitModeRef.current !== null) return;
    exitModeRef.current = "save";
    commitRef.current(draftRef.current);
    setEditingElementId(null);
  }, [setEditingElementId]);

  const cancel = useCallback(() => {
    if (exitModeRef.current !== null) return;
    exitModeRef.current = "cancel";
    const next = createDraft(source);
    draftRef.current = next;
    setDraftState(next);
    onCancel?.();
    setEditingElementId(null);
  }, [createDraft, onCancel, setEditingElementId, source]);

  useEffect(() => {
    if (wasEditingRef.current && !isEditing && exitModeRef.current === null) {
      exitModeRef.current = "save";
      commitRef.current(draftRef.current);
    }
    wasEditingRef.current = isEditing;
  }, [isEditing]);

  return {
    isEditing,
    draft,
    setDraft,
    save,
    cancel,
    isComposingRef,
  };
}
