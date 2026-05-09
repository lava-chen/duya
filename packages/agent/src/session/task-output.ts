import * as path from 'path';
import * as fs from 'fs';
import os from 'os';

function getUserDataPath(): string {
  if (process.platform === 'win32') {
    return process.env.APPDATA || path.join(process.env.USERPROFILE || os.homedir(), 'AppData', 'Roaming');
  } else if (process.platform === 'darwin') {
    return path.join(process.env.HOME || os.homedir(), 'Library', 'Application Support');
  } else {
    return process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share');
  }
}

function getTaskOutputsDir(): string {
  return path.join(getUserDataPath(), 'DUYA', 'task-outputs');
}

export function getTaskOutputPath(taskId: string): string {
  return path.join(getTaskOutputsDir(), `${taskId}.txt`);
}

export function writeTaskOutput(taskId: string, output: string): void {
  const filePath = getTaskOutputPath(taskId);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, output, 'utf-8');
}

export function readTaskOutput(taskId: string): string | null {
  const filePath = getTaskOutputPath(taskId);
  if (!fs.existsSync(filePath)) return null;
  return fs.readFileSync(filePath, 'utf-8');
}

export interface TaskNotification {
  taskId: string;
  subject: string;
  status: string;
  owner?: string;
  output?: string;
  message: string;
}

export function formatTaskNotification(data: {
  taskId: string;
  subject: string;
  status: string;
  owner?: string;
  output?: string;
}): TaskNotification {
  const outputNote = data.output ? `\n> ${data.output}` : '';
  const ownerNote = data.owner ? ` (assigned to ${data.owner})` : '';
  return {
    taskId: data.taskId,
    subject: data.subject,
    status: data.status,
    owner: data.owner,
    output: data.output,
    message: `Task #${data.taskId} "${data.subject}" is now [${data.status}]${ownerNote}${outputNote}`,
  };
}
