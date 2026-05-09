import type {
  AutomationCron,
  AutomationCronRun,
  CreateAutomationCronInput,
  UpdateAutomationCronInput,
} from '@/types/automation';

export async function listAutomationCronsIPC(): Promise<AutomationCron[]> {
  return window.electronAPI.automation.listCrons() as Promise<AutomationCron[]>;
}

export async function createAutomationCronIPC(data: CreateAutomationCronInput): Promise<AutomationCron> {
  return window.electronAPI.automation.createCron(data as unknown as Record<string, unknown>) as Promise<AutomationCron>;
}

export async function updateAutomationCronIPC(id: string, patch: UpdateAutomationCronInput): Promise<AutomationCron> {
  return window.electronAPI.automation.updateCron(id, patch as unknown as Record<string, unknown>) as Promise<AutomationCron>;
}

export async function deleteAutomationCronIPC(id: string): Promise<{ success: boolean }> {
  return window.electronAPI.automation.deleteCron(id) as Promise<{ success: boolean }>;
}

export async function runAutomationCronIPC(id: string): Promise<AutomationCronRun> {
  return window.electronAPI.automation.runCron(id) as Promise<AutomationCronRun>;
}

export async function listAutomationCronRunsIPC(cronId: string, limit = 20, offset = 0): Promise<AutomationCronRun[]> {
  return window.electronAPI.automation.listCronRuns({ cronId, limit, offset }) as Promise<AutomationCronRun[]>;
}
