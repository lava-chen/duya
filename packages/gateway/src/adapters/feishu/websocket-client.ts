/**
 * Feishu WebSocket Client
 *
 * Implements Feishu WebSocket long connection for receiving events.
 * Uses the Feishu/Lark WebSocket endpoint for persistent connection.
 */

import type { FeishuAdapter } from './index.js';
import type { FeishuEvent, FeishuMessage } from './types.js';

interface WebSocketConfig {
  appId: string;
  appSecret: string;
  baseUrl?: string;
  reconnectInterval?: number;
  pingInterval?: number;
}

interface WSMessage {
  type: string;
  [key: string]: unknown;
}

const DEFAULT_RECONNECT_INTERVAL = 120_000; // 2 minutes
const DEFAULT_PING_INTERVAL = 30_000; // 30 seconds

export class FeishuWebSocketClient {
  private adapter: FeishuAdapter;
  private config: WebSocketConfig;
  private ws: WebSocket | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private baseUrl: string;
  private reconnectInterval: number;
  private pingInterval: number;

  constructor(adapter: FeishuAdapter, config: WebSocketConfig) {
    this.adapter = adapter;
    this.config = config;
    this.baseUrl = config.baseUrl ?? 'https://open.feishu.cn/open-apis';
    this.reconnectInterval = config.reconnectInterval ?? DEFAULT_RECONNECT_INTERVAL;
    this.pingInterval = config.pingInterval ?? DEFAULT_PING_INTERVAL;
  }

  /** Start WebSocket connection */
  async start(): Promise<void> {
    if (this.ws || this.isConnecting) {
      console.log('[Feishu WS] Already connected or connecting');
      return;
    }

    this.shouldReconnect = true;
    await this.connect();
  }

  /** Stop WebSocket connection */
  async stop(): Promise<void> {
    console.log('[Feishu WS] Stopping...');
    this.shouldReconnect = false;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }

    if (this.ws) {
      this.ws.close(1000, 'Client stopped');
      this.ws = null;
    }

    console.log('[Feishu WS] Stopped');
  }

  /** Connect to WebSocket endpoint */
  private async connect(): Promise<void> {
    if (this.isConnecting) return;
    this.isConnecting = true;

    try {
      // Get access token first
      const token = await this.getAccessToken();
      if (!token) {
        throw new Error('Failed to get access token');
      }

      // Get WebSocket endpoint
      const endpoint = await this.getWebSocketEndpoint(token);
      if (!endpoint) {
        throw new Error('Failed to get WebSocket endpoint');
      }

      console.log('[Feishu WS] Connecting to:', endpoint.ws_url.substring(0, 50) + '...');

      // Create WebSocket connection
      this.ws = new WebSocket(endpoint.ws_url);

      this.ws.onopen = () => {
        console.log('[Feishu WS] Connected');
        this.isConnecting = false;
        this.startPing();
      };

      this.ws.onmessage = (event) => {
        this.handleMessage(event.data);
      };

      this.ws.onerror = (error) => {
        console.error('[Feishu WS] Error:', error);
      };

      this.ws.onclose = (event) => {
        console.log('[Feishu WS] Disconnected:', event.code, event.reason);
        this.isConnecting = false;
        this.stopPing();

        if (this.shouldReconnect && event.code !== 1000) {
          this.scheduleReconnect();
        }
      };
    } catch (err) {
      console.error('[Feishu WS] Connection failed:', err);
      this.isConnecting = false;
      this.scheduleReconnect();
    }
  }

  /** Handle incoming WebSocket message */
  private handleMessage(data: string | ArrayBuffer | Blob): void {
    try {
      let message: WSMessage;
      if (typeof data === 'string') {
        message = JSON.parse(data);
      } else if (data instanceof ArrayBuffer) {
        message = JSON.parse(new TextDecoder().decode(data));
      } else {
        data.text().then((text) => {
          this.handleMessage(text);
        });
        return;
      }

      // Handle different message types
      switch (message.type) {
        case 'pang': {
          // Pong response - connection is alive
          console.log('[Feishu WS] Pong received');
          break;
        }

        case 'im.message.receive_v1': {
          // Inbound message
          const event = message as unknown as { schema: string; header: Record<string, unknown>; event: FeishuMessage };
          this.adapter.handleInboundMessage(event.event);
          break;
        }

        case 'im.message.reaction.created_v1':
        case 'im.message.reaction.deleted_v1':
        case 'im.chat.member.bot.added_v1':
        case 'im.chat.member.bot.deleted_v1':
        case 'im.message.recalled_v1':
        case 'p2p_chat_entered_v1':
        case 'card.action.trigger':
        case 'drive.notice.comment_add_v1': {
          // Route to adapter
          const feishuEvent = message as unknown as FeishuEvent;
          this.routeEvent(feishuEvent);
          break;
        }

        default:
          console.log('[Feishu WS] Unknown message type:', message.type);
      }
    } catch (err) {
      console.error('[Feishu WS] Failed to parse message:', err);
    }
  }

  /** Route event to appropriate handler */
  private async routeEvent(event: FeishuEvent): Promise<void> {
    switch (event.header?.event_type) {
      case 'im.message.reaction.created_v1':
        this.adapter.handleReactionCreated(event);
        break;
      case 'im.message.reaction.deleted_v1':
        this.adapter.handleReactionDeleted(event);
        break;
      case 'im.chat.member.bot.added_v1':
        this.adapter.handleBotAddedToChat(event);
        break;
      case 'im.chat.member.bot.deleted_v1':
        this.adapter.handleBotRemovedFromChat(event);
        break;
      case 'im.message.recalled_v1':
        this.adapter.handleMessageRecalled(event);
        break;
      case 'p2p_chat_entered_v1':
        this.adapter.handleP2pChatEntered(event);
        break;
      case 'card.action.trigger':
        this.adapter.handleCardAction(event);
        break;
      case 'drive.notice.comment_add_v1':
        await this.adapter.handleDriveComment(event);
        break;
      default:
        console.log('[Feishu WS] Unhandled event type:', event.header?.event_type);
    }
  }

  /** Get access token */
  private async getAccessToken(): Promise<string> {
    const response = await fetch(`${this.baseUrl}/auth/v3/tenant_access_token/internal`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        app_id: this.config.appId,
        app_secret: this.config.appSecret,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to get access token: ${response.status}`);
    }

    const data = (await response.json()) as { tenant_access_token?: string };
    return data.tenant_access_token ?? '';
  }

  /** Get WebSocket endpoint */
  private async getWebSocketEndpoint(token: string): Promise<{ ws_url: string } | null> {
    const response = await fetch(`${this.baseUrl}/event/v1/im/app_connectivity/app_ticket/open_api/rest`, {
      method: 'GET',
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    if (!response.ok) {
      console.error('[Feishu WS] Failed to get endpoint:', response.status);
      return null;
    }

    const data = (await response.json()) as { code?: number; ws_url?: string };
    if (data.code !== 0 || !data.ws_url) {
      console.error('[Feishu WS] Invalid endpoint response:', data);
      return null;
    }

    return { ws_url: data.ws_url };
  }

  /** Start ping interval */
  private startPing(): void {
    this.pingTimer = setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify({ type: 'ping' }));
        console.log('[Feishu WS] Ping sent');
      }
    }, this.pingInterval);
  }

  /** Stop ping interval */
  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  /** Schedule reconnection */
  private scheduleReconnect(): void {
    if (!this.shouldReconnect) return;

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
    }

    console.log(`[Feishu WS] Scheduling reconnect in ${this.reconnectInterval / 1000}s`);
    this.reconnectTimer = setTimeout(() => {
      console.log('[Feishu WS] Reconnecting...');
      this.isConnecting = false;
      this.connect();
    }, this.reconnectInterval);
  }

  /** Check if connected */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }
}