/**
 * @duya/gateway - Platform Gateway for External Integrations
 *
 * This package provides the gateway functionality for connecting
 * external platforms (Telegram, Feishu, WeChat, Discord) to the DUYA agent.
 *
 * Runs as a child_process forked from Electron Main Process.
 */

export * from './types.js';
export { GatewayManager } from './gateway-manager.js';
export { PlatformAdapter, createAdapter, registerAdapterFactory } from './adapters/base.js';
export { IpcClient } from './ipc-client.js';
export { UserMapper } from './user-mapper.js';
export { StreamHandler } from './stream-handler.js';
export { PermissionBroker } from './permission-broker.js';
export { CatchupBatchProcessor, getCatchupBatchProcessor, runRealtimeCatchupBatch } from './catchup-batch.js';

// ---------------------------------------------------------------------------
// Subprocess entry point (when run via child_process.fork)
// ---------------------------------------------------------------------------

import { GatewayManager } from './gateway-manager.js';
import type {
  GatewayInitConfig,
  MainToGatewayMessage,
  GatewayToMainMessage,
} from './types.js';

// Register adapter imports (side-effect registration)
import './adapters/index.js';

let gatewayManager: GatewayManager | null = null;

function send(message: GatewayToMainMessage): void {
  const result = process.send?.(message);
  if (result === false) {
    console.error('[Gateway] process.send returned false, message queue full');
  }
  if (!process.send) {
    console.error('[Gateway] process.send is undefined');
  }
}

function handleMessage(msg: MainToGatewayMessage): void {
  switch (msg.type) {
    case 'init': {
      if (!gatewayManager) {
        gatewayManager = new GatewayManager();
      }
      gatewayManager.init(msg.config).then(() => {
        send({ type: 'gateway:init:complete', success: true });
      }).catch((err) => {
        send({ type: 'gateway:init:complete', success: false, error: String(err) });
      });
      break;
    }

    case 'gateway:start': {
      console.log('[Gateway] Received gateway:start, id:', msg.id);
      gatewayManager?.start().then(() => {
        console.log('[Gateway] gateway:start completed, sending response id:', msg.id);
        send({ type: 'gateway:start:response', id: msg.id, success: true });
      }).catch((err) => {
        console.log('[Gateway] gateway:start failed, sending response id:', msg.id);
        send({ type: 'gateway:start:response', id: msg.id, success: false, error: String(err) });
      });
      break;
    }

    case 'gateway:stop': {
      gatewayManager?.stop().then(() => {
        send({ type: 'gateway:stop:response', id: msg.id, success: true });
      }).catch((err) => {
        send({ type: 'gateway:stop:response', id: msg.id, success: false, error: String(err) });
      });
      break;
    }

    case 'gateway:reload': {
      gatewayManager?.reloadConfig(msg.config).then(() => {
        send({ type: 'gateway:ready' });
      }).catch((err) => {
        send({ type: 'gateway:error', error: String(err) });
      });
      break;
    }

    case 'gateway:getStatus': {
      const status = gatewayManager?.getStatus() ?? {
        running: false,
        adapters: [],
        autoStart: false,
      };
      // Send status as a response - Main Process matches by type
      process.send?.({ type: 'gateway:getStatus:response', id: msg.id, status });
      break;
    }

    case 'gateway:outbound': {
      gatewayManager?.handleOutboundEvent(msg.sessionId, msg.event).catch((err) => {
        console.error('[Gateway] Error handling outbound event:', err);
      });
      break;
    }

    case 'gateway:permission_request': {
      gatewayManager?.handlePermissionRequest(msg.sessionId, msg.permission).catch((err) => {
        console.error('[Gateway] Error handling permission request:', err);
      });
      break;
    }

    case 'db:response': {
      // Forward db responses to IpcClient for pending request resolution
      gatewayManager?.getIpcClient().handleResponse(msg);
      break;
    }

    case 'gateway:create_session:response': {
      gatewayManager?.getIpcClient().handleResponse(msg);
      break;
    }

    case 'gateway:reset_session:response': {
      gatewayManager?.getIpcClient().handleResponse(msg);
      break;
    }

    default: {
      console.log(`[Gateway] Unknown message type: ${(msg as { type: string }).type}`);
    }
  }
}

// Set up IPC message listener
process.on('message', (msg: MainToGatewayMessage) => {
  handleMessage(msg);
});

// Handle process lifecycle
process.on('uncaughtException', (err) => {
  console.error('[Gateway] Uncaught exception:', err);
  send({ type: 'gateway:error', error: String(err) });
});

process.on('unhandledRejection', (reason) => {
  console.error('[Gateway] Unhandled rejection:', reason);
  send({ type: 'gateway:error', error: String(reason) });
});

process.on('SIGTERM', async () => {
  console.log('[Gateway] SIGTERM received, shutting down...');
  await gatewayManager?.stop();
  gatewayManager?.getIpcClient().rejectAll('Gateway shutting down');
  process.exit(0);
});

// Signal ready
console.log('[Gateway] Subprocess starting...');
send({ type: 'gateway:ready' });
