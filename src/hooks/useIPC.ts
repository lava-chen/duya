/**
 * useIPC.ts - IPC communication hook for Electron renderer
 *
 * This hook provides type-safe access to IPC channels exposed via preload.
 * All database operations go through Electron Main Process IPC handlers.
 *
 * This is a React hook wrapper around the IPC client functions in @/lib/ipc-client.
 * For use in non-React contexts (e.g., Zustand stores), use @/lib/ipc-client directly.
 */

import { useCallback } from 'react';
import * as ipcClient from '@/lib/ipc-client';
import type { Thread, Message, Provider, ProjectGroup, PermissionRequest } from '@/lib/ipc-client';

// Re-export types for convenience
export type { Thread, Message, Provider, ProjectGroup, PermissionRequest } from '@/lib/ipc-client';

/**
 * useIPC - Hook for IPC communication
 *
 * Provides typed wrappers around window.electronAPI database calls.
 * Falls back to fetch API for browser/non-Electron environments.
 *
 * Note: This hook wraps the IPC client functions. If you need to use IPC
 * in a non-React context (like a Zustand store), import directly from @/lib/ipc-client.
 */
export function useIPC() {
  // Thread operations
  const listThreads = useCallback(async (): Promise<Thread[]> => {
    return ipcClient.listThreadsIPC();
  }, []);

  const getThread = useCallback(async (id: string): Promise<{ thread: Thread; messages: Message[] } | null> => {
    return ipcClient.getThreadIPC(id);
  }, []);

  const createThread = useCallback(async (data: {
    id: string
    title?: string
    workingDirectory?: string
    projectName?: string
    model?: string
    mode?: string
    providerId?: string
  }): Promise<Thread | null> => {
    return ipcClient.createThreadIPC(data);
  }, []);

  const updateThread = useCallback(async (id: string, data: {
    title?: string
    workingDirectory?: string
    projectName?: string
    model?: string
    mode?: string
    permissionProfile?: string
    status?: string
    contextSummary?: string
  }): Promise<Thread | null> => {
    return ipcClient.updateThreadIPC(id, data);
  }, []);

  const deleteThread = useCallback(async (id: string): Promise<boolean> => {
    return ipcClient.deleteThreadIPC(id);
  }, []);

  // Message operations
  const addMessage = useCallback(async (data: {
    id: string
    sessionId: string
    role: string
    content: string
    name?: string
    toolCallId?: string
    tokenUsage?: string
  }): Promise<Message | null> => {
    return ipcClient.addMessageIPC(data);
  }, []);

  const replaceMessages = useCallback(async (
    sessionId: string,
    messages: unknown[],
    generation: number
  ): Promise<{ success: boolean; reason?: string }> => {
    return ipcClient.replaceMessagesIPC(sessionId, messages, generation);
  }, []);

  // Provider operations
  const listProviders = useCallback(async (): Promise<Provider[]> => {
    return ipcClient.listProvidersIPC();
  }, []);

  const getProvider = useCallback(async (id: string): Promise<Provider | null> => {
    return ipcClient.getProviderIPC(id);
  }, []);

  const upsertProvider = useCallback(async (data: {
    id: string
    name: string
    providerType?: string
    baseUrl?: string
    apiKey?: string
    isActive?: boolean
  }): Promise<Provider | null> => {
    return ipcClient.upsertProviderIPC(data);
  }, []);

  const updateProvider = useCallback(async (id: string, data: {
    name?: string
    providerType?: string
    baseUrl?: string
    apiKey?: string
    isActive?: boolean
    extraEnv?: string
    headers?: Record<string, string>
    options?: Record<string, unknown>
    notes?: string
  }): Promise<Provider | null> => {
    return ipcClient.updateProviderIPC(id, data);
  }, []);

  const deleteProvider = useCallback(async (id: string): Promise<boolean> => {
    return ipcClient.deleteProviderIPC(id);
  }, []);

  const activateProvider = useCallback(async (id: string): Promise<Provider | null> => {
    return ipcClient.activateProviderIPC(id);
  }, []);

  // Project operations
  const getProjectGroups = useCallback(async (): Promise<ProjectGroup[]> => {
    return ipcClient.getProjectGroupsIPC();
  }, []);

  // Lock operations
  const acquireLock = useCallback(async (
    sessionId: string,
    lockId: string,
    owner: string,
    ttlSec = 300
  ): Promise<boolean> => {
    return ipcClient.acquireLockIPC(sessionId, lockId, owner, ttlSec);
  }, []);

  const releaseLock = useCallback(async (sessionId: string, lockId: string): Promise<boolean> => {
    return ipcClient.releaseLockIPC(sessionId, lockId);
  }, []);

  const isLocked = useCallback(async (sessionId: string): Promise<boolean> => {
    return ipcClient.isLockedIPC(sessionId);
  }, []);

  // Permission operations
  const createPermissionRequest = useCallback(async (data: {
    id: string
    sessionId?: string
    toolName: string
    toolInput?: Record<string, unknown>
  }): Promise<PermissionRequest | null> => {
    return ipcClient.createPermissionRequestIPC(data);
  }, []);

  const resolvePermission = useCallback(async (
    id: string,
    status: string,
    extra?: {
      message?: string
      updatedPermissions?: unknown[]
      updatedInput?: Record<string, unknown>
    }
  ): Promise<PermissionRequest | null> => {
    return ipcClient.resolvePermissionIPC(id, status, extra);
  }, []);

  return {
    // Thread operations
    listThreads,
    getThread,
    createThread,
    updateThread,
    deleteThread,
    // Message operations
    addMessage,
    replaceMessages,
    // Provider operations
    listProviders,
    getProvider,
    upsertProvider,
    updateProvider,
    deleteProvider,
    activateProvider,
    // Project operations
    getProjectGroups,
    // Lock operations
    acquireLock,
    releaseLock,
    isLocked,
    // Permission operations
    createPermissionRequest,
    resolvePermission,
  };
}

export type IPC = ReturnType<typeof useIPC>;
