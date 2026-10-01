/**
 * agent-server-url.ts
 *
 * Single source of truth for resolving the in-process agent server URL.
 * Previously duplicated across plugin/skills/app-connection IPC handlers.
 *
 * The URL is derived from the agent server port (managed by
 * agent-server-lifecycle) and cached for the process lifetime.
 */

let cachedAgentServerUrl: string | null = null;

export async function getAgentServerUrl(): Promise<string | null> {
  if (cachedAgentServerUrl) return cachedAgentServerUrl;
  try {
    const { getAgentServerPort } = await import('../agents/agent-server-lifecycle');
    const port = getAgentServerPort();
    if (port) {
      cachedAgentServerUrl = `http://127.0.0.1:${port}`;
    }
    return cachedAgentServerUrl;
  } catch {
    return null;
  }
}
