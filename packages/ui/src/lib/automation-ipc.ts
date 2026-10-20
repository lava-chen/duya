import type {
  AutomationCron,
  AutomationTemplate,
  CreateAutomationCronInput,
  CronRunHandle,
  CronSessionSummary,
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

export async function runAutomationCronIPC(id: string): Promise<CronRunHandle> {
  return window.electronAPI.automation.runCron(id) as Promise<CronRunHandle>;
}

/** A cron's run history is its ordinary sessions (id prefix `cron:<jobId>:`). */
export async function listAutomationCronSessionsIPC(cronId: string, limit = 20, offset = 0): Promise<CronSessionSummary[]> {
  return window.electronAPI.automation.listCronSessions({ cronId, limit, offset }) as Promise<CronSessionSummary[]>;
}

export async function listAutomationTemplatesIPC(): Promise<AutomationTemplate[]> {
  return window.electronAPI.automation.listTemplates() as Promise<AutomationTemplate[]>;
}
