/**
 * useAttachments.ts - Plan 220 Phase 1.
 *
 * Unified attachment state for the chat input box. Replaces:
 *   - usePastedContent (pasted-text kind)
 *   - useFileAttachments (file / image kinds + parser side-state)
 *   - MessageInput.tsx's local fileChips / terminalReferenceChips /
 *     browserReferenceChips useState arrays.
 *
 * The hook is internally a useReducer so add/remove/clear actions are
 * atomic. All 5 attachment kinds live in a single `attachments` array.
 *
 * Drafts (saved via saveDraftIPC) intentionally cover ONLY the typed
 * input value. Drafts do NOT include attachments — by design.
 */

import { useCallback, useReducer, useRef } from 'react';
import type { FileAttachment } from '@/types/message';
import type {
  AttachmentKind,
  AttachmentMetadata,
  FileTreeRefMetadata,
} from '@/types/message';
import {
  compressImage,
} from './useImageCompression';
import {
  parseDocument,
  resolveFilePath,
  isDocumentFile,
  readFileAsDataURL,
} from './useFileParsing';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per file
const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB target for images after compression
const MAX_PASTE_LENGTH = 500;            // mirrors the legacy constant
const PREVIEW_LENGTH = 120;

interface State {
  attachments: FileAttachment[];
  parseErrors: Map<string, string>;
  isParsing: boolean;
}

type Action =
  | { type: 'add'; payload: FileAttachment }
  | { type: 'addMany'; payload: FileAttachment[] }
  | { type: 'update'; id: string; patch: Partial<FileAttachment> }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'parsing-start' }
  | { type: 'parsing-end' }
  | { type: 'parse-error'; filename: string; message: string };

function reducer(state: State, action: Action): State {
  switch (action.type) {
    case 'add':
      return { ...state, attachments: [...state.attachments, action.payload] };
    case 'addMany':
      return { ...state, attachments: [...state.attachments, ...action.payload] };
    case 'update':
      return {
        ...state,
        attachments: state.attachments.map((a) =>
          a.id === action.id ? ({ ...a, ...action.patch } as FileAttachment) : a,
        ),
      };
    case 'remove': {
      // If the removed attachment is a browser-ref with metadata.attachmentId,
      // also drop the paired image attachment (linked coupling).
      const target = state.attachments.find((a) => a.id === action.id);
      const linkedImageId =
        target?.kind === 'browser-ref'
          ? (target.metadata as { elementKind?: string; attachmentId?: string } | undefined)
              ?.elementKind === 'screenshot'
            ? (target.metadata as { attachmentId?: string }).attachmentId
            : undefined
          : undefined;
      // If we're removing an image that a browser-ref points at, also drop the ref.
      const referencingRefs = linkedImageId
        ? []
        : state.attachments.filter(
            (a) =>
              a.kind === 'browser-ref' &&
              (a.metadata as { attachmentId?: string } | undefined)?.attachmentId === action.id,
          );
      const idsToRemove = new Set<string>([
        action.id,
        ...(linkedImageId ? [linkedImageId] : []),
        ...referencingRefs.map((r) => r.id),
      ]);
      return {
        ...state,
        attachments: state.attachments.filter((a) => !idsToRemove.has(a.id)),
      };
    }
    case 'clear':
      return { ...state, attachments: [], parseErrors: new Map() };
    case 'parsing-start':
      return { ...state, isParsing: true };
    case 'parsing-end':
      return { ...state, isParsing: false };
    case 'parse-error': {
      const next = new Map(state.parseErrors);
      next.set(action.filename, action.message);
      return { ...state, parseErrors: next };
    }
    default:
      return state;
  }
}

const initialState: State = {
  attachments: [],
  parseErrors: new Map(),
  isParsing: false,
};

/**
 * Create a PastedTextAttachment from a raw string.
 */
export function makePastedTextAttachment(input: {
  id?: string;
  text: string;
  preview?: string;
}): FileAttachment {
  const id = input.id ?? crypto.randomUUID();
  const text = input.text;
  const preview = input.preview ?? makePreview(text);
  return {
    id,
    kind: 'pasted-text',
    name: preview,
    type: 'text/plain',
    url: '',
    size: text.length,
    text,
    previewText: preview,
    metadata: { timestamp: Date.now() },
  };
}

/**
 * Create a TerminalRefAttachment from a terminal panel selection.
 */
export function makeTerminalRefAttachment(input: {
  id?: string;
  shell: string;
  cwd: string;
  text: string;
}): FileAttachment {
  const id = input.id ?? crypto.randomUUID();
  const text = input.text;
  const firstLine =
    text.split(/\r?\n/).find((line) => line.trim())?.trim() ?? 'Terminal selection';
  const lineCount = text.split(/\r?\n/).length;
  return {
    id,
    kind: 'terminal-ref',
    name: input.shell,
    type: 'text/plain',
    url: '',
    size: text.length,
    text,
    previewText: `${firstLine} (${lineCount}行)`,
    metadata: {
      shell: input.shell,
      cwd: input.cwd,
      createdAt: Date.now(),
    },
  };
}

/**
 * Create a BrowserRefAttachment from a browser panel reference.
 *
 * `attachmentId` (in metadata) links the ref to a paired `image`
 * attachment when the reference is a screenshot.
 */
export function makeBrowserRefAttachment(input: {
  id?: string;
  elementKind: 'element' | 'screenshot';
  label: string;
  title: string;
  url: string;
  text: string;
  attachmentId?: string;
}): FileAttachment {
  const id = input.id ?? crypto.randomUUID();
  return {
    id,
    kind: 'browser-ref',
    name: input.label,
    type: 'text/plain',
    url: '',
    size: input.text.length,
    text: input.text,
    previewText: input.title || input.label,
    metadata: {
      url: input.url,
      elementKind: input.elementKind,
      attachmentId: input.attachmentId,
      title: input.title,
    },
  };
}

/**
 * Create a FileTreeRefAttachment from a path in the project file tree.
 *
 * If `lineStart`/`lineEnd` are provided, the card's `previewText`
 * becomes `name:L{lineStart}-L{lineEnd}` (e.g. `main.py:L2-L10`) so
 * the user sees both the file and the selection range in the
 * attachment card. The selected text itself is stored in metadata
 * for the model but not surfaced in the card preview.
 */
export function makeFileTreeRefAttachment(input: {
  id?: string;
  path: string;
  lineStart?: number;
  lineEnd?: number;
  selectedText?: string;
}): FileAttachment {
  const id = input.id ?? crypto.randomUUID();
  const name = input.path.split(/[/\\]/).pop() || input.path;
  const { lineStart, lineEnd, selectedText } = input;
  const rangeLabel =
    lineStart != null && lineEnd != null
      ? `${name}:L${lineStart}-L${lineEnd}`
      : name;
  const metadata: Record<string, unknown> = {};
  if (lineStart != null) metadata.lineStart = lineStart;
  if (lineEnd != null) metadata.lineEnd = lineEnd;
  if (selectedText != null) metadata.selectedText = selectedText;
  return {
    id,
    kind: 'file-tree-ref',
    name,
    type: 'text/plain',
    url: '',
    size: 0,
    path: input.path,
    previewText: rangeLabel,
    metadata: Object.keys(metadata).length > 0
      ? (metadata as FileTreeRefMetadata)
      : undefined,
  };
}

function makePreview(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= PREVIEW_LENGTH) return trimmed;
  return trimmed.substring(0, PREVIEW_LENGTH) + '...';
}

function shouldTreatAsPastedContent(text: string): boolean {
  return text.length > MAX_PASTE_LENGTH;
}

export interface UseAttachmentsApi {
  attachments: FileAttachment[];
  parseErrors: Map<string, string>;
  isParsing: boolean;
  /** True when at least one document attachment has a path but no parsed text yet. */
  hasUnparsedDocs: boolean;
  /** Append an attachment (or list of attachments). */
  addAttachment: (att: FileAttachment | FileAttachment[]) => void;
  /** Add a pasted-text from a raw string. Returns the created attachment, or null if blank. */
  addPastedText: (text: string) => FileAttachment | null;
  /** Add a file from a File object. Routes document files through the parser. */
  addFile: (file: File) => Promise<void>;
  /** Add a browser-ref and its paired screenshot in one shot. */
  addBrowserScreenshot: (
    ref: Parameters<typeof makeBrowserRefAttachment>[0],
    png: FileAttachment,
  ) => void;
  /** Remove an attachment by id. Linked browser-ref + image attachments are also dropped. */
  remove: (id: string) => void;
  /** Drop everything and clear parse errors. */
  clear: () => void;
  /** Build the model-facing content from attachments + the typed input. */
  buildModelContent: (inputText: string) => string;
  /** Build the UI-facing content. Same as model since markers are gone. */
  buildDisplayContent: (inputText: string) => string;
}

export function useAttachments(): UseAttachmentsApi {
  const [state, dispatch] = useReducer(reducer, initialState);
  // Track parsing-in-progress across async calls. The reducer field is
  // for the synchronous "is anything parsing" snapshot, but we also need
  // to dedupe concurrent parseDocument calls in flight.
  const parsingRef = useRef(false);

  const hasUnparsedDocs = state.attachments.some(
    (a) =>
      (a.kind === undefined || a.kind === 'file') &&
      !!a.path &&
      !a.text &&
      !a.type.startsWith('image/'),
  );

  const addAttachment = useCallback((att: FileAttachment | FileAttachment[]) => {
    if (Array.isArray(att)) {
      if (att.length === 0) return;
      dispatch({ type: 'addMany', payload: att });
    } else {
      dispatch({ type: 'add', payload: att });
    }
  }, []);

  const addPastedText = useCallback((text: string): FileAttachment | null => {
    if (!text.trim()) return null;
    const att = makePastedTextAttachment({ text });
    dispatch({ type: 'add', payload: att });
    return att;
  }, []);

  const addFile = useCallback(async (file: File) => {
    if (isDocumentFile(file.name)) {
      const filePath = resolveFilePath(file);
      const placeholderId = crypto.randomUUID();
      dispatch({
        type: 'add',
        payload: {
          id: placeholderId,
          kind: 'file',
          name: file.name,
          type: file.type,
          url: filePath,
          path: filePath,
          size: file.size,
        },
      });

      if (!parsingRef.current) {
        parsingRef.current = true;
        dispatch({ type: 'parsing-start' });
        const result = await parseDocument(placeholderId, filePath);
        if (!result.ok) {
          dispatch({ type: 'parse-error', filename: file.name, message: result.error ?? 'Unknown' });
        } else {
          dispatch({
            type: 'update',
            id: placeholderId,
            patch: {
              url: filePath,
              path: filePath,
              text: result.text,
              extractMethod: result.extractMethod,
              imageChunks: result.imageChunks.length > 0 ? result.imageChunks : undefined,
              thumbnail: result.thumbnail,
            },
          });
        }
        parsingRef.current = false;
        dispatch({ type: 'parsing-end' });
      }
    } else {
      // Image path: compress if too large, then store as data URL.
      let processedFile: File = file;
      if (file.type.startsWith('image/') && file.size > MAX_IMAGE_SIZE) {
        try {
          processedFile = await compressImage(file, {
            maxWidth: 2048,
            maxHeight: 2048,
            quality: 0.85,
            maxSizeMB: 5,
          });
        } catch (error) {
          console.warn('Image compression failed, using original:', error);
          processedFile = file;
        }
      }
      if (processedFile.size > MAX_FILE_SIZE) {
        console.warn(`File ${file.name} exceeds size limit of 10MB`);
        return;
      }
      const filePath = resolveFilePath(file);
      const id = crypto.randomUUID();
      const url = filePath || (await readFileAsDataURL(processedFile));
      dispatch({
        type: 'add',
        payload: {
          id,
          kind: 'image',
          name: file.name,
          type: file.type,
          url,
          path: filePath || undefined,
          size: processedFile.size,
        },
      });
    }
  }, []);

  const addBrowserScreenshot = useCallback(
    (
      ref: Parameters<typeof makeBrowserRefAttachment>[0],
      png: FileAttachment,
    ) => {
      // Ensure the PNG carries the kind discriminator.
      const pngAtt: FileAttachment = png.kind === 'image' ? png : { ...png, kind: 'image' };
      const refAtt = makeBrowserRefAttachment({
        ...ref,
        elementKind: 'screenshot',
        attachmentId: pngAtt.id,
      });
      dispatch({ type: 'addMany', payload: [pngAtt, refAtt] });
    },
    [],
  );

  const remove = useCallback((id: string) => {
    dispatch({ type: 'remove', id });
  }, []);

  const clear = useCallback(() => {
    dispatch({ type: 'clear' });
  }, []);

  const buildModelContent = useCallback(
    (inputText: string): string => {
      const parts: string[] = [];

      // 1. Pasted text bodies.
      const pasted = state.attachments
        .filter((a): a is FileAttachment & { kind: 'pasted-text'; text: string } =>
          a.kind === 'pasted-text',
        )
        .map((a) => a.text);
      if (pasted.length > 0) parts.push(pasted.join('\n\n'));

      // 2. Terminal refs (formatted as code block).
      const terminals = state.attachments
        .filter((a) => a.kind === 'terminal-ref')
        .map((a) => {
          const meta = a.metadata as { shell?: string; cwd?: string } | undefined;
          const shell = meta?.shell ?? 'shell';
          const cwd = meta?.cwd ?? '';
          return [`Terminal reference (${shell}, ${cwd}):`, '```text', a.text ?? '', '```'].join('\n');
        });
      if (terminals.length > 0) parts.push(terminals.join('\n\n'));

      // 3. Browser refs.
      const browsers = state.attachments
        .filter((a) => a.kind === 'browser-ref')
        .map((a) => a.text ?? '');
      if (browsers.length > 0) parts.push(browsers.join('\n\n'));

      // 4. File-tree paths. When a line range or selected text is
      // attached, surface that context to the model so it can answer
      // about the specific selection without re-reading the file.
      const paths = state.attachments
        .filter((a) => a.kind === 'file-tree-ref' && a.path)
        .map((a) => {
          const meta = a.metadata as
            | { lineStart?: number; lineEnd?: number; selectedText?: string }
            | undefined;
          if (meta?.selectedText && meta.lineStart != null && meta.lineEnd != null) {
            return [
              `File: ${a.path} (lines ${meta.lineStart}-${meta.lineEnd})`,
              '```text',
              meta.selectedText,
              '```',
            ].join('\n');
          }
          if (meta?.selectedText) {
            return [`File: ${a.path}`, '```text', meta.selectedText, '```'].join('\n');
          }
          return a.path as string;
        });
      if (paths.length > 0) parts.push(paths.join('\n\n'));

      // 5. User's typed input.
      const trimmedInput = inputText.trim();
      if (trimmedInput) parts.push(trimmedInput);

      return parts.join('\n\n');
    },
    [state.attachments],
  );

  const buildDisplayContent = useCallback(
    (inputText: string): string => buildModelContent(inputText),
    [buildModelContent],
  );

  return {
    attachments: state.attachments,
    parseErrors: state.parseErrors,
    isParsing: state.isParsing,
    hasUnparsedDocs,
    addAttachment,
    addPastedText,
    addFile,
    addBrowserScreenshot,
    remove,
    clear,
    buildModelContent,
    buildDisplayContent,
  };
}

// Re-export the type aliases that other modules import. Internal helpers
// (shouldTreatAsPastedContent, MAX_PASTE_LENGTH) are kept private.
export type {
  AttachmentKind,
  AttachmentMetadata,
  FileAttachment,
};