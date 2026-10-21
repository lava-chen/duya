// Lightweight Prism setup (plan 426 Phase 5.1).
//
// The full `Prism` export bundles refractor with every (~290) language,
// which dominates the vendor-markdown chunk. `PrismLight` ships zero
// languages; we register only the common ones below. Unregistered
// languages silently fall back to plain text (react-syntax-highlighter
// wraps refractor.highlight in try/catch).
//
// Shared by chat CodeBlock and the FilePreviewPanel so both renderers
// use the same registered set.

import { PrismLight } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import c from 'react-syntax-highlighter/dist/esm/languages/prism/c';
import cpp from 'react-syntax-highlighter/dist/esm/languages/prism/cpp';
import csharp from 'react-syntax-highlighter/dist/esm/languages/prism/csharp';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import diff from 'react-syntax-highlighter/dist/esm/languages/prism/diff';
import go from 'react-syntax-highlighter/dist/esm/languages/prism/go';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import jsx from 'react-syntax-highlighter/dist/esm/languages/prism/jsx';
import markdown from 'react-syntax-highlighter/dist/esm/languages/prism/markdown';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import rust from 'react-syntax-highlighter/dist/esm/languages/prism/rust';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import tsx from 'react-syntax-highlighter/dist/esm/languages/prism/tsx';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';

const COMMON_LANGUAGES = [
  bash, c, cpp, csharp, css, diff, go, java, javascript, json,
  jsx, markdown, markup, python, rust, sql, tsx, typescript, yaml,
];

for (const language of COMMON_LANGUAGES) {
  // The name argument is ignored by refractor's register(); each language
  // module carries its own displayName + aliases (ts, js, py, rs, cs, sh,
  // html, xml, yml, md, console, ...), which get registered automatically.
  PrismLight.registerLanguage(String(language?.displayName ?? ''), language);
}

export { PrismLight as SyntaxHighlighter };
