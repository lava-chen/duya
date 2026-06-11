/**
 * electron/cli/cli-api-server.ts
 *
 * Localhost HTTP server for the duya CLI control plane.
 *
 * - Binds 127.0.0.1 only, on an OS-assigned port via `server.listen(0)`.
 * - Bearer-token authenticated (see ./auth.ts). Token is generated at start.
 * - On successful listen, writes { port, token, pid, startedAt } to
 *   userData/runtime/cli-api.json atomically (see ./runtime-config.ts).
 * - On stop, closes the server and removes the runtime file.
 *
 * Endpoints (Phase 0):
 *   GET /v1/status
 *   GET /v1/plugins
 *   GET /v1/plugins/:name
 *
 * The server is a thin HTTP adapter — every handler delegates to existing
 * domain services (e.g. PluginManager). No business logic is implemented here.
 */

import * as http from 'http';
import { generateToken, checkBearer } from './auth';
import { writeCliApiRuntime, removeCliApiRuntime } from './runtime-config';
import { handleStatus } from './handlers/status.js';
import { handleListPlugins, handleGetPlugin, handleEnablePlugin, handleDisablePlugin, handlePluginDoctor, handleInstallPlugin, handleUninstallPlugin, handleUpdatePlugin } from './handlers/plugins.js';
import {
  handleListSessions,
  handleGetSession,
  handleSearchSessions,
  handleExportSession,
  handleImportSession,
  parseQuery as parseSessionsQuery,
} from './handlers/sessions.js';
import { handleListSkills, handleGetSkill } from './handlers/skills.js';
import { handleListMCPs, handleGetMCP, handleAddMCP, handleRemoveMCP, handleAssignMCP } from './handlers/mcps.js';
import { handleListProviders, handleGetProvider, handleGetActiveProvider } from './handlers/providers.js';
import { handleEnableSkill, handleDisableSkill } from './handlers/skillWrite.js';
import { handleInstallCli, handleUninstallCli } from './handlers/install.js';
import {
  handleListConfigProviders,
  handleGetConfigProvider,
  handleAddConfigProvider,
  handleRemoveConfigProvider,
  handleActivateConfigProvider,
  handleSetDefaultConfigProvider,
  handleGetAgentSettings,
  handleSetAgentSettings,
  handleGetVisionSettings,
  handleSetVisionSettings,
  handleListOutputStyles,
  handleSetOutputStyle,
  handleListPairing,
  handleApprovePairing,
  handleRevokePairing,
  handleCheckPairing,
  handleConfigKvSet,
  handleConfigKvGet,
  handleConfigKvUnset,
  handleConfigValidate,
} from './handlers/config.js';
import {
  handleListChannels,
  handleGetChannel,
  handleListPlatforms,
  handlePlatformStatus,
} from './handlers/channels.js';
import {
  handleListCrons,
  handleGetCron,
  handleListCronRuns,
  handleCreateCron,
  handleUpdateCron,
  handleDeleteCron,
  handleRunCron,
} from './handlers/crons.js';
import {
  handleListMessages,
  handleGetMessage,
  handleMessageCount,
  parseListMessagesQuery,
} from './handlers/messages.js';
import {
  handleGetGateway,
  handleStartGateway,
  handleStopGateway,
  handleRestartGateway,
} from './handlers/gateway.js';
import {
  handleGetUpdateStatus,
  handleUpdateCheck,
  handleUpdateDownload,
  handleUpdateInstall,
} from './handlers/update.js';
import {
  handleBackupPlan,
  handleBackupCreate,
  handleBackupVerify,
  handleBackupRestore,
} from './handlers/backup.js';
import { handleSecurityAudit, handleSecurityFix } from './handlers/security.js';
import {
  handleSendMessage,
  handleMCPTest,
  handleSkillInstall,
  handleSkillUninstall,
  handleSkillSync,
  handleChannelTest,
  handleChannelSendTest,
} from './handlers/extra.js';
import {
  handleCronEnable,
  handleCronDisable,
  handleCronLogs,
  handleGatewayReloadSecrets,
  handleGatewayRpc,
} from './handlers/extra2.js';
import { InvalidPaginationParam } from '../db/queries/sessions';
import { getLogger } from '../logging/logger';

const COMPONENT = 'CliApiServer' as const;

let server: http.Server | null = null;
let startedAt = 0;
let currentToken = '';

function sendJsonError(res: http.ServerResponse, status: number, code: string, message: string): void {
  const body = JSON.stringify({ error: { code, message } });
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function parsePath(url: string): { pathname: string; parts: string[] } {
  const pathname = url.split('?')[0] || '/';
  const parts = pathname.split('/').filter(Boolean);
  return { pathname, parts };
}

function route(req: http.IncomingMessage, res: http.ServerResponse): void {
  // Auth check first — every endpoint requires Bearer.
  if (!checkBearer(req.headers.authorization, currentToken)) {
    sendJsonError(res, 401, 'unauthorized', 'Missing or invalid bearer token');
    return;
  }

  const { parts } = parsePath(req.url ?? '/');

  // /v1/status
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'status') {
    handleStatus(req, res, startedAt);
    return;
  }

  // /v1/plugins
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'plugins') {
    handleListPlugins(req, res);
    return;
  }

  // /v1/sessions
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'sessions') {
    try {
      handleListSessions(req, res, parseSessionsQuery(req.url));
    } catch (err) {
      if (err instanceof InvalidPaginationParam) {
        sendJsonError(res, 400, `invalid_${err.param}`, err.reason);
        return;
      }
      throw err;
    }
    return;
  }

  // /v1/sessions/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions') {
    handleGetSession(req, res, parts[2]);
    return;
  }

  // GET /v1/sessions/search?q=...
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[2] === 'search') {
    handleSearchSessions(req, res);
    return;
  }

  // POST /v1/sessions/export
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[2] === 'export') {
    void handleExportSession(req, res);
    return;
  }

  // POST /v1/sessions/import
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[2] === 'import') {
    void handleImportSession(req, res);
    return;
  }

  // /v1/plugins/:name
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'plugins') {
    handleGetPlugin(req, res, parts[2]);
    return;
  }

  // POST /v1/plugins/:id/enable
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'plugins' && parts[3] === 'enable') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    handleEnablePlugin(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // POST /v1/plugins/:id/disable
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'plugins' && parts[3] === 'disable') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    handleDisablePlugin(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // GET /v1/plugins/doctor
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'plugins' && parts[2] === 'doctor') {
    handlePluginDoctor(req, res);
    return;
  }

  // POST /v1/plugins/install (Plan 200 P4)
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'plugins' && parts[2] === 'install') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleInstallPlugin(req, res, correlationId);
    return;
  }

  // POST /v1/plugins/:id/uninstall
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'plugins' && parts[3] === 'uninstall') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleUninstallPlugin(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // POST /v1/plugins/:id/update
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'plugins' && parts[3] === 'update') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleUpdatePlugin(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // /v1/skills
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'skills') {
    handleListSkills(req, res);
    return;
  }

  // /v1/skills/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'skills') {
    handleGetSkill(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // POST /v1/skills/:id/enable
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'skills' && parts[3] === 'enable') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    handleEnableSkill(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // POST /v1/skills/:id/disable
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'skills' && parts[3] === 'disable') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    handleDisableSkill(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // /v1/mcps
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'mcps') {
    handleListMCPs(req, res);
    return;
  }

  // /v1/mcps/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'mcps') {
    handleGetMCP(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // /v1/providers
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'providers') {
    handleListProviders(req, res);
    return;
  }

  // /v1/providers/active
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'providers' && parts[2] === 'active') {
    handleGetActiveProvider(req, res);
    return;
  }

  // /v1/providers/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'providers') {
    handleGetProvider(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // POST /v1/install-cli
  if (req.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'install-cli') {
    handleInstallCli(req, res);
    return;
  }

  // POST /v1/uninstall-cli
  if (req.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'uninstall-cli') {
    handleUninstallCli(req, res);
    return;
  }

  // ============================================================================
  // Plan 99 P3: channels / crons / messages handlers
  // ============================================================================

  // GET /v1/channels?platform=…
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'channels') {
    const url = req.url ?? '/';
    const qIdx = url.indexOf('?');
    let platform: string | undefined;
    if (qIdx >= 0) {
      for (const part of url.slice(qIdx + 1).split('&')) {
        const eq = part.indexOf('=');
        const key = eq >= 0 ? part.slice(0, eq) : part;
        const val = eq >= 0 ? part.slice(eq + 1) : '';
        if (key === 'platform' && val) platform = decodeURIComponent(val);
      }
    }
    handleListChannels(req, res, platform);
    return;
  }

  // GET /v1/channels/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'channels') {
    handleGetChannel(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // GET /v1/platforms
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'platforms') {
    handleListPlatforms(req, res);
    return;
  }

  // GET /v1/platforms/:p/status
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'platforms' && parts[3] === 'status') {
    handlePlatformStatus(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // GET /v1/platforms/status  (all platforms)
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'platforms' && parts[2] === 'status') {
    handlePlatformStatus(req, res, undefined);
    return;
  }

  // GET /v1/crons
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'crons') {
    handleListCrons(req, res);
    return;
  }

  // POST /v1/crons
  if (req.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'crons') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleCreateCron(req, res, correlationId);
    return;
  }

  // GET /v1/crons/:id
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'crons') {
    handleGetCron(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // PATCH /v1/crons/:id
  if (req.method === 'PATCH' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'crons') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleUpdateCron(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // DELETE /v1/crons/:id
  if (req.method === 'DELETE' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'crons') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleDeleteCron(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // POST /v1/crons/:id/run
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'crons' && parts[3] === 'run') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleRunCron(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // GET /v1/crons/:id/runs
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'crons' && parts[3] === 'runs') {
    const query = parseSessionsQuery(req.url); // reuse generic {limit, offset} parser
    handleListCronRuns(req, res, decodeURIComponent(parts[2]), query);
    return;
  }

  // GET /v1/sessions/:id/messages
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[3] === 'messages') {
    const query = parseListMessagesQuery(req.url);
    handleListMessages(req, res, decodeURIComponent(parts[2]), query);
    return;
  }

  // GET /v1/sessions/:id/messages/count
  if (req.method === 'GET' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[3] === 'messages' && parts[4] === 'count') {
    handleMessageCount(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // GET /v1/sessions/:id/messages/:msgId
  if (req.method === 'GET' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'sessions' && parts[3] === 'messages') {
    handleGetMessage(req, res, decodeURIComponent(parts[2]), decodeURIComponent(parts[4]));
    return;
  }

  // ============================================================================
  // Plan 99 G2: gateway lifecycle (status / start / stop / restart)
  // ============================================================================

  // GET /v1/gateway
  if (req.method === 'GET' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'gateway') {
    handleGetGateway(req, res, startedAt);
    return;
  }

  // POST /v1/gateway/start
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'gateway' && parts[2] === 'start') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleStartGateway(req, res, correlationId);
    return;
  }

  // POST /v1/gateway/stop
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'gateway' && parts[2] === 'stop') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleStopGateway(req, res, correlationId);
    return;
  }

  // POST /v1/gateway/restart
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'gateway' && parts[2] === 'restart') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleRestartGateway(req, res, correlationId);
    return;
  }

  // ============================================================================
  // `duya update` — auto-updater control plane
  // ============================================================================

  // GET /v1/update/status
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'update' && parts[2] === 'status') {
    handleGetUpdateStatus(req, res);
    return;
  }

  // POST /v1/update/check
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'update' && parts[2] === 'check') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleUpdateCheck(req, res, correlationId);
    return;
  }

  // POST /v1/update/download
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'update' && parts[2] === 'download') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleUpdateDownload(req, res, correlationId);
    return;
  }

  // POST /v1/update/install
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'update' && parts[2] === 'install') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleUpdateInstall(req, res, correlationId);
    return;
  }

  // ============================================================================
  // `duya backup` — local state archive control plane
  // ============================================================================

  // POST /v1/backup/plan
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'backup' && parts[2] === 'plan') {
    handleBackupPlan(req, res);
    return;
  }

  // POST /v1/backup/create
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'backup' && parts[2] === 'create') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleBackupCreate(req, res, correlationId);
    return;
  }

  // POST /v1/backup/verify
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'backup' && parts[2] === 'verify') {
    void handleBackupVerify(req, res);
    return;
  }

  // POST /v1/backup/restore
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'backup' && parts[2] === 'restore') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleBackupRestore(req, res, correlationId);
    return;
  }

  // ============================================================================
  // `duya security` — read-only audit + auto-fix
  // ============================================================================

  // POST /v1/security/audit
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'security' && parts[2] === 'audit') {
    void handleSecurityAudit(req, res);
    return;
  }

  // POST /v1/security/fix
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'security' && parts[2] === 'fix') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleSecurityFix(req, res, correlationId);
    return;
  }

  // ============================================================================
  // Plan 200 P4.3 — message / mcp / skill / channel extras
  // ============================================================================

  // POST /v1/messages/send
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'messages' && parts[2] === 'send') {
    void handleSendMessage(req, res);
    return;
  }

  // POST /v1/mcps/:name/test
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'mcps' && parts[3] === 'test') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleMCPTest(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // POST /v1/skills/install
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'skills' && parts[2] === 'install') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleSkillInstall(req, res, correlationId);
    return;
  }

  // POST /v1/skills/:id/uninstall
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'skills' && parts[3] === 'uninstall') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleSkillUninstall(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // POST /v1/skills/sync
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'skills' && parts[2] === 'sync') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleSkillSync(req, res, correlationId);
    return;
  }

  // POST /v1/channels/test
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'channels' && parts[2] === 'test') {
    void handleChannelTest(req, res);
    return;
  }

  // POST /v1/channels/send-test
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'channels' && parts[2] === 'send-test') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleChannelSendTest(req, res, correlationId);
    return;
  }

  // ============================================================================
  // Plan 200 P4.4 — cron enable/disable/logs + gateway reload-secrets/rpc
  // ============================================================================

  // POST /v1/crons/:id/enable
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'crons' && parts[3] === 'enable') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleCronEnable(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // POST /v1/crons/:id/disable
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'crons' && parts[3] === 'disable') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleCronDisable(req, res, decodeURIComponent(parts[2]), correlationId);
    return;
  }

  // GET /v1/crons/:id/logs?limit=20
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'crons' && parts[3] === 'logs') {
    handleCronLogs(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // POST /v1/gateway/reload-secrets
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'gateway' && parts[2] === 'reload-secrets') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleGatewayReloadSecrets(req, res, correlationId);
    return;
  }

  // POST /v1/gateway/rpc
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'gateway' && parts[2] === 'rpc') {
    const correlationId = (req.headers['x-correlation-id'] as string | undefined) || undefined;
    void handleGatewayRpc(req, res, correlationId);
    return;
  }

  // ============================================================================
  // Plan 102 — `duya config …` + `mcp add/remove/assign` routes
  // ============================================================================

  // GET /v1/config/providers
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'providers') {
    handleListConfigProviders(req, res);
    return;
  }

  // POST /v1/config/providers
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'providers') {
    void handleAddConfigProvider(req, res);
    return;
  }

  // GET /v1/config/providers/:id
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'providers') {
    handleGetConfigProvider(req, res, decodeURIComponent(parts[3]));
    return;
  }

  // DELETE /v1/config/providers/:id
  if (req.method === 'DELETE' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'providers') {
    void handleRemoveConfigProvider(req, res, decodeURIComponent(parts[3]));
    return;
  }

  // POST /v1/config/providers/:id/activate (deprecated; use PUT /default)
  if (req.method === 'POST' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'providers' && parts[4] === 'activate') {
    void handleActivateConfigProvider(req, res, decodeURIComponent(parts[3]));
    return;
  }

  // PUT /v1/config/providers/:id/default
  if (req.method === 'PUT' && parts.length === 5 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'providers' && parts[4] === 'default') {
    void handleSetDefaultConfigProvider(req, res, decodeURIComponent(parts[3]));
    return;
  }

  // GET /v1/config/settings/agent
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'settings' && parts[3] === 'agent') {
    handleGetAgentSettings(req, res);
    return;
  }

  // PATCH /v1/config/settings/agent
  if (req.method === 'PATCH' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'settings' && parts[3] === 'agent') {
    void handleSetAgentSettings(req, res);
    return;
  }

  // GET /v1/config/settings/vision
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'settings' && parts[3] === 'vision') {
    handleGetVisionSettings(req, res);
    return;
  }

  // PATCH /v1/config/settings/vision
  if (req.method === 'PATCH' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'settings' && parts[3] === 'vision') {
    void handleSetVisionSettings(req, res);
    return;
  }

  // GET /v1/config/output-styles
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'output-styles') {
    handleListOutputStyles(req, res);
    return;
  }

  // POST /v1/config/output-styles
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'output-styles') {
    void handleSetOutputStyle(req, res);
    return;
  }

  // GET /v1/config/pairing
  if (req.method === 'GET' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'pairing') {
    handleListPairing(req, res);
    return;
  }

  // POST /v1/config/pairing/approve
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'pairing' && parts[3] === 'approve') {
    void handleApprovePairing(req, res);
    return;
  }

  // POST /v1/config/pairing/revoke
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'pairing' && parts[3] === 'revoke') {
    void handleRevokePairing(req, res);
    return;
  }

  // GET /v1/config/pairing/check
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'pairing' && parts[3] === 'check') {
    handleCheckPairing(req, res);
    return;
  }

  // ============================================================================
  // Plan 200 P4 — generic config KV (set / get / unset / validate)
  // ============================================================================

  // POST /v1/config/kv/set
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'kv' && parts[3] === 'set') {
    void handleConfigKvSet(req, res);
    return;
  }

  // GET /v1/config/kv/get?key=...
  if (req.method === 'GET' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'kv' && parts[3] === 'get') {
    handleConfigKvGet(req, res);
    return;
  }

  // POST /v1/config/kv/unset
  if (req.method === 'POST' && parts.length === 4 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'kv' && parts[3] === 'unset') {
    void handleConfigKvUnset(req, res);
    return;
  }

  // POST /v1/config/validate
  if (req.method === 'POST' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'config' && parts[2] === 'validate') {
    void handleConfigValidate(req, res);
    return;
  }

  // POST /v1/mcps (Plan 99 §3.3 Phase 7 + Plan 102 — `mcp add`)
  if (req.method === 'POST' && parts.length === 2 && parts[0] === 'v1' && parts[1] === 'mcps') {
    void handleAddMCP(req, res);
    return;
  }

  // DELETE /v1/mcps/:name (`mcp remove`)
  if (req.method === 'DELETE' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'mcps') {
    void handleRemoveMCP(req, res, decodeURIComponent(parts[2]));
    return;
  }

  // PATCH /v1/mcps/:name (`mcp assign`)
  if (req.method === 'PATCH' && parts.length === 3 && parts[0] === 'v1' && parts[1] === 'mcps') {
    void handleAssignMCP(req, res, decodeURIComponent(parts[2]));
    return;
  }

  sendJsonError(res, 404, 'not_found', `No route for ${req.method} ${req.url}`);
}

export interface CliApiServerHandle {
  port: number;
  token: string;
  startedAt: number;
  stop: () => Promise<void>;
}

export async function startCliApiServer(): Promise<CliApiServerHandle> {
  if (server) {
    throw new Error('CLI API server already started');
  }

  const token = generateToken();
  currentToken = token;
  startedAt = Date.now();

  const logger = getLogger();

  server = http.createServer((req, res) => {
    try {
      route(req, res);
    } catch (err) {
      logger.error(
        'CLI API server route error',
        err instanceof Error ? err : new Error(String(err)),
        undefined,
        COMPONENT,
      );
      if (!res.headersSent) {
        sendJsonError(res, 500, 'internal_error', 'Unexpected server error');
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    server!.once('error', (err) => reject(err));
    server!.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('CLI API server failed to obtain a TCP address');
  }
  const port = address.port;

  // Write runtime file atomically AFTER listen succeeds.
  await writeCliApiRuntime({
    port,
    token,
    pid: process.pid,
    startedAt,
  });

  // server.headersTimeout default 60s — keep simple, no overrides for Phase 0.

  logger.info('CLI API server started', { port, pid: process.pid }, COMPONENT);

  return {
    port,
    token,
    startedAt,
    stop: async () => {
      await stopCliApiServer();
    },
  };
}

export async function stopCliApiServer(): Promise<void> {
  if (!server) return;
  const s = server;
  server = null;
  currentToken = '';

  await new Promise<void>((resolve) => {
    s.close(() => resolve());
    // close() releases the port asynchronously; if there are keep-alive
    // connections, force destroy after a short grace period.
    setTimeout(() => {
      s.closeAllConnections?.();
      resolve();
    }, 500);
  });

  await removeCliApiRuntime();
}
