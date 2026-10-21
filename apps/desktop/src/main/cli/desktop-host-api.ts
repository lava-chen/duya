import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { resolveDataRoot } from '@duya/data/data-paths';
import { resolveProject } from '../memory-state/projectResolver';
import { ChatTurnReviewStore } from '@duya/data/chat-turn-review-store';
import { MainSettingsStore } from '@duya/data/main-settings-store';
import { TerminalHistoryStore } from '@duya/data/terminal-history-store';
import { GatewayUserMapStore } from '@duya/data/gateway-user-map-store';
import { ChannelPersistenceStore } from '@duya/data/channel-persistence-store';
import { AgentProfileStore } from '@duya/data/agent-profile-store';
import { GatewayChannelDirectoryStore } from '@duya/data/gateway-channel-directory-store';
import { GatewayAllowlistStore } from '@duya/data/gateway-allowlist-store';
import { GatewayMessageMirrorStore } from '@duya/data/gateway-message-mirror-store';
import { GatewayThreadStore } from '@duya/data/gateway-thread-store';
import { SendMessageStateStore } from '@duya/data/send-message-state-store';
import { ModelCapabilityStore } from '@duya/data/model-capability-store';
import { AppConnectionStore } from '@duya/data/app-connection-store';
import { PluginSetupStore } from '@duya/data/plugin-setup-store';
import { MainAttachmentStore } from '@duya/data/main-attachment-store';
import { WorkbenchDataStore } from '@duya/data/workbench-store';
import { ImportBatchStore } from '@duya/data/import-batch-store';
import { SidebarSectionsStore } from '@duya/data/sidebar-sections-store';
import { ProviderModelPricingStore } from '@duya/data/provider-model-pricing-store';
import { ProviderModelCapabilityStore } from '@duya/data/provider-model-capability-store';
import type {
  HostSessionApiV1,
  HostPermissionRequestApiV1,
  HostToolApprovalApiV1,
  HostTaskApiV1,
  HostProjectApiV1,
  HostRunApiV1,
  HostWorkspaceRegistrationApiV1,
  HostLocalSettingsApiV1,
  HostLocalTerminalHistoryApiV1,
  HostLocalGatewayUserMapApiV1,
  HostLocalChannelPersistenceApiV1,
  HostLocalAgentProfileApiV1,
  HostLocalGatewayDirectoryApiV1,
  HostLocalGatewayAllowlistApiV1,
  HostLocalGatewayMessageMirrorApiV1,
  HostLocalGatewayThreadApiV1,
  HostLocalSendMessageStateApiV1,
  HostLocalModelCapabilityApiV1,
  HostLocalAppConnectionApiV1,
  HostLocalPluginSetupApiV1,
  HostLocalWorkbenchApiV1,
  HostLocalSidebarSectionsApiV1,
  HostLocalUsageApiV1,
  HostLocalImportBatchApiV1,
  HostLocalTurnReviewApiV1,
  HostLocalMailboxApiV1,
  HostLocalPendingWakeApiV1,
  HostLockApiV1,
  HostHealthApiV1,
  HostLocalProviderModelCapabilityApiV1,
} from '@duya/agent-protocol';
import type { HostLocalAttachmentApiV1 } from '@duya/agent-protocol/session-api';
import { HostSessionHttpClient } from '@duya/host/http-client';
import { HostSessionHttpServer } from '@duya/host/http-server';
import { createHostLocalSessionApi } from '@duya/host/local-session-api';
import type { HostLocalSessionApiV1 } from '@duya/host/local-session-api';
import { createHostLocalProjectApi } from '@duya/host/local-project-api';
import type { HostLocalProjectApiV1 } from '@duya/host/local-project-api';
import { createHostLocalRolloutApi } from '@duya/host/local-rollout-api';
import type { HostLocalRolloutApiV1 } from '@duya/host/local-rollout-api';
import { createHostLocalAttachmentApi } from '@duya/host/local-attachment-api';
import { createHostLocalSettingsApi } from '@duya/host/local-settings-api';
import { createHostLocalTerminalHistoryApi } from '@duya/host/local-terminal-history-api';
import { createHostLocalGatewayUserMapApi } from '@duya/host/local-gateway-user-map-api';
import { createHostLocalGatewayDirectoryApi } from '@duya/host/local-gateway-directory-api';
import { createHostLocalGatewayAllowlistApi } from '@duya/host/local-gateway-allowlist-api';
import { createHostLocalGatewayMessageMirrorApi } from '@duya/host/local-gateway-message-mirror-api';
import { createHostLocalGatewayThreadApi } from '@duya/host/local-gateway-thread-api';
import { createHostLocalSendMessageStateApi } from '@duya/host/local-send-message-state-api';
import { createHostLocalModelCapabilityApi } from '@duya/host/local-model-capability-api';
import { createHostLocalProviderModelCapabilityApi } from '@duya/host/local-provider-model-capability-api';
import { createHostLocalAppConnectionApi } from '@duya/host/local-app-connection-api';
import { createHostLocalPluginSetupApi } from '@duya/host/local-plugin-setup-api';
import { createHostLocalWorkbenchApi } from '@duya/host/local-workbench-api';
import { createHostLocalSidebarSectionsApi } from '@duya/host/local-sidebar-sections-api';
import { createHostLocalUsageApi } from '@duya/host/local-usage-api';
import { createHostLocalImportBatchApi } from '@duya/host/local-import-batch-api';
import { createHostLocalTurnReviewApi } from '@duya/host/local-turn-review-api';
import { createHostLocalMailboxApi } from '@duya/host/local-mailbox-api';
import {
  createHostLocalAgentProfileApi,
  createHostLocalChannelPersistenceApi,
  createHostLocalPendingWakeApi,
} from '@duya/host';
import { createHostWorkflowRunApi } from '@duya/host/workflow-run-api';
import { createHostGoalApi } from '@duya/host/goal-api';
import { createHostModeStateApi } from '@duya/host/mode-state-api';
import type { WorkflowRunApiV1 } from '@duya/agent-protocol/workflow-runs';
import type { HostGoalApiV1 } from '@duya/agent-protocol/goals';
import type { HostModeStateApiV1 } from '@duya/agent-protocol/mode-state';
import type { HostResearchApiV1 } from '@duya/agent-protocol/research-api';
import { createHostSessionApi, createHostWorkspaceRegistrationApi } from '@duya/host/session-api';
import { createHostTaskApi } from '@duya/host/task-api';
import { createHostProjectApi } from '@duya/host/project-api';
import { createHostPermissionRequestApi } from '@duya/host/permission-request-api';
import { createHostToolApprovalApi } from '@duya/host/tool-approval-api';
import { createHostLockApi } from '@duya/host/lock-api';
import { createHostRunApi } from '@duya/host/run-api';
import { createHostResearchApi } from '@duya/host/research-api';
import { createDatabaseWorkspaceAccess } from '@duya/host/workspace-access';
import { resolveRolloutRoot } from '../config/boot-config';
import { getCoreStores } from '../db/core-connection';
import { getDatabase } from '../db/connection';
import { getLogger, LogComponent } from '../logging/logger';
import { deriveConnectionSlug } from '@duya/plugin-core/mcp/core/alias';

const HOST = '127.0.0.1' as const;

interface HostApiRuntime {
  readonly apiVersion: 1;
  readonly host: typeof HOST;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: number;
}

export interface DesktopHostApiHandle {
  readonly port: number;
  stop(): Promise<void>;
}

let sessionApiClient: HostSessionHttpClient | null = null;
let runningHandle: DesktopHostApiHandle | null = null;
let startup: Promise<DesktopHostApiHandle> | null = null;

async function writeRuntimeFile(filePath: string, runtime: HostApiRuntime): Promise<void> {
  const directory = path.dirname(filePath);
  await fs.mkdir(directory, { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporaryPath, JSON.stringify(runtime), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporaryPath, filePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function removeOwnedRuntimeFile(filePath: string, runtime: HostApiRuntime): Promise<void> {
  try {
    const raw = await fs.readFile(filePath, 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed && typeof parsed === 'object' && !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).pid === runtime.pid &&
      (parsed as Record<string, unknown>).token === runtime.token
    ) {
      await fs.unlink(filePath);
    }
  } catch (error) {
    // A malformed or concurrently replaced descriptor is not ours to remove.
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT' && !(error instanceof SyntaxError)) {
      throw error;
    }
  }
}

/**
 * Expose Desktop's Host session, timeline, and task services through the same
 * authenticated API used by `duya serve`. Main still owns the database handles.
 */
export function startDesktopHostApi(): Promise<DesktopHostApiHandle> {
  if (runningHandle) return Promise.resolve(runningHandle);
  if (startup) return startup;
  startup = startDesktopHostApiOnce().then((handle) => {
    runningHandle = handle;
    return handle;
  }).finally(() => {
    startup = null;
  });
  return startup;
}

async function startDesktopHostApiOnce(): Promise<DesktopHostApiHandle> {
  const dataRoot = resolveDataRoot();
  const runtimeFilePath = path.join(dataRoot, 'runtime', 'host-api.json');
  const token = randomBytes(32).toString('base64url');
  const stores = getCoreStores();
  const mainDatabase = getDatabase();
  if (!mainDatabase) throw new Error('Main database is not available for Host composition');
  const workspaceAccess = createDatabaseWorkspaceAccess(stores.coreDb.db, stores.workspaces);
  const settings = new MainSettingsStore(mainDatabase);
  const turnReviews = new ChatTurnReviewStore(mainDatabase);
  const api = createHostSessionApi({
    stores,
    rolloutRoot: resolveRolloutRoot(),
    chatTurnReviews: turnReviews,
    permissionSettings: settings,
    warn: (message, fields) => getLogger().warn(message, fields, LogComponent.DB),
    workspaceDatabase: stores.coreDb.db,
    workspaces: workspaceAccess,
  });
  const localAttachmentApi = createHostLocalAttachmentApi({
    stores,
    legacyAttachments: new MainAttachmentStore(mainDatabase),
  });
  const server = new HostSessionHttpServer({
    api,
    localSessionApi: createHostLocalSessionApi({
      stores,
      sessions: api,
    }),
    localProjectApi: createHostLocalProjectApi({
      resolveProjectPath: (input) => {
        const resolved = resolveProject({
          workingDirectory: input.workingDirectory,
          agent_profile_id: input.agentProfileId ?? undefined,
          cwd: input.cwd,
          workspaceOverridesPath: input.workspaceOverridesPath,
          memoryDb: stores.coreDb.db,
        });
        return {
          projectId: resolved.project_id,
          canonicalRoot: resolved.canonical_root,
          resolutionSource: resolved.resolution_source,
          aliasKind: resolved.alias_kind,
          absoluteNormalizedPath: resolved.absolute_normalized_path,
        };
      },
    }),
    localRolloutApi: createHostLocalRolloutApi({ stores, sessions: api, rolloutRoot: resolveRolloutRoot() }),
    localAttachmentApi,
    localSettingsApi: createHostLocalSettingsApi(settings),
    localTerminalHistoryApi: createHostLocalTerminalHistoryApi(new TerminalHistoryStore(mainDatabase)),
    localGatewayUserMapApi: createHostLocalGatewayUserMapApi(new GatewayUserMapStore(mainDatabase)),
    localChannelPersistenceApi: createHostLocalChannelPersistenceApi(new ChannelPersistenceStore(mainDatabase)),
    localAgentProfileApi: createHostLocalAgentProfileApi(new AgentProfileStore(mainDatabase)),
    localGatewayDirectoryApi: createHostLocalGatewayDirectoryApi(new GatewayChannelDirectoryStore(mainDatabase)),
    localGatewayAllowlistApi: createHostLocalGatewayAllowlistApi(new GatewayAllowlistStore(mainDatabase)),
    localGatewayMessageMirrorApi: createHostLocalGatewayMessageMirrorApi(new GatewayMessageMirrorStore(mainDatabase)),
    localGatewayThreadApi: createHostLocalGatewayThreadApi(new GatewayThreadStore(mainDatabase)),
    localSendMessageStateApi: createHostLocalSendMessageStateApi(new SendMessageStateStore(mainDatabase)),
    localModelCapabilityApi: createHostLocalModelCapabilityApi(new ModelCapabilityStore(mainDatabase)),
    localProviderModelCapabilityApi: createHostLocalProviderModelCapabilityApi(
      new ProviderModelCapabilityStore(mainDatabase),
    ),
    localAppConnectionApi: createHostLocalAppConnectionApi(
      new AppConnectionStore(mainDatabase, deriveConnectionSlug),
    ),
    localPluginSetupApi: createHostLocalPluginSetupApi(new PluginSetupStore(mainDatabase)),
    localWorkbenchApi: createHostLocalWorkbenchApi(new WorkbenchDataStore(mainDatabase)),
    localSidebarSectionsApi: createHostLocalSidebarSectionsApi(new SidebarSectionsStore(mainDatabase)),
    localUsageApi: createHostLocalUsageApi({
      stores,
      pricing: new ProviderModelPricingStore(mainDatabase),
    }),
    localImportBatchApi: createHostLocalImportBatchApi(new ImportBatchStore(mainDatabase)),
    localTurnReviewApi: createHostLocalTurnReviewApi(turnReviews),
    localMailboxApi: createHostLocalMailboxApi(stores.mailbox),
    localPendingWakeApi: createHostLocalPendingWakeApi(stores.wakes),
    workflowRunApi: createHostWorkflowRunApi(stores),
    runApi: createHostRunApi(stores),
    goalApi: createHostGoalApi(stores),
    modeStateApi: createHostModeStateApi(stores),
    taskApi: createHostTaskApi(stores),
    projectApi: createHostProjectApi(stores.projects),
    researchApi: createHostResearchApi(stores),
    permissionRequestApi: createHostPermissionRequestApi(stores),
    toolApprovalApi: createHostToolApprovalApi(mainDatabase),
    lockApi: createHostLockApi(stores),
    workspaceApi: createHostWorkspaceRegistrationApi(workspaceAccess),
    host: HOST,
    token,
  });

  await server.listen();
  const runtime: HostApiRuntime = {
    apiVersion: 1,
    host: HOST,
    port: server.port,
    token,
    pid: process.pid,
    startedAt: Date.now(),
  };

  try {
    await writeRuntimeFile(runtimeFilePath, runtime);
  } catch (error) {
    await server.close().catch(() => undefined);
    throw error;
  }

  const client = new HostSessionHttpClient(`http://${HOST}:${server.port}`, token);
  sessionApiClient = client;

  // `PluginManager.listInstalled()` is a synchronous read model consumed by
  // MCP and capability discovery. Warm its setup-state projection only after
  // the Host API client is ready; setup values remain Host-owned.
  try {
    const { getPluginManager } = await import('../plugins/PluginManager');
    await getPluginManager().refreshSetupValuesCache();
  } catch (error) {
    getLogger().warn(
      'Could not initialize plugin setup-state cache from Host',
      { error: String(error) },
      LogComponent.Main,
    );
  }

  let stopped = false;
  const handle: DesktopHostApiHandle = {
    port: server.port,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      try {
        await server.close();
      } finally {
        if (sessionApiClient === client) sessionApiClient = null;
        if (runningHandle === handle) runningHandle = null;
        await removeOwnedRuntimeFile(runtimeFilePath, runtime);
      }
    },
  };
  return handle;
}

export function getDesktopHostSessionApi(): HostSessionApiV1 & HostWorkspaceRegistrationApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host session API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalSessionApi(): HostLocalSessionApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host local session API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalProjectApi(): HostLocalProjectApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host local project API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalRolloutApi(): HostLocalRolloutApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host local rollout API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalAttachmentApi(): HostLocalAttachmentApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host local attachment API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalSettingsApi(): HostLocalSettingsApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host local settings API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalTerminalHistoryApi(): HostLocalTerminalHistoryApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host terminal history API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalGatewayUserMapApi(): HostLocalGatewayUserMapApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host Gateway user-map API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalChannelPersistenceApi(): HostLocalChannelPersistenceApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host channel persistence API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalAgentProfileApi(): HostLocalAgentProfileApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host Agent profile API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalGatewayDirectoryApi(): HostLocalGatewayDirectoryApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host Gateway directory API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalGatewayAllowlistApi(): HostLocalGatewayAllowlistApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host Gateway allow-list API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalGatewayMessageMirrorApi(): HostLocalGatewayMessageMirrorApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host Gateway message-mirror API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalGatewayThreadApi(): HostLocalGatewayThreadApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host Gateway thread API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalSendMessageStateApi(): HostLocalSendMessageStateApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host message-card state API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalModelCapabilityApi(): HostLocalModelCapabilityApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host model-capability API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalProviderModelCapabilityApi(): HostLocalProviderModelCapabilityApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host provider model-capability API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalAppConnectionApi(): HostLocalAppConnectionApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host App Connection API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalPluginSetupApi(): HostLocalPluginSetupApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host plugin-setup API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalWorkbenchApi(): HostLocalWorkbenchApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host Workbench API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalSidebarSectionsApi(): HostLocalSidebarSectionsApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host sidebar sections API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalUsageApi(): HostLocalUsageApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host usage API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalImportBatchApi(): HostLocalImportBatchApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host import-batch API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalTurnReviewApi(): HostLocalTurnReviewApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host turn-review API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalMailboxApi(): HostLocalMailboxApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host local mailbox API is not running');
  return sessionApiClient;
}

export function getDesktopHostLocalPendingWakeApi(): HostLocalPendingWakeApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host local pending-wake API is not running');
  return sessionApiClient;
}

export function getDesktopHostWorkflowRunApi(): WorkflowRunApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host workflow run API is not running');
  return sessionApiClient;
}

export function getDesktopHostGoalApi(): HostGoalApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host goal API is not running');
  return sessionApiClient;
}

export function getDesktopHostModeStateApi(): HostModeStateApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host mode-state API is not running');
  return sessionApiClient;
}

export function getDesktopHostTaskApi(): HostTaskApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host task API is not running');
  return sessionApiClient;
}

export function getDesktopHostProjectApi(): HostProjectApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host project API is not running');
  return sessionApiClient;
}

export function getDesktopHostPermissionRequestApi(): HostPermissionRequestApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host permission request API is not running');
  return sessionApiClient;
}

export function getDesktopHostToolApprovalApi(): HostToolApprovalApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host tool-approval API is not running');
  return sessionApiClient;
}

export function getDesktopHostLockApi(): HostLockApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host lock API is not running');
  return sessionApiClient;
}

export function getDesktopHostHealthApi(): HostHealthApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host health API is not running');
  return sessionApiClient;
}

export function getDesktopHostRunApi(): HostRunApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host run API is not running');
  return sessionApiClient;
}

export function getDesktopHostResearchApi(): HostResearchApiV1 {
  if (!sessionApiClient) throw new Error('Desktop Host research API is not running');
  return sessionApiClient;
}

export async function stopDesktopHostApi(): Promise<void> {
  if (startup) {
    try {
      await startup;
    } catch {
      return;
    }
  }
  await runningHandle?.stop();
}
