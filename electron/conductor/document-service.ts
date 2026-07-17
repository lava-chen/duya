import * as fs from 'fs';
import * as path from 'path';
import { getCanvasSnapshot } from '../db/queries/conductors';

const MAX_DOCUMENT_BYTES = 1024 * 1024;

function documentRoot(canvasId: string): string {
  const canvas = getCanvasSnapshot(canvasId)?.canvas;
  if (!canvas?.projectPath) {
    throw new Error('Markdown documents require a canvas connected to a project folder');
  }
  const root = path.resolve(canvas.projectPath);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    throw new Error('The canvas project folder is not available');
  }
  return fs.realpathSync(root);
}

function isInsideRoot(target: string, root: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative);
}

function readMarkdown(target: string): string {
  const stat = fs.statSync(target);
  if (!stat.isFile()) throw new Error('Markdown source is not a file');
  if (stat.size > MAX_DOCUMENT_BYTES) throw new Error('Markdown documents are limited to 1 MB');
  return fs.readFileSync(target, 'utf8');
}

export function prepareCanvasDocument(canvasId: string, elementId: string, content: Record<string, unknown>): Record<string, unknown> {
  const root = documentRoot(canvasId);
  const importPath = typeof content.importPath === 'string' ? content.importPath : null;
  const title = typeof content.title === 'string' && content.title.trim() ? content.title.trim() : 'Untitled document';

  if (importPath) {
    if (path.extname(importPath).toLowerCase() !== '.md') throw new Error('Only Markdown (.md) files can be added to a canvas');
    const target = fs.realpathSync(path.resolve(importPath));
    if (!isInsideRoot(target, root)) throw new Error('Markdown files must be inside the canvas project folder');
    return {
      ...content,
      importPath: undefined,
      filePath: path.relative(root, target),
      title: path.basename(target, '.md'),
      markdown: readMarkdown(target),
    };
  }

  const filePath = `.duya${path.sep}canvas${path.sep}${elementId}.md`;
  const target = path.resolve(root, filePath);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const markdown = typeof content.markdown === 'string' ? content.markdown : `# ${title}\n`;
  fs.writeFileSync(target, markdown, 'utf8');
  return { ...content, filePath, title, markdown };
}

export function syncCanvasDocument(canvasId: string, config: Record<string, unknown>): void {
  const filePath = typeof config.filePath === 'string' ? config.filePath : null;
  const markdown = typeof config.markdown === 'string' ? config.markdown : null;
  if (!filePath || markdown === null) return;

  const root = documentRoot(canvasId);
  const target = path.resolve(root, filePath);
  if (!isInsideRoot(target, root)) throw new Error('Document path is outside the canvas project folder');
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, markdown, 'utf8');
}
