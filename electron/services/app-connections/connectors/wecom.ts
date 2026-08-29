/**
 * WeCom connector — Plan 312 Phase 3 (custom-credential provider).
 *
 * Unlike OAuth providers (google/slack/microsoft365), WeCom authenticates
 * through a self-built enterprise app: an enterprise `corpid` + `corpsecret`
 * (to swap for a short-lived access token) or a bot token. All operations
 * go through the external `wecom-cli` command-line program:
 *
 *   wecom-cli <category> <operation> '<json-params>'
 *
 * WeCom is a single-enterprise credential model: the `corpid`/`corpsecret`
 * are per-provider (stored in the vault's OAuth-client slot keyed by the
 * provider), not per-connection. The connector reads them from the vault and
 * injects them as env vars into the spawned `wecom-cli` child, mirroring the
 * trae wecom plugin's connector env contract:
 *
 *   WECOM_ACCESS_TOKEN / WECOM_BOT_ID / WECOM_SECRET
 *
 * Tokens never leave the main process: the agent only sees descriptors and
 * redacted results through `appConnection:invoke`.
 */

import { spawn } from 'child_process';
import type {
  ConnectorInputSchema,
  ConnectorInvokeResult,
  ConnectorModule,
  ConnectorToolDescriptor,
} from '../connector-types.js';
import type { ProviderId, RiskTier } from '../types.js';
import { asAppConnectorId } from '@duya/plugin-core/src/connectors/app-connector-id.js';
import type { TokenVault } from '../token-vault.js';

const PROVIDER = asAppConnectorId('wecom');

/** Env contract the trae wecom plugin declares for `wecom-cli`. */
const WECOM_ACCESS_TOKEN_ENV = 'WECOM_ACCESS_TOKEN';
const WECOM_BOT_ID_ENV = 'WECOM_BOT_ID';
const WECOM_SECRET_ENV = 'WECOM_SECRET';

/**
 * One tool per WeCom product category. Each maps to a `wecom-cli` subcommand
 * (`wecom-cli <category> <operation> '<json>'`). The agent supplies the
 * operation (interface name, e.g. `get_message`) and an optional JSON params
 * object.
 */
interface WeComCategoryTool {
  category: string;
  description: string;
  summary: string;
  riskTier: RiskTier;
}

const CATEGORY_TOOLS: WeComCategoryTool[] = [
  {
    category: 'contact',
    description: 'Query the WeCom address book (contacts) visible to the current user.',
    summary: 'operation: string (e.g. get_userlist); params?: object. Returns JSON contacts.',
    riskTier: 'read',
  },
  {
    category: 'msg',
    description: 'WeCom messaging: list chats, pull message history, download media, send text.',
    summary: 'operation: string (e.g. get_msg_chat_list/get_message/get_msg_media/send_message); params?: object.',
    riskTier: 'write',
  },
  {
    category: 'doc',
    description: 'WeCom document (doc): create, read as Markdown, overwrite content.',
    summary: 'operation: string (e.g. create_doc/get_doc_content/edit_doc_content); params?: object.',
    riskTier: 'modify',
  },
  {
    category: 'sheet',
    description: 'WeCom online spreadsheet (sheet): create, read, update ranges, append rows, manage sheets.',
    summary: 'operation: string (e.g. create_doc/get_doc_content/sheet_get_info/sheet_update_range_data/sheet_append_data); params?: object.',
    riskTier: 'modify',
  },
  {
    category: 'smartsheet',
    description: 'WeCom smart table (smartsheet): create, manage sheets/fields, CRUD records.',
    summary: 'operation: string (e.g. smartsheet_get_sheet/smartsheet_get_fields/smartsheet_add_records); params?: object.',
    riskTier: 'modify',
  },
  {
    category: 'smartpage',
    description: 'WeCom smart doc (smartpage): publish a local Markdown file as a smart doc, export as Markdown.',
    summary: 'operation: string (e.g. +smartpage_create/smartpage_export_task/smartpage_get_export_result); params?: object.',
    riskTier: 'modify',
  },
  {
    category: 'schedule',
    description: 'WeCom calendar: list/query schedules, create/update/cancel, manage attendees, check availability.',
    summary: 'operation: string (e.g. get_schedule_list_by_range/create_schedule/update_schedule/cancel_schedule/check_availability); params?: object.',
    riskTier: 'modify',
  },
  {
    category: 'meeting',
    description: 'WeCom meetings: create scheduled meetings, list, detail, cancel, update invitees.',
    summary: 'operation: string (e.g. create_meeting/list_user_meetings/get_meeting_info/cancel_meeting/set_invite_meeting_members); params?: object.',
    riskTier: 'modify',
  },
  {
    category: 'todo',
    description: 'WeCom todos: search userid, create/update todos, change user status, list/detail/delete.',
    summary: 'operation: string (e.g. create_todo/update_todo/get_todo_list/get_todo_detail/delete_todo); params?: object.',
    riskTier: 'modify',
  },
];

/** Input schema shared by every WeCom tool: an operation + optional JSON params. */
const inputSchema: ConnectorInputSchema = {
  type: 'object',
  properties: {
    operation: {
      type: 'string',
      description: 'The wecom-cli interface name for this category (e.g. get_message). See the wecomcli-* skill for the full list.',
    },
    params: {
      type: 'object',
      description: 'JSON params passed to the interface (wecom-cli <category> <operation> \'<params>\').',
    },
  },
  required: ['operation'],
};

/** A spawned `wecom-cli` outcome. */
export interface WeComCliResult {
  stdout: string;
  exitCode: number | null;
  error?: string;
}

/** Spawn a `wecom-cli` child and return its stdout. Overridable in tests. */
export type SpawnWecomCliFn = (
  scheme: { category: string; operation: string; params: string },
  env: Record<string, string | undefined>,
) => Promise<WeComCliResult>;

/** Default spawner: runs `wecom-cli <category> <operation> '<params>'`. */
const defaultSpawnWecomCli: SpawnWecomCliFn = (
  { category, operation, params },
  env,
) =>
  new Promise((resolve) => {
    const argv = ['wecom-cli', category, operation];
    if (params) argv.push(params);
    const child = spawn(argv[0], argv.slice(1), {
      env: { ...process.env, ...env },
      shell: false,
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => (stdout += d.toString('utf8')));
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString('utf8')));
    child.on('error', (err) =>
      resolve({ stdout, exitCode: 1, error: err.message }),
    );
    child.on('close', (code) =>
      resolve({ stdout, exitCode: code, error: stderr ? stderr.trim() : undefined }),
    );
  });

/**
 * Read the WeCom credentials from the vault's per-provider OAuth-client slot.
 * `corpid` is stored as `clientId` and `corpsecret` as `clientSecret`. Returns
 * the env map to inject into the `wecom-cli` child. Credentials are
 * main-process only — never exposed to the renderer or agent.
 */
function wecomEnvFromVault(vault: TokenVault): Record<string, string | undefined> {
  const client = vault.getOAuthClient(PROVIDER);
  return {
    [WECOM_ACCESS_TOKEN_ENV]: undefined,
    [WECOM_BOT_ID_ENV]: client?.clientId,
    [WECOM_SECRET_ENV]: client?.clientSecret,
  };
}

/** Build the descriptor list for a WeCom connection. */
export function listWeComDescriptors(connectionId: string): ConnectorToolDescriptor[] {
  return CATEGORY_TOOLS.map((tool) => ({
    name: `wecom_${tool.category}`,
    description: tool.description,
    inputSchema,
    inputSchemaSummary: tool.summary,
    riskTier: tool.riskTier,
    provider: PROVIDER,
    connectionId,
    action: `wecom:${tool.category}`,
  }));
}

/**
 * Construct the WeCom connector. It reads credentials from `vault` and spawns
 * `wecom-cli` via the (injectable) spawner. The `accessToken` argument of the
 * base `ConnectorModule.invoke` is unused — WeCom credentials come from the
 * vault, not from the OAuth token service.
 */
export function createWeComConnector(
  vault: TokenVault,
  spawnWecomCli: SpawnWecomCliFn = defaultSpawnWecomCli,
): ConnectorModule {
  return {
    provider: PROVIDER,
    listDescriptors(connectionId: string) {
      return listWeComDescriptors(connectionId);
    },
    async invoke(
      action: string,
      args: unknown,
      _accessToken: string,
    ): Promise<ConnectorInvokeResult> {
      if (!action.startsWith('wecom:')) {
        return {
          success: false,
          error: { code: 'unknown_action', message: `Unknown wecom action: ${action}`, retriable: false },
        };
      }
      const category = action.slice('wecom:'.length);
      const typed = (args ?? {}) as { operation?: string; params?: Record<string, unknown> };
      if (!typed.operation || typeof typed.operation !== 'string') {
        return {
          success: false,
          error: { code: 'missing_operation', message: 'operation is required', retriable: false },
        };
      }

      const env = wecomEnvFromVault(vault);
      const paramsJson = typed.params ? JSON.stringify(typed.params) : '';
      const result = await spawnWecomCli(
        { category, operation: typed.operation, params: paramsJson },
        env,
      );

      if (result.error || (result.exitCode !== 0 && result.exitCode !== null)) {
        return {
          success: false,
          error: {
            code: 'provider_error',
            message: result.error || `wecom-cli exited with code ${result.exitCode}`,
            retriable: false,
          },
        };
      }
      return { success: true, data: parseWecomOutput(result.stdout) };
    },
  };
}

/** Best-effort parse: wecom-cli emits JSON; fall back to raw text. */
function parseWecomOutput(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (!trimmed) return { errcode: 0, errmsg: 'ok', data: null };
  try {
    return JSON.parse(trimmed);
  } catch {
    return { errcode: 0, errmsg: 'ok', data: trimmed };
  }
}