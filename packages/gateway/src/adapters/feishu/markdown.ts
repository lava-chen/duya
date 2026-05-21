import type { FeishuMessageElement } from './types';

const POST_CONTENT_LIMIT = 30000;

export interface MarkdownParseResult {
  title: string;
  elements: FeishuMessageElement[];
}

interface InlineToken {
  type: 'text' | 'bold' | 'italic' | 'strikethrough' | 'code' | 'link';
  text?: string;
  url?: string;
}

const FENCED_BLOCK_ALIASES: Record<string, string> = {
  ts: 'TypeScript', tsx: 'TypeScript',
  js: 'JavaScript', jsx: 'JavaScript',
  py: 'Python', python: 'Python',
  rs: 'Rust', rust: 'Rust',
  go: 'Go', golang: 'Go',
  rb: 'Ruby', ruby: 'Ruby',
  cpp: 'C++', 'c++': 'C++', c: 'C', h: 'C',
  java: 'Java', kt: 'Kotlin', kotlin: 'Kotlin',
  swift: 'Swift', scala: 'Scala', r: 'R',
  sql: 'SQL', sh: 'Shell', bash: 'Bash', zsh: 'Zsh',
  yaml: 'YAML', yml: 'YAML', toml: 'TOML',
  json: 'JSON', xml: 'XML', html: 'HTML', css: 'CSS', scss: 'SCSS',
  dockerfile: 'Docker', docker: 'Docker',
  makefile: 'Makefile', cmake: 'CMake',
  proto: 'Protobuf', protobuf: 'Protobuf',
  graphql: 'GraphQL', tf: 'Terraform', hcl: 'Terraform', lua: 'Lua',
};

const ESCAPE_PAIRS: [RegExp, string][] = [
  [/\\/g, '\\\\'],
  [/\*/g, '\\*'], [/_/g, '\\_'], [/~/g, '\\~'], [/`/g, '\\`'],
  [/\[/g, '\\['], [/\]/g, '\\]'], [/\(/g, '\\('], [/\)/g, '\\)'],
  [/>/g, '\\>'], [/#/g, '\\#'], [/-/g, '\\-'], [/\+/g, '\\+'], [/\|/g, '\\|'],
];

function escapeLarkMd(seg: string): string {
  let result = seg;
  for (const [pattern, replacement] of ESCAPE_PAIRS) {
    result = result.replace(pattern, replacement);
  }
  return result;
}

function parseInline(text: string): InlineToken[] {
  const tokens: InlineToken[] = [];
  let i = 0;

  while (i < text.length) {
    if (text[i] === '\\' && i + 1 < text.length) {
      tokens.push({ type: 'text', text: text[i + 1] });
      i += 2;
      continue;
    }

    if (text.slice(i, i + 3) === '***' || text.slice(i, i + 3) === '___') {
      const end = text.indexOf(text.slice(i, i + 3), i + 3);
      if (end !== -1) {
        tokens.push({ type: 'bold', text: text.slice(i + 3, end) });
        i = end + 3;
        continue;
      }
    }

    if (text.slice(i, i + 2) === '**' || text.slice(i, i + 2) === '__') {
      const end = text.indexOf(text.slice(i, i + 2), i + 2);
      if (end !== -1) {
        tokens.push({ type: 'bold', text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    if (text[i] === '*' || text[i] === '_') {
      const marker = text[i];
      if (text[i + 1] !== marker && text[i + 1] !== ' ') {
        const end = text.indexOf(marker, i + 1);
        if (end !== -1 && end > i + 1) {
          tokens.push({ type: 'italic', text: text.slice(i + 1, end) });
          i = end + 1;
          continue;
        }
      }
    }

    if (text.slice(i, i + 2) === '~~') {
      const end = text.indexOf('~~', i + 2);
      if (end !== -1) {
        tokens.push({ type: 'strikethrough', text: text.slice(i + 2, end) });
        i = end + 2;
        continue;
      }
    }

    if (text[i] === '`') {
      const end = text.indexOf('`', i + 1);
      if (end !== -1) {
        tokens.push({ type: 'code', text: text.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    }

    if (text[i] === '[') {
      const closeBracket = text.indexOf(']', i + 1);
      if (closeBracket !== -1 && text[closeBracket + 1] === '(') {
        const closeParen = text.indexOf(')', closeBracket + 2);
        if (closeParen !== -1) {
          tokens.push({
            type: 'link',
            text: text.slice(i + 1, closeBracket),
            url: text.slice(closeBracket + 2, closeParen),
          });
          i = closeParen + 1;
          continue;
        }
      }
    }

    let plainEnd = i + 1;
    while (plainEnd < text.length && !'*_~`[\\'.includes(text[plainEnd])) {
      plainEnd++;
    }
    tokens.push({ type: 'text', text: text.slice(i, plainEnd) });
    i = plainEnd;
  }

  return tokens;
}

function inlineTokensToElements(tokens: InlineToken[]): FeishuMessageElement[] {
  const elements: FeishuMessageElement[] = [];
  let mergedText = '';

  const flushText = () => {
    if (mergedText) {
      elements.push({ tag: 'text', text: escapeLarkMd(mergedText) });
      mergedText = '';
    }
  };

  for (const token of tokens) {
    switch (token.type) {
      case 'text':
        mergedText += token.text || '';
        break;
      case 'bold':
        flushText();
        elements.push({ tag: 'text', text: `**${escapeLarkMd(token.text || '')}**` });
        break;
      case 'italic':
        flushText();
        elements.push({ tag: 'text', text: `*${escapeLarkMd(token.text || '')}*` });
        break;
      case 'strikethrough':
        flushText();
        elements.push({ tag: 'text', text: `~~${escapeLarkMd(token.text || '')}~~` });
        break;
      case 'code':
        flushText();
        elements.push({ tag: 'text', text: `\`${escapeLarkMd(token.text || '')}\`` });
        break;
      case 'link':
        flushText();
        elements.push({ tag: 'a', text: token.text || '', href: token.url });
        break;
    }
  }

  flushText();
  return elements;
}

function parseBlocks(text: string): { type: string; level?: number; items?: InlineToken[]; lines?: string[]; lang?: string }[] {
  const blocks: { type: string; level?: number; items?: InlineToken[]; lines?: string[]; lang?: string }[] = [];
  const lines = text.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    if (line.trim() === '') { i++; continue; }

    if (line.startsWith('# ')) {
      blocks.push({ type: 'heading', level: 1, items: parseInline(line.slice(2)) });
      i++; continue;
    }
    if (line.startsWith('## ')) {
      blocks.push({ type: 'heading', level: 2, items: parseInline(line.slice(3)) });
      i++; continue;
    }
    if (line.startsWith('### ')) {
      blocks.push({ type: 'heading', level: 3, items: parseInline(line.slice(4)) });
      i++; continue;
    }

    if (line.startsWith('> ')) {
      const quoteLines: string[] = [];
      while (i < lines.length && lines[i].startsWith('> ')) {
        quoteLines.push(lines[i].slice(2));
        i++;
      }
      blocks.push({ type: 'blockquote', lines: quoteLines });
      continue;
    }

    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      i++;
      const displayLang = FENCED_BLOCK_ALIASES[lang] || lang || 'Code';
      blocks.push({ type: 'code_block', items: [{ type: 'text', text: `${displayLang}\n${codeLines.join('\n')}` }] });
      continue;
    }

    if (line.match(/^[-*+]\s/)) {
      const listItems: InlineToken[][] = [];
      while (i < lines.length && lines[i].match(/^[-*+]\s/)) {
        listItems.push(parseInline(lines[i].replace(/^[-*+]\s/, '')));
        i++;
      }
      blocks.push({ type: 'unordered_list', items: listItems.flat() });
      continue;
    }

    if (line.match(/^\d+\.\s/)) {
      const listItems: InlineToken[][] = [];
      while (i < lines.length && lines[i].match(/^\d+\.\s/)) {
        listItems.push(parseInline(lines[i].replace(/^\d+\.\s/, '')));
        i++;
      }
      blocks.push({ type: 'ordered_list', items: listItems.flat() });
      continue;
    }

    if (line.match(/^---+$/)) {
      blocks.push({ type: 'hr' });
      i++;
      continue;
    }

    const paraLines: string[] = [];
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('#') && !lines[i].startsWith('>') && !lines[i].startsWith('```') && !lines[i].match(/^[-*+]\s/) && !lines[i].match(/^\d+\.\s/) && !lines[i].match(/^---+$/)) {
      paraLines.push(lines[i]);
      i++;
    }
    if (paraLines.length > 0) {
      blocks.push({ type: 'paragraph', items: parseInline(paraLines.join('\n')) });
    }
  }

  return blocks;
}

function blocksToElements(blocks: ReturnType<typeof parseBlocks>): FeishuMessageElement[] {
  const elements: FeishuMessageElement[] = [];

  for (const block of blocks) {
    switch (block.type) {
      case 'heading': {
        const text = (block.items || []).map(t => t.text || '').join('');
        elements.push({ tag: 'text', text: `${'#'.repeat(block.level || 1)} ${text}`, style: { bold: true } });
        break;
      }
      case 'paragraph': {
        elements.push(...inlineTokensToElements(block.items || []));
        break;
      }
      case 'code_block': {
        const text = (block.items || []).map(t => t.text || '').join('');
        elements.push({ tag: 'text', text });
        break;
      }
      case 'blockquote': {
        const text = (block.lines || []).join('\n');
        elements.push({ tag: 'text', text: `> ${text}` });
        break;
      }
      case 'unordered_list': {
        elements.push(...inlineTokensToElements(block.items || []));
        break;
      }
      case 'ordered_list': {
        let idx = 1;
        const parts = (block.items || []).map(t => `${idx++}. ${t.text || ''}`);
        elements.push({ tag: 'text', text: parts.join('\n') });
        break;
      }
      case 'hr': {
        elements.push({ tag: 'text', text: '\n---\n' });
        break;
      }
    }
  }

  return elements;
}

export function markdownToFeishuPost(markdown: string): MarkdownParseResult {
  const lines = markdown.trim().split('\n');
  let titleLine = lines[0] || '';
  if (titleLine.startsWith('# ')) {
    titleLine = titleLine.slice(2).trim();
  } else if (titleLine.length > 100) {
    titleLine = titleLine.slice(0, 100);
  }

  const rawBody = titleLine === lines[0] && lines.length > 1
    ? lines.slice(1).join('\n')
    : lines.join('\n');

  const blocks = parseBlocks(rawBody);
  const elements = blocksToElements(blocks);

  return {
    title: titleLine || 'Message',
    elements: elements.length > 0 ? elements : [{ tag: 'text', text: markdown.slice(0, POST_CONTENT_LIMIT) }],
  };
}

export function buildPostContent(title: string, elements: FeishuMessageElement[]): string {
  const contentElements: FeishuMessageElement[][] = [];
  let currentLine: FeishuMessageElement[] = [];

  for (const el of elements) {
    if (el.tag === 'text' && el.text === '\n') {
      if (currentLine.length > 0) {
        contentElements.push(currentLine);
        currentLine = [];
      }
    } else {
      currentLine.push(el);
    }
  }

  if (currentLine.length > 0) {
    contentElements.push(currentLine);
  }

  return JSON.stringify({
    zh_cn: {
      title: title.slice(0, 100),
      content: contentElements,
    },
  });
}

export function estimatePostSize(title: string, elements: FeishuMessageElement[]): number {
  return buildPostContent(title, elements).length;
}

export function splitPostIfNeeded(
  title: string,
  elements: FeishuMessageElement[],
  maxSize: number = POST_CONTENT_LIMIT
): { title: string; elements: FeishuMessageElement[] }[] {
  if (estimatePostSize(title, elements) <= maxSize) {
    return [{ title, elements }];
  }

  const result: { title: string; elements: FeishuMessageElement[] }[] = [];
  let chunk: FeishuMessageElement[] = [];
  let partIndex = 1;

  for (const el of elements) {
    chunk.push(el);
    if (estimatePostSize(`${title} (part ${partIndex})`, chunk) > maxSize) {
      chunk.pop();
      result.push({ title: `${title} (part ${partIndex})`, elements: [...chunk] });
      chunk = [el];
      partIndex++;
    }
  }

  if (chunk.length > 0) {
    result.push({ title: partIndex > 1 ? `${title} (part ${partIndex})` : title, elements: chunk });
  }

  return result;
}