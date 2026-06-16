/**
 * NotebookParser - Jupyter notebook (.ipynb)
 *
 * Reads a notebook file, walks its cells, and produces a RawParse
 * that the existing result-builder can serialize to the model.
 * Code cell outputs containing image data are extracted to a
 * sidecar directory next to the notebook; the base64 + path go
 * back via RawParse.images — the result-builder turns this into a
 * vision-tool reminder (no image blocks in the model's text
 * context).
 *
 * Model-facing cell format (mirrors Claude Code's):
 *   <cell id="cell-3"><language>python</language>def foo(): pass</cell id="cell-3">
 */

import { dirname, join, basename } from 'node:path';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import {
  parseNotebookJson,
  extractOutputImage,
  summarizeNotebook,
  type ProcessedCell,
} from '../../utils/notebook.js';
import type { RawParse, ImageChunk, TextChunk } from '../types.js';

export class NotebookParser {
  async parse(filePath: string): Promise<RawParse> {
    const sidecarDir = join(dirname(filePath), `${basename(filePath)}.cells`);

    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch (err) {
      throw new Error(
        `Cannot read notebook '${filePath}': ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const result = parseNotebookJson(content);
    const summary = summarizeNotebook(result);

    const chunks: TextChunk[] = [
      { type: 'text', index: -1, text: `[${summary}]\n\n` },
    ];
    const images: ImageChunk[] = [];

    let chunkIdx = 0;
    for (const cell of result.cells) {
      chunks.push({
        type: 'text',
        index: chunkIdx++,
        text: serializeCellForModel(cell),
      });
    }

    // Re-parse the raw cells to extract images. parseNotebookJson
    // already discarded the raw data dict; we need it back here to
    // pull image/png or image/jpeg. The notebook content is small
    // enough that re-parsing is cheap.
    const raw = JSON.parse(content) as {
      cells?: Array<{
        cell_type: string;
        outputs?: Array<{
          output_type: string;
          data?: Record<string, unknown>;
        }>;
      }>;
    };
    const rawCells = raw.cells ?? [];
    for (let ci = 0; ci < rawCells.length; ci++) {
      const rawCell = rawCells[ci]!;
      if (rawCell.cell_type !== 'code' || !rawCell.outputs) continue;
      for (let oi = 0; oi < rawCell.outputs.length; oi++) {
        const output = rawCell.outputs[oi]!;
        if (
          output.output_type !== 'display_data' &&
          output.output_type !== 'execute_result'
        ) {
          continue;
        }
        const extracted = await extractOutputImage(
          output.data,
          ci,
          oi,
          sidecarDir,
        );
        if (extracted) {
          images.push({
            type: 'image',
            index: images.length,
            base64: readFileSync(extracted.imagePath).toString('base64'),
            mediaType: extracted.mediaType,
            page: ci,
          });
        }
      }
    }

    return {
      text: '',
      chunks,
      images,
      extractMethod: 'hybrid',
    };
  }
}

/** Serialize a single cell into the model-facing text format. */
function serializeCellForModel(cell: ProcessedCell): string {
  const metadata: string[] = [];
  if (cell.cellType === 'code' && cell.language) {
    metadata.push(`<language>${cell.language}</language>`);
  }
  if (cell.cellType === 'code' && cell.executionCount != null) {
    metadata.push(`<execution_count>${cell.executionCount}</execution_count>`);
  }
  let body = cell.source;
  if (cell.cellType === 'code' && cell.outputs && cell.outputs.length > 0) {
    const outputText = cell.outputs
      .map((o) => (o.type === 'stream' || o.type === 'error' ? o.text : o.text ?? ''))
      .filter((s) => s.length > 0)
      .join('\n');
    if (outputText) {
      body += `\n\nOutput:\n${outputText}`;
    }
  }
  return `<cell id="${cell.cellId}">${metadata.join('')}${body}</cell id="${cell.cellId}">`;
}
