import { randomUUID } from 'node:crypto';
import { createMCPToolExecutor, type MCPExecutorPorts } from '@duya/agent-runtime/tools/mcp-executor';
import type {
  RuntimeToolResult,
  ToolExecutor,
} from '@duya/agent-runtime/tools/catalog/registry';
import type { McpToolSource } from '@duya/agent-runtime/authorization/permissions/types';
import type { PluginAppDefinition } from '@duya/plugin-core/apps/declarations';

/** Strict first-slice wire message. Authority is always taken from the Host binding. */
export interface PluginAppBridgeMessage {
  type: 'mcp.invoke';
  pluginId: string;
  appId: string;
  instanceId: string;
  nonce: string;
  sessionId: string;
  runId: string;
  stateSchemaVersion: number;
  toolId: string;
  arguments: Record<string, unknown>;
}

export interface PluginAppBridgeEvent {
  source: object | null;
  origin: string;
}

export type PluginAppBridgeErrorCode =
  | 'INVALID_MESSAGE'
  | 'SOURCE_MISMATCH'
  | 'ORIGIN_MISMATCH'
  | 'IDENTITY_MISMATCH'
  | 'BINDING_REVOKED'
  | 'CAPABILITY_DENIED'
  | 'TOOL_NOT_ALLOWED'
  | 'SCHEMA_UNAVAILABLE'
  | 'INVALID_ARGUMENTS'
  | 'TOOL_DENIED'
  | 'TOOL_FAILED';

export type PluginAppBridgeResult =
  | { ok: true; result: RuntimeToolResult }
  | { ok: false; error: { code: PluginAppBridgeErrorCode; message: string } };

export type PluginAppArgumentValidation = 'valid' | 'invalid' | 'schema-unavailable';

export interface PluginAppBridgeTool<TContext extends object> {
  /** Stable ID from the exact captured catalog descriptor. */
  toolId: string;
  /** Catalog schema revision; never supplied by the App. */
  schemaRevision: string;
  capabilityId: string;
  validateArguments?: (
    schemaRevision: string,
    input: Record<string, unknown>,
  ) => PluginAppArgumentValidation;
  executor: PluginAppMcpToolExecutor<TContext>;
  /** Host creates fresh worker permission context for every App invocation. */
  createContext(invocationId: string): TContext;
}

const guardedExecutorBrand: unique symbol = Symbol('PluginAppMcpToolExecutor');

/** Executor created with the Host binding check inside Runtime's invoker seam. */
export interface PluginAppMcpToolExecutor<TContext extends object>
  extends ToolExecutor<TContext, RuntimeToolResult> {
  readonly [guardedExecutorBrand]: true;
}

/** Host-created instance binding. `isCurrent` must consult live Host/worker state. */
export interface PluginAppBridgeBinding<TContext extends object> {
  pluginId: string;
  app: PluginAppDefinition;
  instanceId: string;
  nonce: string;
  source: object;
  origin: string;
  sessionId: string;
  runId: string;
  /** Manifest requests and Host grants are separate sets. */
  grantedCapabilities: readonly string[];
  isCurrent(): boolean;
  tools: readonly PluginAppBridgeTool<TContext>[];
}

export interface PluginAppBridge<TContext extends object> {
  handle(
    event: PluginAppBridgeEvent,
    payload: unknown,
  ): Promise<PluginAppBridgeResult>;
}

const MESSAGE_KEYS = new Set([
  'type',
  'pluginId',
  'appId',
  'instanceId',
  'nonce',
  'sessionId',
  'runId',
  'stateSchemaVersion',
  'toolId',
  'arguments',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fail(
  code: PluginAppBridgeErrorCode,
  message: string,
): PluginAppBridgeResult {
  return { ok: false, error: { code, message } };
}

function parseMessage(value: unknown): PluginAppBridgeMessage | null {
  if (!isRecord(value)) return null;
  const keys = Object.keys(value);
  if (keys.length !== MESSAGE_KEYS.size || keys.some((key) => !MESSAGE_KEYS.has(key))) return null;
  if (
    value.type !== 'mcp.invoke' ||
    typeof value.pluginId !== 'string' ||
    typeof value.appId !== 'string' ||
    typeof value.instanceId !== 'string' ||
    typeof value.nonce !== 'string' ||
    typeof value.sessionId !== 'string' ||
    typeof value.runId !== 'string' ||
    !Number.isSafeInteger(value.stateSchemaVersion) ||
    typeof value.toolId !== 'string' ||
    !isRecord(value.arguments)
  ) {
    return null;
  }
  return value as unknown as PluginAppBridgeMessage;
}

function currentBinding<TContext extends object>(
  binding: PluginAppBridgeBinding<TContext>,
): boolean {
  try {
    return binding.isCurrent();
  } catch {
    return false;
  }
}

function identityMatches<TContext extends object>(
  binding: PluginAppBridgeBinding<TContext>,
  message: PluginAppBridgeMessage,
): boolean {
  return (
    message.pluginId === binding.pluginId &&
    message.appId === binding.app.appId &&
    message.instanceId === binding.instanceId &&
    message.nonce === binding.nonce &&
    message.sessionId === binding.sessionId &&
    message.runId === binding.runId &&
    message.stateSchemaVersion === binding.app.stateSchemaVersion
  );
}

/**
 * Builds the captured Runtime MCP executor with an instance-validity check at
 * the last trusted point before the connector side effect. Keep this wrapper
 * inside Runtime's `invoke` callback so it also runs after an approval await.
 */
export function createPluginAppMcpExecutor<TContext extends object>(options: {
  toolName: string;
  source: McpToolSource;
  invoke(input: Record<string, unknown>): Promise<RuntimeToolResult>;
  ports: MCPExecutorPorts<TContext>;
  isBindingCurrent(): boolean;
}): PluginAppMcpToolExecutor<TContext> {
  const { toolName, source, invoke, ports, isBindingCurrent } = options;
  const runtimeExecutor = createMCPToolExecutor({
    toolName,
    source,
    ports,
    invoke: async (input) => {
      let isCurrent = false;
      try {
        isCurrent = isBindingCurrent();
      } catch {
        isCurrent = false;
      }
      if (!isCurrent) {
        return {
          id: `${toolName}-app-binding-revoked`,
          name: toolName,
          result: '[Plugin App bridge] App instance binding was revoked before invocation.',
          error: true,
        };
      }
      return invoke(input);
    },
  });
  return {
    ...runtimeExecutor,
    [guardedExecutorBrand]: true,
  };
}

/** Creates the T31a validation kernel around Host-captured App and tool bindings. */
export function createPluginAppBridge<TContext extends object>(
  binding: PluginAppBridgeBinding<TContext>,
): PluginAppBridge<TContext> {
  if (!binding.nonce.trim()) throw new Error('Plugin App bridge requires a non-empty instance nonce.');
  if (!binding.source || !binding.origin) throw new Error('Plugin App bridge requires a bound source and origin.');
  if (!binding.sessionId.trim() || !binding.runId.trim()) {
    throw new Error('Plugin App bridge requires a bound session and run.');
  }
  return {
    async handle(event, payload) {
      let snapshot: unknown;
      try {
        snapshot = structuredClone(payload);
      } catch {
        return fail('INVALID_MESSAGE', 'App bridge message could not be safely snapshotted.');
      }
      const message = parseMessage(snapshot);
      if (!message) return fail('INVALID_MESSAGE', 'App bridge message is malformed or has extra fields.');
      if (event.source !== binding.source) {
        return fail('SOURCE_MISMATCH', 'Message did not come from the bound App instance.');
      }
      if (event.origin !== binding.origin) {
        return fail('ORIGIN_MISMATCH', 'Message origin does not match the bound App instance.');
      }
      // Opaque sandbox origins report "null". They are accepted only together
      // with the exact source object and per-instance nonce checked below.
      if (message.nonce !== binding.nonce) {
        return fail('IDENTITY_MISMATCH', 'Message nonce does not match its Host-owned instance binding.');
      }
      if (!identityMatches(binding, message)) {
        return fail('IDENTITY_MISMATCH', 'Message identity does not match its Host-owned binding.');
      }
      if (!currentBinding(binding)) {
        return fail('BINDING_REVOKED', 'The App instance or its session/run binding is no longer active.');
      }

      const matchingTools = binding.tools.filter((candidate) => candidate.toolId === message.toolId);
      if (matchingTools.length !== 1) {
        return fail('TOOL_NOT_ALLOWED', 'Tool is not uniquely present in the descriptor set captured for this App instance.');
      }
      const tool = matchingTools[0];
      if (!tool) return fail('TOOL_NOT_ALLOWED', 'Tool is not present in the captured descriptor set.');
      if (
        !binding.app.requiredCapabilities.includes(tool.capabilityId) ||
        !binding.grantedCapabilities.includes(tool.capabilityId)
      ) {
        return fail('CAPABILITY_DENIED', 'The App capability was not declared and granted by the Host.');
      }
      if (!tool.validateArguments) {
        return fail('SCHEMA_UNAVAILABLE', 'No Host schema validator is bound to this tool descriptor.');
      }
      if (tool.executor[guardedExecutorBrand] !== true) {
        return fail('TOOL_NOT_ALLOWED', 'Tool executor is not bound to the Plugin App validity guard.');
      }
      let validation: PluginAppArgumentValidation;
      try {
        validation = tool.validateArguments(tool.schemaRevision, message.arguments);
      } catch {
        validation = 'schema-unavailable';
      }
      if (validation === 'schema-unavailable') {
        return fail('SCHEMA_UNAVAILABLE', 'The captured tool schema revision is no longer available.');
      }
      if (validation !== 'valid') {
        return fail('INVALID_ARGUMENTS', 'Arguments do not match the captured tool schema.');
      }

      let result: RuntimeToolResult;
      try {
        // Recheck before entering the executor. The captured Runtime executor's
        // guarded invoker performs the required second check after permission.
        if (!currentBinding(binding)) {
          return fail('BINDING_REVOKED', 'The App instance or its session/run binding is no longer active.');
        }
        const invocationId = randomUUID();
        const context = tool.createContext(invocationId);
        result = await tool.executor.execute(message.arguments, undefined, context);
      } catch {
        return fail('TOOL_FAILED', 'The captured MCP tool executor failed.');
      }
      if (result.error) {
        if (result.result.includes('App instance binding was revoked before invocation')) {
          return fail('BINDING_REVOKED', 'The App instance or its session/run binding was revoked before invocation.');
        }
        return fail('TOOL_DENIED', result.result);
      }
      return { ok: true, result };
    },
  };
}
