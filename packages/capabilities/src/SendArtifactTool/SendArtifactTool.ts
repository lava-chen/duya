/**
 * Produces explicit outbound media directives for files that already exist.
 *
 * The host-facing channel pipeline owns delivery. This capability only checks
 * that referenced paths exist and formats the directive consumed by that
 * pipeline.
 */

import { BaseTool } from '../BaseTool.js';
import type { ToolResult } from '../contracts/tool.js';

export interface SendArtifactFileSystemPort {
  exists(path: string): boolean;
}

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

  constructor(private readonly fileSystem: SendArtifactFileSystemPort) {
    super();
  }

  async execute(input: Record<string, unknown>, _workingDirectory?: string): Promise<ToolResult> {
    const id = crypto.randomUUID();
    const raw = input.file_paths;
    const paths = (Array.isArray(raw) ? raw : [raw])
      .filter((path): path is string => typeof path === 'string' && path.trim().length > 0)
      .map((path) => path.trim());

    if (paths.length === 0) {
      return { id, name: this.name, result: 'send_artifact: no file_paths provided.', error: true };
    }

    const missing: string[] = [];
    for (const path of paths) {
      if (!this.fileSystem.exists(path)) missing.push(path);
    }
    if (missing.length > 0) {
      return {
        id,
        name: this.name,
        result: `send_artifact: file(s) not found: ${missing.join(', ')}`,
        error: true,
      };
    }

    // The gateway's media extraction delivers these extension-agnostic paths.
    const mediaDirectives = paths.map((path) => `MEDIA:${path}`).join('\n');
    return {
      id,
      name: this.name,
      result: `Sending ${paths.length} file(s) through the channel:\n${paths.join('\n')}\n${mediaDirectives}`,
    };
  }
}
