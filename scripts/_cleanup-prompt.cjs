const fs = require('fs');
const path = 'packages/agent/src/compact/strategies/SessionMemoryCompactStrategy.ts';
let s = fs.readFileSync(path, 'utf8');
const NL = '\r\n';
const startAnchor = '/**' + NL + ' * Default session memory prompt - structured extraction';
const startIdx = s.indexOf(startAnchor);
if (startIdx === -1) { console.error('start anchor not found'); process.exit(1); }
const endAnchor = 'Respond with text only (the JSON).`;';
const endIdx = s.indexOf(endAnchor, startIdx);
if (endIdx === -1) { console.error('end anchor not found'); process.exit(1); }
const sliceEnd = endIdx + endAnchor.length;
const removeEnd = sliceEnd + (s.substr(sliceEnd, 2) === NL ? 2 : 0);
const removedLen = removeEnd - startIdx;
s = s.slice(0, startIdx) + s.slice(removeEnd);
const configLine = '      summarizationPrompt: config.summarizationPrompt ?? DEFAULT_SESSION_MEMORY_PROMPT,' + NL;
if (!s.includes(configLine)) { console.error('config line not found'); process.exit(1); }
s = s.replace(configLine, '');
fs.writeFileSync(path, s);
console.log('OK, removed ' + removedLen + ' chars of prompt block + config line');
