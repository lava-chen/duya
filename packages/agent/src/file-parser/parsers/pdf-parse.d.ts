/**
 * Type stub for pdf-parse (CJS, no built-in types).
 *
 * The default export accepts a PDF buffer and returns metadata + text.
 * We only need the fields we actually use.
 */
declare module 'pdf-parse' {
  interface PdfParseResult {
    numpages: number;
    numrender: number;
    info: unknown;
    metadata: unknown;
    text: string;
    version: string;
  }
  type PdfParseFn = (buffer: Buffer, options?: Record<string, unknown>) => Promise<PdfParseResult>;
  const pdfParse: PdfParseFn;
  export default pdfParse;
}
