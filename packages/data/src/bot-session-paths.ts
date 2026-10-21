import { isAbsolute, join, relative, resolve } from 'node:path';
export { BOT_SESSION_ID_PREFIX, parseAgentIdFromBotSession } from '@duya/agent-protocol';

function resolveBotDirectory(agentId: string, dataRoot: string): string {
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(agentId)) {
    throw new Error('Bot session contains an invalid agent id');
  }
  const agentsRoot = resolve(dataRoot, 'agents');
  const candidate = resolve(agentsRoot, agentId);
  const rel = relative(agentsRoot, candidate);
  const parentPrefix = process.platform === 'win32' ? '..\\' : '../';
  if (!rel || rel === '..' || rel.startsWith(parentPrefix) || isAbsolute(rel)) {
    throw new Error('Bot session path must stay inside the agents directory');
  }
  return candidate;
}

export function getBotSessionsDir(agentId: string, dataRoot: string): string {
  return join(resolveBotDirectory(agentId, dataRoot), 'sessions');
}

export function getBotSessionLogPath(agentId: string, dataRoot: string): string {
  return join(getBotSessionsDir(agentId, dataRoot), 'active.jsonl');
}
