"use client";

import { useSyncExternalStore } from "react";

/**
 * Tiny pub-sub for the task drawer's open/close state. Used because
 * the trigger button (in ChatHeader) and the drawer (mounted in
 * AppShell) live in different subtrees and need a shared signal
 * without dragging a global store change in.
 */
let open = false;
const listeners = new Set<(value: boolean) => void>();

function emit(): void {
  for (const fn of listeners) fn(open);
}

export function isTaskDrawerOpen(): boolean {
  return open;
}

export function setTaskDrawerOpen(next: boolean): void {
  if (open === next) return;
  open = next;
  emit();
}

export function subscribeTaskDrawer(fn: (value: boolean) => void): () => void {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useTaskDrawerOpen(): boolean {
  return useSyncExternalStore(subscribeTaskDrawer, isTaskDrawerOpen, isTaskDrawerOpen);
}

