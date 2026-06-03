/**
 * electron/cli/handlers/providers.ts
 *
 * CLI API handlers for LLM providers. Both list and info delegate
 * to the config manager and apply the redacted DTO.
 */

import * as http from 'http';
import { getConfigManager } from '../../config/manager';
import {
  toProviderListDTO,
  toProviderInfoDTO,
  type ProviderListItem,
  type ProviderInfoItem,
} from '../../../packages/agent/src/providers/providerService.js';

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
  });
  res.end(text);
}

export function handleListProviders(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const cm = getConfigManager();
    const all = cm.getAllProviders();
    const list: ProviderListItem[] = toProviderListDTO(Object.values(all));
    sendJson(res, 200, { providers: list });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function handleGetProvider(req: http.IncomingMessage, res: http.ServerResponse, id: string): void {
  try {
    const cm = getConfigManager();
    const all = cm.getAllProviders();
    const found = all[id];
    if (!found) {
      sendJson(res, 404, {
        error: {
          code: 'provider_not_found',
          message: `Provider '${id}' not found`,
        },
      });
      return;
    }
    const info: ProviderInfoItem = toProviderInfoDTO(found);
    sendJson(res, 200, { provider: info });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}

export function handleGetActiveProvider(req: http.IncomingMessage, res: http.ServerResponse): void {
  try {
    const cm = getConfigManager();
    const active = cm.getActiveProvider();
    if (!active) {
      sendJson(res, 200, { provider: null });
      return;
    }
    const info: ProviderInfoItem = toProviderInfoDTO(active);
    sendJson(res, 200, { provider: info });
  } catch (err) {
    sendJson(res, 500, {
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : String(err),
      },
    });
  }
}