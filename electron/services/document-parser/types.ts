export interface TextChunk {
  type: 'text';
  index: number;
  text: string;
}

export interface ImageChunk {
  type: 'image';
  index: number;
  base64: string;
  mediaType: string;
}

export type ParseChunk = TextChunk | ImageChunk;

export interface ThumbnailData {
  base64: string;
  mediaType: string;
}

export interface ParseResult {
  fileHash: string;
  sessionId: string;
  filename: string;
  charCount: number;
  chunks: ParseChunk[];
  extractMethod?: 'text' | 'vision' | 'hybrid';
  metadata?: Record<string, unknown>;
  thumbnail?: ThumbnailData;
  parsedAt: number;
}

export interface Capabilities {
  parsers: Record<string, string | boolean>;
  libreoffice_path: string | null;
  version: string;
}

export interface JsonRpcRequest {
  jsonrpc: '2.0';
  id: number;
  method: string;
  params: Record<string, unknown>;
}

export interface JsonRpcProgressResponse {
  jsonrpc: '2.0';
  id: number;
  result: {
    status: 'parsing';
    progress: number;
  };
  type?: never;
}

export interface JsonRpcDoneResponse {
  jsonrpc: '2.0';
  id: number;
  result: {
    status: 'done';
    charCount: number;
    chunks: ParseChunk[];
    extractMethod?: 'text' | 'vision' | 'hybrid';
    thumbnail?: ThumbnailData;
  };
  type?: never;
}

export interface JsonRpcErrorResponse {
  jsonrpc: '2.0';
  id: number;
  error: {
    code: number;
    message: string;
  };
  type?: never;
}

export type JsonRpcResponse = JsonRpcProgressResponse | JsonRpcDoneResponse | JsonRpcErrorResponse;

export interface CapabilityMessage {
  type: 'capabilities';
  parsers: Record<string, string | boolean>;
  libreoffice_path: string | null;
  version: string;
  jsonrpc?: never;
  id?: never;
}

export type SidecarMessage = JsonRpcResponse | CapabilityMessage;

export interface ParseRequest {
  id: number;
  filePath: string;
  sessionId: string;
  resolve: (result: ParseResult) => void;
  reject: (error: Error) => void;
  onProgress?: (progress: number) => void;
}

export type ParseStatus = 'idle' | 'parsing' | 'done' | 'error';

export interface ParseState {
  fileHash: string;
  filename: string;
  status: ParseStatus;
  progress: number;
  error?: string;
  result?: ParseResult;
}

export const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
export const PARSE_TIMEOUT = 120000; // 120 seconds
export const MAX_CONCURRENT = 2;

export const SUPPORTED_EXTENSIONS = ['.docx', '.pdf', '.pptx', '.xlsx', '.txt', '.md'];

export const PDF_CONFIDENCE_THRESHOLD = 100; // avg chars per page below this triggers vision fallback
