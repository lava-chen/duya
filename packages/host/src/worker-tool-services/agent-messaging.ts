import type { SendToAgentPort } from '@duya/capabilities/send-to-agent-tool';
import { readConfigAgents } from '../worker-profiles/config-agents.js';
import { mailboxDb, messageDb } from '../worker-db-client.js';

/** Bind asynchronous agent DMs to Host config and existing Main IPC writes. */
export function createWorkerAgentMessagingPort(): SendToAgentPort {
  return {
    getSenderSessionId(contextSessionId) {
      return contextSessionId || process.env.SESSION_ID || 'unknown';
    },
    readConfigAgents,
    async sendMailbox(input) {
      return mailboxDb.send(input);
    },
    async appendMessages(sessionId, messages) {
      return messageDb.append(sessionId, messages);
    },
  };
}
