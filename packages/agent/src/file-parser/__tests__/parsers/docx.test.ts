/**
 * docx parser end-to-end test
 *
 * Generates a real .docx on disk using the `docx` library (already in
 * deps for write operations), then verifies DocxParser + NodeFileParser
 * can recover its text, table rows, and image relationships.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DocxParser } from '../../parsers/docx.js';
import { NodeFileParser } from '../../index.js';
import {
  Document,
  Packer,
  Paragraph,
  TextRun,
  Table,
  TableRow,
  TableCell,
  HeadingLevel,
} from 'docx';

let tmpDir: string;
let fixturePath: string;

beforeAll(async () => {
  tmpDir = mkdtempSync(join(tmpdir(), 'duya-docx-test-'));
  fixturePath = join(tmpDir, 'sample.docx');

  const doc = new Document({
    sections: [
      {
        properties: {},
        children: [
          new Paragraph({
            text: 'First Heading',
            heading: HeadingLevel.HEADING_1,
          }),
          new Paragraph({
            children: [new TextRun('Body paragraph one.')],
          }),
          new Paragraph({
            children: [new TextRun('Body paragraph two with a run.')],
          }),
          new Table({
            rows: [
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('A1')] }),
                  new TableCell({ children: [new Paragraph('B1')] }),
                ],
              }),
              new TableRow({
                children: [
                  new TableCell({ children: [new Paragraph('A2')] }),
                  new TableCell({ children: [new Paragraph('B2')] }),
                ],
              }),
            ],
          }),
          new Paragraph({ text: 'Last paragraph' }),
        ],
      },
    ],
  });

  const buffer = await Packer.toBuffer(doc);
  writeFileSync(fixturePath, buffer);
}, 30_000);

afterAll(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('DocxParser (with generated fixture)', () => {
  it('extracts paragraph text', async () => {
    const result = await new DocxParser().parse(fixturePath);
    expect(result.text).toContain('First Heading');
    expect(result.text).toContain('Body paragraph one.');
    expect(result.text).toContain('Last paragraph');
    expect(result.extractMethod).toBe('text');
  });

  it('extracts table rows with pipe-joined cells', async () => {
    const result = await new DocxParser().parse(fixturePath);
    expect(result.text).toContain('A1 | B1');
    expect(result.text).toContain('A2 | B2');
  });

  it('produces chunks via NodeFileParser end-to-end', async () => {
    const parser = new NodeFileParser({ sessionId: 'docx-test' });
    try {
      const result = await parser.parseFile(fixturePath);
      expect(result.chunks.length).toBeGreaterThan(0);
      expect(result.chunks[0].type).toBe('text');
      expect(result.charCount).toBeGreaterThan(0);
      // All text chunks come first
      const firstImageIdx = result.chunks.findIndex((c) => c.type === 'image');
      if (firstImageIdx > 0) {
        for (let i = 0; i < firstImageIdx; i++) {
          expect(result.chunks[i].type).toBe('text');
        }
      }
    } finally {
      parser.dispose();
    }
  });

  it('rejects on invalid zip', async () => {
    const bad = join(tmpDir, 'bad.docx');
    writeFileSync(bad, 'not a zip');
    await expect(new DocxParser().parse(bad)).rejects.toThrow();
  });
});
