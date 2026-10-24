import { randomBytes, randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { parse } from '@iarna/toml';
import {
  ChatTurnReviewStore,
  DatabaseHost,
  LegacyImport,
  MainSettingsStore,
  MainAttachmentStore,
  TerminalHistoryStore,
  GatewayUserMapStore,
  ChannelPersistenceStore,
  AgentProfileStore,
  GatewayChannelDirectoryStore,
  GatewayAllowlistStore,
  GatewayMessageMirrorStore,
  GatewayThreadStore,
  SendMessageStateStore,
  ModelCapabilityStore,
  AppConnectionStore,
  PluginSetupStore,
  ImportBatchStore,
  SidebarSectionsStore,
  ProviderModelPricingStore,
  ProviderModelCapabilityStore,
  migratePreviousDefaultDatabases,
  resolveDataRoot,
  resolveDatabasePaths,
  type SqliteCtor,
} from '@duya/data';
import {
  getBotSessionLogPath,
  getBotSessionsDir,
  parseAgentIdFromBotSession,
} from '@duya/data/bot-session-paths';
import type { HostWorkspaceAccess } from './session-api.js';
import { createHostSessionApi, createHostWorkspaceRegistrationApi } from './session-api.js';
import { createHostSessionService } from './session-service.js';
import {
  createFileDiagnosticsLogger,
  createStdioDiagnosticsLogger,
  resolveDiagnosticsSink,
  resolveHostDiagnosticsLogPath,
  type HostDiagnosticsSink,
} from './host-diagnostics-log.js';
import { HostSessionHttpServer } from './http-server.js';
import { manifestPermissionMode, profileToAgentMode } from '@duya/agent-runtime/authorization/profile-bridge';
import { createHostLocalRolloutApi } from './local-rollout-api.js';
import { createHostLocalWorkspaceFileApi } from './local-workspace-file-api.js';
import { createHostLocalSessionApi } from './local-session-api.js';
import { createHostLocalAttachmentApi } from './local-attachment-api.js';
import { createHostLocalSettingsApi } from './local-settings-api.js';
import { createHostLocalTerminalHistoryApi } from './local-terminal-history-api.js';
import { createHostLocalGatewayUserMapApi } from './local-gateway-user-map-api.js';
import { createHostLocalChannelPersistenceApi } from './local-channel-persistence-api.js';
import { createHostLocalAgentProfileApi } from './local-agent-profile-api.js';
import { createHostLocalGatewayDirectoryApi } from './local-gateway-directory-api.js';
import { createHostLocalGatewayAllowlistApi } from './local-gateway-allowlist-api.js';
import { createHostLocalGatewayMessageMirrorApi } from './local-gateway-message-mirror-api.js';
import { createHostLocalGatewayThreadApi } from './local-gateway-thread-api.js';
import { createHostLocalSendMessageStateApi } from './local-send-message-state-api.js';
import { createHostLocalModelCapabilityApi } from './local-model-capability-api.js';
import { createHostLocalProviderModelCapabilityApi } from './local-provider-model-capability-api.js';
import { createHostLocalProviderCatalogApi } from './local-provider-catalog-api.js';
import { createHostLocalAppConnectionApi } from './local-app-connection-api.js';
import { createHostLocalPluginSetupApi } from './local-plugin-setup-api.js';
import { createHostPluginAppInstanceApi } from './local-plugin-app-instance-api.js';
import { createHostPluginAppInvocationApi, type HostPluginAppInvocationAuthority } from './local-plugin-app-invocation-api.js';
import { createHostPluginAppGrantApi } from './local-plugin-app-grant-api.js';
import { createHostPluginAppGrantAuthority } from './local-plugin-app-grant-authority.js';
import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';
import { createHostLocalSidebarSectionsApi } from './local-sidebar-sections-api.js';
import { createHostLocalUsageApi } from './local-usage-api.js';
import { createHostLocalImportBatchApi } from './local-import-batch-api.js';
import { createHostLocalTurnReviewApi } from './local-turn-review-api.js';
import { createHostLocalMailboxApi } from './local-mailbox-api.js';
import { createHostLocalPendingWakeApi } from './local-pending-wakes-api.js';
import { createHostWorkflowRunApi } from './workflow-run-api.js';
import { createHostGoalApi } from './goal-api.js';
import { createHostModeStateApi } from './mode-state-api.js';
import { createHostTaskApi } from './task-api.js';
import { createHostProjectApi } from './project-api.js';
import { createHostPermissionRequestApi } from './permission-request-api.js';
import { createHostToolApprovalApi } from './tool-approval-api.js';
import { createHostLockApi } from './lock-api.js';
import { createHostRunApi } from './run-api.js';
import { createHostResearchApi } from './research-api.js';
import { createHostWorkspaceLifecycleApis } from './workspace-lifecycle-api.js';
import { createDatabaseWorkspaceAccess } from './workspace-access.js';
import { HostRunExecutionController } from './run-execution.js';
import { createHostWorkerDbBridge } from './worker-db-bridge.js';
import { resolveProvider } from './worker-config/file-config.js';
import type { HostRunExecutionLogger } from './run-execution.js';

const HOST = '127.0.0.1';
const DEFAULT_PORT = 0;
const SLUG_SHORT_LENGTH = 4;
const SLUG_LONG_LENGTH = 6;

function fnv1a32Hex(input: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(16).padStart(8, '0');
}

/** Migration 58 adapter; kept local so standalone Host startup loads in Node. */
function deriveConnectionSlug(connectionId: string, takenSlugs: ReadonlySet<string>): string {
  const full = fnv1a32Hex(connectionId);
  const short = full.slice(0, SLUG_SHORT_LENGTH);
  if (!takenSlugs.has(short)) return short;
  const long = full.slice(0, SLUG_LONG_LENGTH);
  if (!takenSlugs.has(long)) return long;
  for (let salt = 1; salt < 64; salt += 1) {
    const candidate = fnv1a32Hex(`${connectionId}:${salt}`).slice(0, SLUG_LONG_LENGTH);
    if (!takenSlugs.has(candidate)) return candidate;
  }
  let salt = 64;
  while (true) {
    const candidate = fnv1a32Hex(`${connectionId}:${salt}`);
    if (!takenSlugs.has(candidate)) return candidate;
    salt += 1;
  }
}

export interface LocalHostRuntime {
  readonly apiVersion: 1;
  readonly host: typeof HOST;
  readonly port: number;
  readonly token: string;
  readonly pid: number;
  readonly startedAt: number;
}

export interface StartLocalHostOptions {
  readonly dataRoot?: string;
  readonly databasePath?: string;
  readonly rolloutRoot?: string;
  readonly attachmentsRoot?: string;
  readonly runtimeFilePath?: string;
  readonly port?: number;
  readonly token?: string;
  readonly sqlite?: SqliteCtor;
  readonly workspaces?: HostWorkspaceAccess;
  /**
   * Worker entry the Host-owned execution controller spawns (plan 12 gate 3).
   * Absent keeps the Host a ledger-only composition; present, `duya serve`
   * starts and supervises real runs through the same WorkerManager the Desktop
   * Agent Server uses.
   */
  readonly workerPath?: string;
  /** Trusted Desktop-owned installed-manifest and grant resolver; omitted fails Plugin App binding closed. */
  readonly pluginAppInvocationAuthority?: HostPluginAppInvocationAuthority;
  /**
   * Trusted installed-manifest resolution. Combined with the Host's own
   * durable grant ledger it composes the default Plugin App authority, so
   * the grant API and the invocation API consume one authorization source.
   */
  readonly pluginAppManifestResolver?: (
    pluginId: string,
    appId: string,
  ) => Promise<PluginAppDefinition | null>;
  /** better-sqlite3 directory for the worker environment; defaults to ./node_modules. */
  readonly betterSqlite3Path?: string;
  /**
   * When true, the Host does not write a runtime descriptor file and does not
   * acquire a process lock. Suitable for short-lived embedded use (e.g. `duya tui`).
   * The caller owns the Host lifecycle; process exit is the only clean shutdown.
   */
  readonly ephemeral?: boolean;
  /**
   * Where run diagnostics go. Defaults to `file` when `ephemeral` is set and
   * `stdio` otherwise — an embedded Host shares a terminal with someone else's
   * UI and must not write to it. See `host-diagnostics-log.ts`.
   */
  readonly diagnostics?: HostDiagnosticsSink;
}

export interface LocalHostHandle {
  readonly origin: string;
  readonly port: number;
  /** Defined when the Host was started with a stable token; undefined in ephemeral mode. */
  readonly token?: string;
  readonly runtimeFilePath: string;
  /**
   * Where run diagnostics are being written, when they go to a file. An
   * embedded caller (the TUI) reads this so anything else that logs to the
   * console can be diverted to the same place instead of onto the screen.
   */
  readonly diagnosticsLogPath?: string;
  close(): Promise<void>;
}

interface StorageSettings {
  readonly databasePath?: string;
  readonly rolloutRoot?: string;
  readonly attachmentsRoot?: string;
}

function stringSetting(storage: Record<string, unknown>, key: string): string | undefined {
  const value = storage[key];
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStorageSettings(dataRoot: string): StorageSettings {
  try {
    const configPath = path.join(dataRoot, 'config.toml');
    if (!fs.existsSync(configPath)) return {};
    const parsed: unknown = parse(fs.readFileSync(configPath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
    const storage = (parsed as Record<string, unknown>).storage;
    if (!storage || typeof storage !== 'object' || Array.isArray(storage)) return {};
    const values = storage as Record<string, unknown>;
    const databasePath = stringSetting(values, 'database_path');
    const rolloutRoot = stringSetting(values, 'rollout_root');
    const attachmentsRoot = stringSetting(values, 'attachments_root');
    return {
      ...(databasePath ? { databasePath } : {}),
      ...(rolloutRoot ? { rolloutRoot } : {}),
      ...(attachmentsRoot ? { attachmentsRoot } : {}),
    };
  } catch {
    // Match Desktop's early-boot policy: malformed or unreadable config falls back to defaults.
    return {};
  }
}

function previousElectronDatabasePath(): string | undefined {
  if (process.env.DUYA_TEST === '1') return undefined;
  const home = os.homedir();
  let userDataRoot: string;
  if (process.platform === 'win32') {
    userDataRoot = path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'DUYA');
  } else if (process.platform === 'darwin') {
    userDataRoot = path.join(home, 'Library', 'Application Support', 'DUYA');
  } else {
    userDataRoot = path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'DUYA');
  }
  return path.join(userDataRoot, 'databases', 'duya-main.db');
}

function samePath(left: string, right: string): boolean {
  const a = path.resolve(left);
  const b = path.resolve(right);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

function moveRolloutFiles(sourceRoot: string, destinationRoot: string): void {
  const sourceSessions = path.join(sourceRoot, 'sessions');
  const destinationSessions = path.join(destinationRoot, 'sessions');
  if (samePath(sourceSessions, destinationSessions) || !fs.existsSync(sourceSessions)) return;

  const walk = (source: string, destination: string): void => {
    for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
      const sourcePath = path.join(source, entry.name);
      const destinationPath = path.join(destination, entry.name);
      if (entry.isDirectory()) {
        walk(sourcePath, destinationPath);
        try { fs.rmdirSync(sourcePath); } catch { /* Keep non-empty or concurrently-created directories. */ }
      } else if (entry.isFile() && !fs.existsSync(destinationPath)) {
        fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
        fs.copyFileSync(sourcePath, destinationPath);
        fs.unlinkSync(sourcePath);
      }
    }
  };
  walk(sourceSessions, destinationSessions);
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readPid(filePath: string): number | null {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const pid = (parsed as Record<string, unknown>).pid;
    return typeof pid === 'number' && Number.isSafeInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function acquireHostLock(runtimeDirectory: string): string {
  fs.mkdirSync(runtimeDirectory, { recursive: true });
  const lockPath = path.join(runtimeDirectory, 'host.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let created = false;
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      created = true;
      try {
        fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: Date.now() }));
      } finally {
        fs.closeSync(fd);
      }
      return lockPath;
    } catch (error) {
      if (created) {
        try { fs.unlinkSync(lockPath); } catch { /* Best-effort cleanup of our incomplete lock. */ }
      }
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const pid = readPid(lockPath);
      if (pid === null) throw new Error('Duya Host lock is unreadable; inspect runtime/host.lock before starting another Host');
      if (isPidAlive(pid)) throw new Error(`Duya Host is already running (pid ${pid})`);
      fs.unlinkSync(lockPath);
    }
  }
  throw new Error('Could not acquire the Duya Host process lock');
}

function writeRuntimeFile(filePath: string, runtime: LocalHostRuntime): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporaryPath = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(runtime), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
    fs.renameSync(temporaryPath, filePath);
  } catch (error) {
    try { fs.unlinkSync(temporaryPath); } catch { /* Best-effort cleanup. */ }
    throw error;
  }
}

function removeOwnedFile(filePath: string, matches: (value: Record<string, unknown>) => boolean): void {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && matches(parsed as Record<string, unknown>)) {
      fs.unlinkSync(filePath);
    }
  } catch {
    // A concurrently replaced or removed runtime file belongs to its current owner.
  }
}

/** Start a local, Electron-free Host process composition over @duya/data. */
export async function startLocalHost(options: StartLocalHostOptions = {}): Promise<LocalHostHandle> {
  const dataRoot = path.resolve(options.dataRoot ?? resolveDataRoot());
  const settings = readStorageSettings(dataRoot);
  const previousDefaultPath = previousElectronDatabasePath();
  const configuredDatabasePath = options.databasePath ?? settings.databasePath;
  const configStillPinsPreviousDefault =
    options.databasePath === undefined &&
    settings.databasePath !== undefined &&
    previousDefaultPath !== undefined &&
    samePath(settings.databasePath, previousDefaultPath);
  const explicitDatabasePath = configStillPinsPreviousDefault ? undefined : configuredDatabasePath;
  const databasePath = explicitDatabasePath ? path.resolve(explicitDatabasePath) : undefined;
  const paths = resolveDatabasePaths({ dataRoot, ...(databasePath ? { databasePath } : {}) });
  const rolloutRoot = path.resolve(options.rolloutRoot ?? settings.rolloutRoot ?? dataRoot);
  const attachmentsRoot = path.resolve(options.attachmentsRoot ?? settings.attachmentsRoot ?? path.join(dataRoot, 'attachments'));
  const runtimeFilePath = path.resolve(options.runtimeFilePath ?? path.join(dataRoot, 'runtime', 'host-api.json'));
  const lockPath = options.ephemeral ? '' : acquireHostLock(path.dirname(runtimeFilePath));
  const databaseHost = new DatabaseHost();
  let server: HostSessionHttpServer | null = null;
  let runtime: LocalHostRuntime | null = null;

  try {
    const previousPath = explicitDatabasePath ? undefined : previousDefaultPath;
    if (previousPath && !samePath(previousPath, paths.mainDatabasePath)) {
      migratePreviousDefaultDatabases(previousPath, paths.mainDatabasePath);
      moveRolloutFiles(path.dirname(previousPath), rolloutRoot);
    }
    moveRolloutFiles(path.dirname(paths.mainDatabasePath), rolloutRoot);

    const mainDatabase = databaseHost.openMainDatabase({
      filename: paths.mainDatabasePath,
      ...(options.sqlite ? { sqlite: options.sqlite } : {}),
      ports: { deriveConnectionSlug },
    });
    const core = databaseHost.openCoreDatabase({
      filename: paths.coreDatabasePath,
      rolloutRoot,
      attachmentsRoot,
      ...(options.sqlite ? { sqlite: options.sqlite } : {}),
      messageLogPorts: {
        botSessionIdPrefix: 'bot:',
        parseBotSessionId: parseAgentIdFromBotSession,
        getBotSessionsDir,
        getBotSessionLogPath,
      },
    });

    const importer = new LegacyImport({ ...core.stores, coreDb: core.database }, paths.mainDatabasePath, options.sqlite);
    if (importer.needsImport()) importer.run();

    const workspaceAccess = options.workspaces ?? createDatabaseWorkspaceAccess(core.database.db, core.stores.workspaces);
    const settings = new MainSettingsStore(mainDatabase.db);
    const turnReviews = new ChatTurnReviewStore(mainDatabase.db);
    const api = createHostSessionApi({
      stores: core.stores,
      rolloutRoot,
      chatTurnReviews: turnReviews,
      permissionSettings: settings,
      workspaceDatabase: core.database.db,
      workspaces: workspaceAccess,
      // A session created without a provider/model records the ones
      // config.toml actually selects, instead of the schema placeholders
      // (`''` and `'env'`) that a client would then render as "env · default".
      // The data root is passed explicitly rather than letting resolveProvider
      // re-derive it, so an injected `dataRoot` (tests, embedding) governs the
      // config location too instead of silently reading the real ~/.duya.
      defaultModelProvider: () => {
        const resolution = resolveProvider(undefined, dataRoot);
        return resolution.ok
          ? {
              model: resolution.provider.model.model,
              providerId: resolution.provider.id,
              ...(resolution.provider.model.warning === undefined
                ? {}
                : { warning: resolution.provider.model.warning }),
            }
          : null;
      },
    });
    const localAttachmentApi = createHostLocalAttachmentApi({
      stores: core.stores,
      legacyAttachments: new MainAttachmentStore(mainDatabase.db),
    });
    const workspaceApi = createHostWorkspaceRegistrationApi(workspaceAccess);
    const token = options.token ?? randomBytes(32).toString('base64url');

    // Host-owned execution (plan 12 gate 3): when a worker entry is available,
    // compose the run execution controller over the SAME stores the ledger
    // APIs serve, and hand it to the HTTP server. Without it the Host stays a
    // ledger-only composition.
    const goalApi = createHostGoalApi(core.stores);
    const modeStateApi = createHostModeStateApi(core.stores);
    const taskApi = createHostTaskApi(core.stores);
    const lockApi = createHostLockApi(core.stores);
    // ONE instance per API, shared by the HTTP surface and the worker db
    // bridge: the bridge must answer the same rows the HTTP surface does,
    // and two instances over one store would be two answers to the same
    // question.
    const localMailboxApi = createHostLocalMailboxApi(core.stores.mailbox);
    const localPluginSetupApi = createHostLocalPluginSetupApi(new PluginSetupStore(mainDatabase.db));
    // The same rule for the domains the worker writes through the bridge:
    // one instance per API, shared by the HTTP surface and the bridge.
    const localTurnReviewApi = createHostLocalTurnReviewApi(turnReviews);
    const localSendMessageStateApi = createHostLocalSendMessageStateApi(new SendMessageStateStore(mainDatabase.db));
    const workflowRunApi = createHostWorkflowRunApi(core.stores);
    const pluginAppInstanceApi = createHostPluginAppInstanceApi(core.stores.appInstances);
    // One authorization source for both Plugin App APIs. An injected
    // authority wins; otherwise the Host composes one from its own durable
    // grant ledger and the trusted manifest resolver.
    const pluginAppAuthority = options.pluginAppInvocationAuthority ??
      (options.pluginAppManifestResolver === undefined
        ? undefined
        : createHostPluginAppGrantAuthority({
          store: core.stores.appGrants,
          resolveApp: options.pluginAppManifestResolver,
        }));
    let runExecution: HostRunExecutionController | null = null;
    const pluginAppGrantApi = createHostPluginAppGrantApi({
      store: core.stores.appGrants,
      ...(pluginAppAuthority === undefined ? {} : { authority: pluginAppAuthority }),
    });
    const pluginAppInvocationApi = createHostPluginAppInvocationApi({
      getInstance: (instanceId) => pluginAppInstanceApi.getPluginAppInstance(instanceId),
      ...(pluginAppAuthority === undefined
        ? {}
        : { authority: pluginAppAuthority }),
      currentRun: async (sessionId) => runExecution?.currentSessionAttempt(sessionId) ?? null,
      isCurrentRun: async (sessionId, runId, epoch) =>
        runExecution?.isCurrentSessionAttempt(sessionId, runId, epoch) ?? false,
      worker: {
        describeMcpTools: async (input) => {
          if (!runExecution) throw new Error('Host run execution is unavailable.');
          return runExecution.describePluginAppMcpTools(input);
        },
        invokeMcpTool: async (input) => {
          if (!runExecution) throw new Error('Host run execution is unavailable.');
          return runExecution.invokePluginAppMcpTool(input);
        },
      },
    });
    const diagnosticsSink = resolveDiagnosticsSink({
      ...(options.ephemeral === undefined ? {} : { ephemeral: options.ephemeral }),
      ...(options.diagnostics === undefined ? {} : { diagnostics: options.diagnostics }),
    });
    if (options.workerPath !== undefined) {
      const executionLogger: HostRunExecutionLogger =
        diagnosticsSink === 'file'
          ? createFileDiagnosticsLogger(resolveHostDiagnosticsLogPath(dataRoot))
          : createStdioDiagnosticsLogger();
      const sessionService = createHostSessionService({
        sessions: api,
        runs: createHostRunApi(core.stores),
        execution: {
          startAgentRun: (input, caller) => {
            if (!runExecution) throw new Error('Host run execution is not ready.');
            return runExecution.startAgentRun(input, caller);
          },
          cancelAgentRun: (runId, reason) => {
            if (!runExecution) throw new Error('Host run execution is not ready.');
            return runExecution.cancelAgentRun(runId, reason);
          },
        },
        readLocalSession: async (id) => core.stores.sessions.get(id),
        validateCaller: (caller) => {
          if (!runExecution) throw new Error('Host run execution is not ready.');
          runExecution.validateSessionCaller(caller);
        },
      });
      runExecution = new HostRunExecutionController({
        runs: core.stores.runs,
        permissionRequests: createHostPermissionRequestApi(core.stores),
        sessionDefaults: async (sessionId) => {
          const row = core.stores.sessions.get(sessionId);
          if (row === null) return null;
          const workingDirectory =
            row.workingDirectory !== '' ? row.workingDirectory : dataRoot;
          // A spawned session INHERITS its parent's permission mode, and that
          // inherited mode is the ceiling for the child's turns: a turn in the
          // child may narrow it, never widen it. The ceiling is read from the
          // parent session's own row, so it moves with the parent instead of
          // being copied at spawn time and going stale.
          const parent = row.parentSessionId === null
            ? null
            : core.stores.sessions.get(row.parentSessionId);
          return {
            workingDirectory,
            ...(row.model !== '' ? { model: row.model } : {}),
            ...(row.providerId !== '' ? { providerId: row.providerId } : {}),
            ...(row.agentProfileId === null ? {} : { agentProfileId: row.agentProfileId }),
            // The session's own permission mode, translated by the
            // repository's bridge rather than by a second mapping here: the
            // worker resolves the same row through the same function, so the
            // manifest and the run agree without a second answer to the same
            // question.
            permissionMode: manifestPermissionMode(profileToAgentMode(row.permissionMode)),
            ...(parent === null
              ? {}
              : { parentPermissionMode: manifestPermissionMode(profileToAgentMode(parent.permissionMode)) }),
          };
        },
        bridge: createHostWorkerDbBridge({
          sessionService,
          runs: core.stores.runs,
          sessions: core.stores.sessions,
          settings,
          mainDatabase,
          timeline: api,
          localSessions: {
            readLocalSession: (sessionId) =>
              Promise.resolve(core.stores.sessions.get(sessionId)),
          },
          imageAttachmentsForSession: (sessionId) =>
            localAttachmentApi.getImageAttachmentsForSession(sessionId),
          goalApi,
          lockApi,
          modeStateApi,
          taskApi,
          pluginAppInvocationApi,
          mailboxApi: localMailboxApi,
          pluginSetupApi: localPluginSetupApi,
          workflowRunApi,
          turnReviewApi: localTurnReviewApi,
          attachmentApi: localAttachmentApi,
          sendMessageStateApi: localSendMessageStateApi,
          logger: executionLogger,
        }),
        logger: executionLogger,
        worker: {
          resolveWorkerPath: () => options.workerPath as string,
          resolveBetterSqlite3Path: () =>
            options.betterSqlite3Path ?? path.join(process.cwd(), 'node_modules', 'better-sqlite3'),
        },
      });
    }

    // Plan 621: the checkout / integration namespaces, assembled once so the
    // headless Host and the Desktop's embedded Host answer the same way.
    const workspaceLifecycle = createHostWorkspaceLifecycleApis({
      sessions: core.stores.sessions,
      runs: core.stores.runs,
      integrations: core.stores.integrations,
    });

    server = new HostSessionHttpServer({
      api,
      localSessionApi: createHostLocalSessionApi({ stores: core.stores, sessions: api }),
      localRolloutApi: createHostLocalRolloutApi({ stores: core.stores, sessions: api, rolloutRoot }),
  // The dedicated read, so `workspace_filesystem` has a channel whose job is
  // reading a file rather than restoring a transcript through it.
  workspaceFileApi: createHostLocalWorkspaceFileApi({ workspaces: workspaceAccess }),
      localAttachmentApi,
      localSettingsApi: createHostLocalSettingsApi(settings),
      localTerminalHistoryApi: createHostLocalTerminalHistoryApi(new TerminalHistoryStore(mainDatabase.db)),
      localGatewayUserMapApi: createHostLocalGatewayUserMapApi(new GatewayUserMapStore(mainDatabase.db)),
      localChannelPersistenceApi: createHostLocalChannelPersistenceApi(new ChannelPersistenceStore(mainDatabase.db)),
      localAgentProfileApi: createHostLocalAgentProfileApi(new AgentProfileStore(mainDatabase.db)),
      localGatewayDirectoryApi: createHostLocalGatewayDirectoryApi(new GatewayChannelDirectoryStore(mainDatabase.db)),
      localGatewayAllowlistApi: createHostLocalGatewayAllowlistApi(new GatewayAllowlistStore(mainDatabase.db)),
      localGatewayMessageMirrorApi: createHostLocalGatewayMessageMirrorApi(new GatewayMessageMirrorStore(mainDatabase.db)),
      localGatewayThreadApi: createHostLocalGatewayThreadApi(new GatewayThreadStore(mainDatabase.db)),
      localSendMessageStateApi,
      localModelCapabilityApi: createHostLocalModelCapabilityApi(new ModelCapabilityStore(mainDatabase.db)),
      localProviderModelCapabilityApi: createHostLocalProviderModelCapabilityApi(
        new ProviderModelCapabilityStore(mainDatabase.db),
      ),
      localProviderCatalogApi: createHostLocalProviderCatalogApi(),
      localAppConnectionApi: createHostLocalAppConnectionApi(
        new AppConnectionStore(mainDatabase.db, deriveConnectionSlug),
      ),
      localPluginSetupApi,
      pluginAppInstanceApi,
      pluginAppInvocationApi,
      pluginAppGrantApi,
      localSidebarSectionsApi: createHostLocalSidebarSectionsApi(new SidebarSectionsStore(mainDatabase.db)),
      localUsageApi: createHostLocalUsageApi({
        stores: core.stores,
        pricing: new ProviderModelPricingStore(mainDatabase.db),
      }),
      localImportBatchApi: createHostLocalImportBatchApi(new ImportBatchStore(mainDatabase.db)),
      localTurnReviewApi,
      localMailboxApi,
      localPendingWakeApi: createHostLocalPendingWakeApi(core.stores.wakes),
      workflowRunApi,
      runApi: createHostRunApi(core.stores),
      ...(runExecution === undefined || runExecution === null ? {} : { runExecutionApi: runExecution }),
      goalApi,
      modeStateApi,
      taskApi,
      projectApi: createHostProjectApi(core.stores.projects),
      researchApi: createHostResearchApi(core.stores),
      permissionRequestApi: runExecution?.permissionRequests ?? createHostPermissionRequestApi(core.stores),
      toolApprovalApi: createHostToolApprovalApi(mainDatabase.db),
      lockApi,
      workspaceApi,
      // Plan 621: the checkout / integration namespaces are assembled in ONE
      // place (`createHostWorkspaceLifecycleApis`) because the Desktop's
      // embedded Host serves the same routes and must answer the same way.
      ...workspaceLifecycle,
      host: HOST,
      port: options.port ?? DEFAULT_PORT,
      token,
    });
    await server.listen();
    runtime = {
      apiVersion: 1,
      host: HOST,
      port: server.port,
      token,
      pid: process.pid,
      startedAt: Date.now(),
    };
    if (!options.ephemeral) writeRuntimeFile(runtimeFilePath, runtime);

    let closed = false;
    return {
      origin: `http://${HOST}:${server.port}`,
      port: server.port,
      token: runtime?.token,
      runtimeFilePath,
      ...(diagnosticsSink === 'file'
        ? { diagnosticsLogPath: resolveHostDiagnosticsLogPath(dataRoot) }
        : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        try {
          await server?.close();
        } finally {
          // Stop supervised workers before the database handles they were
          // writing through the bridge disappear underneath them.
          try {
            try {
              await runExecution?.permissionRequests?.closeAll();
            } finally {
              runExecution?.supervision.workerManager.stopIdleReaper();
              runExecution?.supervision.workerManager.killAll();
            }
          } catch {
            // A worker that already exited is not a shutdown failure.
          }
          if (!options.ephemeral) {
            removeOwnedFile(runtimeFilePath, (value) => value.pid === process.pid && value.token === runtime?.token);
            removeOwnedFile(lockPath, (value) => value.pid === process.pid);
          }
          databaseHost.close();
        }
      },
    };
  } catch (error) {
    try { await server?.close(); } finally {
      databaseHost.close();
      if (!options.ephemeral) removeOwnedFile(lockPath, (value) => value.pid === process.pid);
    }
    throw error;
  }
}

export async function readLocalHostRuntime(dataRoot = resolveDataRoot()): Promise<LocalHostRuntime | null> {
  const filePath = path.join(dataRoot, 'runtime', 'host-api.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.promises.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`Could not read Duya Host runtime descriptor: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Duya Host runtime descriptor is malformed');
  }
  const value = parsed as Record<string, unknown>;
  if (
    value.apiVersion !== 1 || value.host !== HOST ||
    typeof value.port !== 'number' || !Number.isInteger(value.port) || value.port < 1 || value.port > 65535 ||
    typeof value.token !== 'string' || value.token.length === 0 ||
    typeof value.pid !== 'number' || !Number.isSafeInteger(value.pid) || value.pid < 1 ||
    typeof value.startedAt !== 'number' || !Number.isSafeInteger(value.startedAt)
  ) {
    throw new Error('Duya Host runtime descriptor has invalid fields');
  }
  return isPidAlive(value.pid) ? value as unknown as LocalHostRuntime : null;
}
