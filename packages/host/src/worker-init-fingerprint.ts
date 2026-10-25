/**
 * Does this `init` ask for the agent the worker is already running in?
 *
 * ## The problem this answers
 *
 * The Desktop agent server sends an `init` to the worker on EVERY turn, not
 * once per session (`apps/desktop/src/main/agents/server/router.ts` sends it
 * unconditionally on every `POST /sessions/:id/chat`). The worker answered
 * that by destroying the agent it was already running in and building a new
 * one.
 *
 * Building a new agent is not cheap, and none of it depends on the turn:
 *
 *   - the tool catalog is rebuilt (`initToolCatalog`),
 *   - every skill directory is re-scanned and re-security-scanned
 *     (`loadAgentSkills`),
 *   - the WHOLE transcript is read back out of the database and parsed
 *     (`hydrateWorkerSessionHistory`) -- which for a long session is
 *     megabytes of JSON per turn,
 *   - the MCP servers are torn down and handshaked again.
 *
 * And the handshake is where the turn's latency actually goes: the worker
 * waits for MCP to be ready before it asks the model anything, so a handshake
 * that has not even STARTED yet is a wait that times out for nothing.
 *
 * ## What this module decides
 *
 * Whether the agent would come out the SAME. It answers that from the init
 * payload alone, by fingerprinting the fields that shape the agent:
 * the provider configuration, the working directories, the system prompt, the
 * permission rules, the project binding, the skill paths and the flags.
 *
 * Two payloads with the same fingerprint describe the same agent, so the
 * worker can keep the one it has. Two payloads with different fingerprints do
 * not, and the worker has to build a new one.
 *
 * The fingerprint is deliberately NOT a hash: it is a canonical string. It
 * never leaves the process, so there is nothing to collide, and a mismatch
 * can be read instead of guessed at.
 */

/** The provider configuration the init carries. */
interface InitProviderConfig {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  provider?: string;
  authStyle?: string;
  visionConfig?: unknown;
  compactModelConfig?: unknown;
  runtimeConfig?: unknown;
}

/**
 * The shape of an init message this module reads.
 *
 * It is structural on purpose: the worker entry declares its own `InitMessage`
 * locally, and a fingerprint that depends on that declaration could not be
 * tested on its own.
 */
export interface WorkerInitShape {
  providerConfig?: InitProviderConfig | null;
  workingDirectory?: string;
  defaultWorkspaceDirectory?: string;
  systemPrompt?: string;
  language?: string;
  communicationPlatform?: string;
  permissionRules?: unknown;
  currentProjectId?: string | null;
  projectHome?: string;
  skillPaths?: readonly string[];
  sandboxEnabled?: boolean;
  securityScanEnabled?: boolean;
  referencesEnabled?: boolean;
}

/**
 * A canonical string for a value: object keys are sorted, so two payloads
 * that differ only in key order produce the same string.
 */
function canonical(value: unknown): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonical(entryValue)}`).join(',')}}`;
  }
  return JSON.stringify(String(value));
}

/**
 * The fingerprint of an init payload.
 *
 * Two payloads with the same fingerprint describe the same agent. The
 * `sessionId` is NOT part of it: a different session is a different agent by
 * definition, and that is checked by the caller, not by the shape.
 */
export function workerInitFingerprint(init: WorkerInitShape): string {
  const provider = init.providerConfig ?? null;
  return canonical({
    providerConfig: provider === null
      ? null
      : {
          apiKey: provider.apiKey ?? '',
          baseURL: provider.baseURL ?? '',
          model: provider.model ?? '',
          provider: provider.provider ?? '',
          authStyle: provider.authStyle ?? '',
          visionConfig: provider.visionConfig ?? null,
          compactModelConfig: provider.compactModelConfig ?? null,
          runtimeConfig: provider.runtimeConfig ?? null,
        },
    workingDirectory: init.workingDirectory ?? '',
    defaultWorkspaceDirectory: init.defaultWorkspaceDirectory ?? '',
    systemPrompt: init.systemPrompt ?? '',
    language: init.language ?? '',
    communicationPlatform: init.communicationPlatform ?? '',
    permissionRules: init.permissionRules ?? null,
    currentProjectId: init.currentProjectId ?? null,
    projectHome: init.projectHome ?? '',
    skillPaths: init.skillPaths ?? [],
    sandboxEnabled: init.sandboxEnabled ?? true,
    securityScanEnabled: init.securityScanEnabled ?? true,
    referencesEnabled: init.referencesEnabled ?? false,
  });
}

/**
 * Whether the worker may keep the agent it is already running in.
 *
 * The caller owns the parts that are about the WORKER rather than about the
 * payload: whether an agent exists at all, whether it belongs to this
 * session, and whether a chat is running. This function owns the part that
 * is about the payload: whether it asks for a different agent.
 */
export function canReuseAgentForInit(
  previous: WorkerInitShape | null,
  next: WorkerInitShape,
): boolean {
  if (previous === null) return false;
  return workerInitFingerprint(previous) === workerInitFingerprint(next);
}

/**
 * The names of the fields that make two init payloads different agents.
 *
 * This is what a rebuild should say out loud: "the model changed", "the
 * permission rules changed". Without it, the only thing a log can say is that
 * something changed, and the next person to see an unexpected rebuild has
 * nothing to go on.
 */
export function workerInitDifferences(
  previous: WorkerInitShape | null,
  next: WorkerInitShape,
): string[] {
  if (previous === null) return ['(no previous agent)'];
  const differences: string[] = [];
  const fields: Array<keyof WorkerInitShape> = [
    'providerConfig',
    'workingDirectory',
    'defaultWorkspaceDirectory',
    'systemPrompt',
    'language',
    'communicationPlatform',
    'permissionRules',
    'currentProjectId',
    'projectHome',
    'skillPaths',
    'sandboxEnabled',
    'securityScanEnabled',
    'referencesEnabled',
  ];
  for (const field of fields) {
    if (canonical(previous[field] ?? null) !== canonical(next[field] ?? null)) {
      differences.push(field);
    }
  }
  // The provider configuration has parts of its own, and a difference in the
  // MODEL is a different agent in a way that "providerConfig" does not say.
  const previousProvider = previous.providerConfig ?? null;
  const nextProvider = next.providerConfig ?? null;
  if (previousProvider !== null && nextProvider !== null) {
    for (const field of ['apiKey', 'baseURL', 'model', 'provider', 'authStyle'] as const) {
      if (canonical(previousProvider[field] ?? '') !== canonical(nextProvider[field] ?? '')) {
        differences.push(`providerConfig.${field}`);
      }
    }
    const previousRuntime = (previousProvider.runtimeConfig ?? {}) as Record<string, unknown>;
    const nextRuntime = (nextProvider.runtimeConfig ?? {}) as Record<string, unknown>;
    for (const field of new Set([...Object.keys(previousRuntime), ...Object.keys(nextRuntime)])) {
      if (canonical(previousRuntime[field]) !== canonical(nextRuntime[field])) {
        differences.push(`providerConfig.runtimeConfig.${field}`);
      }
    }
  }
  return differences;
}
