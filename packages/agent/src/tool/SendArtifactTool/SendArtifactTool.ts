/**
 * SendArtifactTool — Explicit outbound file delivery through a gateway channel.
 *
 * Unlike the convention-based fallback (which scans the agent's final text for
 * absolute paths or `MEDIA:` tags), this tool lets the agent declaratively hand
 * files to the channel layer. The tool validates each path exists and returns a
 * result that carries an explicit `MEDIA:<absolute-path>` directive per file,
 * which the gateway's media extraction pipeline turns into outbound attachments.
 *
 * In a desktop (non-gateway) session the tool is a harmless no-op: it validates
 * and returns the MEDIA directives, but no channel consumes them.
 */
import * as fs from 'node:fs';
import { BaseTool } from '../BaseTool.js';
import type { ToolResult } from '../../types.js';

export class SendArtifactTool extends BaseTool {
  readonly name = 'send_artifact';
  readonly description =
    'Explicitly send one or more files to the user through the gateway channel as attachments. ' +
    'Input `file_paths` is an array of ABSOLUTE file paths. The files are delivered after your reply. ' +
    'Use this when you have produced files (reports, images, documents, spreadsheets, archives) that the user should receive, ' +
    'instead of only describing where they are. Validate the paths exist before calling.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      file_paths: {
        type: 'array',
        items: { type: 'string', description: 'Absolute path of a file to send.' },
        description: 'One or more absolute paths of files to send through the channel.',
      },
    },
    required: ['file_paths'],
  };

  async execute(input: Record<string, unknown>, _workingDirectory?: string): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const raw = input.file_paths;
    const paths = (Array.isArray(raw) ? raw : [raw])
      .filter((p): p is string => typeof p === 'string' && p.trim().length > 0)
      .map((p) => p.trim());

    if (paths.length === 0) {
      return { id, name: this.name, result: 'send_artifact: no file_paths provided.', error: true };
    }

    const missing: string[] = [];
    for (const p of paths) {
      if (!fs.existsSync(p)) missing.push(p);
    }
    if (missing.length > 0) {
      return {
        id,
        name: this.name,
        result: `send_artifact: file(s) not found: ${missing.join(', ')}`,
        error: true,
      };
    }

    // Emit an explicit MEDIA directive per file so the gateway's media
    // extraction delivers them (extension-agnostic, unlike the absolute-path
    // text fallback which is gated on known media extensions).
    const mediaDirectives = paths.map((p) => `MEDIA:${p}`).join('\n');
    return {
      id,
      name: this.name,
      result: `Sending ${paths.length} file(s) through the channel:\n${paths.join('\n')}\n${mediaDirectives}`,
    };
  }
}