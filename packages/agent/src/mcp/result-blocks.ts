// packages/agent/src/mcp/result-blocks.ts
//
// Plan 580 D8 — shared last-mile composition of MCP content blocks into
// the model-visible ToolResult text. Used by BOTH chains:
//   - chain A (`mcp/index.ts` MCPClient.callTool),
//   - chain B (`tool/AppConnectionTool` executor over the IPC response).
//
// Contract: text blocks are joined verbatim; every non-text block becomes
// ONE deterministic, bounded (≤200 chars) metadata line. The canonical
// blocks ride losslessly in `ToolResult.blocks` — never stringify a block
// into the text (image/audio base64 would eat hundreds of thousands of
// tokens for zero multimodal benefit).

export interface ComposedBlockText {
  /** Text blocks joined + one metadata line per non-text block. */
  text: string;
  /** True when at least one non-text block was present. */
  hasNonText: boolean;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Deterministic, bounded (≤200 chars) single-line metadata for a non-text
 * MCP content block. Never includes the payload itself.
 */
export function describeNonTextBlock(block: unknown, index: number): string {
  const b = (block && typeof block === 'object' ? block : {}) as Record<string, unknown>;
  const type = typeof b.type === 'string' ? b.type : 'unknown';
  let line: string;
  switch (type) {
    case 'image':
    case 'audio': {
      const mime = typeof b.mimeType === 'string' ? b.mimeType : 'application/octet-stream';
      const size = typeof b.data === 'string' ? b.data.length : 0;
      // base64 is 4/3 of raw bytes; report an approximate raw size.
      const approxBytes = Math.round(size * 0.75);
      line = `[${type} ${mime} ~${formatBytes(approxBytes)} #${index}]`;
      break;
    }
    case 'resource': {
      const resource = (b.resource && typeof b.resource === 'object' ? b.resource : {}) as Record<string, unknown>;
      const uri = typeof resource.uri === 'string' ? resource.uri : '';
      const mime = typeof resource.mimeType === 'string' ? resource.mimeType : '';
      line = `[resource ${uri}${mime ? ` ${mime}` : ''} #${index}]`;
      break;
    }
    case 'resource_link': {
      const uri = typeof b.uri === 'string' ? b.uri : '';
      line = `[resource_link ${uri} #${index}]`;
      break;
    }
    default:
      line = `[${type} block #${index}]`;
  }
  line = line.replace(/[\r\n\t]+/g, ' ');
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

/**
 * Compose the model-visible text from an MCP `content` array (chain A:
 * `tools/call` result; chain B: the IPC-forwarded `data.content`).
 * Text blocks join with `\n`; non-text blocks contribute one bounded
 * metadata line each, appended after the text.
 */
export function composeResultFromBlocks(content: unknown): ComposedBlockText {
  const blocks = Array.isArray(content) ? content : [];
  let text = '';
  const metadataLines: string[] = [];
  let hasNonText = false;
  blocks.forEach((block, index) => {
    const b = (block && typeof block === 'object' ? block : {}) as Record<string, unknown>;
    if (b.type === 'text' && typeof b.text === 'string') {
      text = text ? `${text}\n${b.text}` : b.text;
    } else {
      hasNonText = true;
      metadataLines.push(describeNonTextBlock(block, index));
    }
  });
  const composed = metadataLines.length > 0
    ? (text ? `${text}\n${metadataLines.join('\n')}` : metadataLines.join('\n'))
    : text;
  return { text: composed, hasNonText };
}
