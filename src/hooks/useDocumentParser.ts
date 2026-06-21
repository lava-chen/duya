import { useState, useCallback, useRef } from 'react';

export type ParseStatus = 'idle' | 'parsing' | 'done' | 'error';

export interface ParseState {
  fileHash: string;
  filename: string;
  status: ParseStatus;
  progress: number;
  error?: string;
  result?: {
    fileHash: string;
    sessionId: string;
    filename: string;
    charCount: number;
    chunks: Array<
      | { type: 'text'; index: number; text: string }
      | { type: 'image'; index: number; base64: string; mediaType: string }
    >;
    extractMethod?: 'text' | 'vision' | 'hybrid';
    metadata?: Record<string, unknown>;
    parsedAt: number;
  };
}

export interface Capabilities {
  parsers: Record<string, string | boolean>;
  libreoffice_path: string | null;
  version: string;
}

const SUPPORTED_EXTENSIONS = ['.docx', '.doc', '.pdf', '.pptx', '.xlsx', '.txt', '.md'];

export function isDocumentFile(filename: string): boolean {
  const ext = '.' + filename.split('.').pop()?.toLowerCase();
  return SUPPORTED_EXTENSIONS.includes(ext);
}

export function useDocumentParser() {
  const [parseStates, setParseStates] = useState<Map<string, ParseState>>(new Map());
  const [capabilities, setCapabilities] = useState<Capabilities | null>(null);
  const capabilitiesLoaded = useRef(false);

  const loadCapabilities = useCallback(async () => {
    if (capabilitiesLoaded.current) return;
    capabilitiesLoaded.current = true;

    try {
      const caps = await window.electronAPI.parser.getCapabilities();
      setCapabilities(caps);
    } catch {
      // parser may not be available
    }
  }, []);

  const parseFile = useCallback(async (filePath: string, filename: string) => {
    if (!isDocumentFile(filename)) {
      return null;
    }

    const state: ParseState = {
      fileHash: '',
      filename,
      status: 'parsing',
      progress: 0,
    };

    setParseStates((prev) => {
      const next = new Map(prev);
      next.set(filename, state);
      return next;
    });

    try {
      const result = await window.electronAPI.parser.parse(filePath);

      const doneState: ParseState = {
        fileHash: result.fileHash,
        filename: result.filename,
        status: 'done',
        progress: 1,
        result,
      };

      setParseStates((prev) => {
        const next = new Map(prev);
        next.set(filename, doneState);
        return next;
      });

      return result;
    } catch (error) {
      const errorState: ParseState = {
        fileHash: '',
        filename,
        status: 'error',
        progress: 0,
        error: error instanceof Error ? error.message : String(error),
      };

      setParseStates((prev) => {
        const next = new Map(prev);
        next.set(filename, errorState);
        return next;
      });

      return null;
    }
  }, []);

  const clearState = useCallback((filename: string) => {
    setParseStates((prev) => {
      const next = new Map(prev);
      next.delete(filename);
      return next;
    });
  }, []);

  const clearAll = useCallback(() => {
    setParseStates(new Map());
  }, []);

  return {
    parseFile,
    parseStates,
    capabilities,
    loadCapabilities,
    clearState,
    clearAll,
    isSupported: isDocumentFile,
  };
}
