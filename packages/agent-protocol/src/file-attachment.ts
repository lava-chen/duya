export interface FileAttachment {
  id: string;
  /**
   * Discriminator carried through from the renderer (e.g. 'pasted-text',
   * 'terminal-ref', 'browser-ref', 'file-tree-ref', 'file', 'image').
   * Optional for backward compat; absent kinds default to 'file'.
   */
  kind?: string;
  name: string;
  type: string;
  url: string; // data URL, blob URL, or file path
  size: number;
  /** Absolute file path for document files (pdf, docx, etc.) */
  path?: string;
  /** Parsed text content for document files */
  text?: string;
  /** Extraction method for parsed documents */
  extractMethod?: 'text' | 'vision' | 'hybrid';
  /** Image chunks from OCR/vision extraction */
  imageChunks?: Array<{ base64: string; mediaType: string }>;
  /** Thumbnail preview for document files (base64 data URL) */
  thumbnail?: string;
}
