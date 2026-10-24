import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AnthropicToolNamePolicy, computeProviderName } from '@duya/plugin-core';
import { JSDOM } from 'jsdom';
import { MCPManager } from '../../src/MCP/MCPManager.js';

const pluginId = 'com.duya.examples.report-viewer';
const serverName = `plugin:${pluginId}:reports`;
const serverScript = resolve(process.cwd(), 'plugins/examples/report-viewer/mcp/reports-server.mjs');

describe('Report Viewer resource plugin example', () => {
  it('serves the declared HTML resource and exposes surface event tools over stdio MCP', async () => {
    const manager = new MCPManager();
    try {
      await manager.addServer({
        name: serverName,
        transport: 'stdio',
        source: 'plugin',
        pluginId,
        command: process.execPath,
        args: [serverScript],
        startupTimeoutSec: 10,
      });

      const client = manager.getClient(serverName);
      expect(client?.isConnected()).toBe(true);
      expect(client?.getTools().map((tool) => tool.name).sort()).toEqual([
        'duya_ui_highlight',
        'duya_ui_refresh',
        'duya_ui_select',
      ]);

      const usedNames = new Set<string>();
      const providerTools = manager.getAllToolsWithIdentity((internalKey, nameOverride) => {
        const name = computeProviderName(internalKey, usedNames, AnthropicToolNamePolicy, nameOverride);
        usedNames.add(name);
        return name;
      });
      for (const toolName of ['duya_ui_select', 'duya_ui_highlight', 'duya_ui_refresh']) {
        const internalKey = `mcp__${serverName}__${toolName}`;
        expect(providerTools.find((tool) => tool.internalKey === internalKey)?.providerName).toBe(
          computeProviderName(internalKey, new Set(), AnthropicToolNamePolicy),
        );
      }

      const [resource] = await manager.readResource(serverName, 'ui://reports/overview');
      expect(resource?.uri).toBe('ui://reports/overview');
      expect(resource?.mimeType).toBe('text/html; charset=utf-8');
      expect(resource?.text).toContain('MCP resource');
      expect(resource?.text).toContain('method: "ready"');

      if (!resource?.text) throw new Error('Report Viewer returned no HTML text');
      const token = 'A'.repeat(43);
      const outbound: Array<{ message: unknown; targetOrigin: string }> = [];
      const hostWindow = {
        postMessage(message: unknown, targetOrigin: string) {
          outbound.push({ message, targetOrigin });
        },
      };
      const page = new JSDOM(resource.text, {
        runScripts: 'dangerously',
        url: `http://127.0.0.1:43127/${token}/index.html`,
        beforeParse(window) {
          Object.defineProperty(window, 'parent', { configurable: true, value: hostWindow });
        },
      });
      try {
        await new Promise((resolveLoad) => setTimeout(resolveLoad, 0));
        expect(outbound).toContainEqual({
          message: { channel: 'duya.plugin-app', method: 'ready', documentToken: token },
          targetOrigin: '*',
        });

        const sendHostEvent = (
          eventName: 'select' | 'highlight' | 'refresh',
          recordId?: string,
          surfaceId = 'report-overview',
        ) => {
          page.window.dispatchEvent(new page.window.MessageEvent('message', {
            source: hostWindow as unknown as MessageEventSource,
            data: {
              channel: 'duya.plugin-app',
              type: 'event',
              documentToken: token,
              surfaceId,
              eventName,
              payload: eventName === 'refresh' ? {} : { recordId },
            },
          }));
        };
        sendHostEvent('select', 'report-17');
        sendHostEvent('highlight', 'report-23');
        sendHostEvent('refresh');
        sendHostEvent('select', 'report-31', 'other-surface');

        expect(page.window.document.querySelector('[data-record-id="report-17"]')?.classList.contains('is-selected'))
          .toBe(true);
        expect(page.window.document.querySelector('[data-record-id="report-23"]')?.classList.contains('is-highlighted'))
          .toBe(true);
        expect(page.window.document.querySelector('[data-record-id="report-31"]')?.classList.contains('is-selected'))
          .toBe(false);
        expect(page.window.document.querySelector('#status')?.textContent).toMatch(/^Refreshed at /);
      } finally {
        page.window.close();
      }

      const result = await manager.callTool(serverName, 'duya_ui_select', {
        surfaceId: 'report-overview',
        payload: { recordId: 'report-17' },
      });
      expect(result.error).toBeUndefined();
      expect(result.result).toContain('event accepted');
    } finally {
      await manager.disconnectAll();
    }
  });
});
