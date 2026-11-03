const fs = require('fs');

const f = 'C:/Users/lavachen/.duya/sessions/2026/11/03/rollout-2026-11-03T00-46-33-848Z-38638d10-f10a-4e2e-8369-2ca0b83ee867.jsonl';
const lines = fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean);

let msgRows = 0;
let cards = 0;
const rows = [];
for (let i = 0; i < lines.length; i += 1) {
  let o;
  try { o = JSON.parse(lines[i]); } catch { continue; }
  if (o.type !== 'message') continue;
  msgRows += 1;
  const m = o.message || {};
  const cs = Array.isArray(m.content) ? m.content : [{ type: 'text', text: m.content }];
  const isCard = m.msg_type === 'tool-approval' || cs.some((c) => c.type === 'text' && typeof c.text === 'string' && c.text.startsWith('Approval needed:'));
  if (isCard) cards += 1;
  rows.push({ line: i + 1, role: m.role, msg_type: m.msg_type, card: isCard });
}

console.log('persisted message rows total:', msgRows, '| approval cards:', cards);

// 同步发生点：run 6b5b1469 从 rollout 第 56 行(prompt_snapshot)开始
const syncLine = 56;
const before = rows.filter((r) => r.line < syncLine);
console.log('\n--- BEFORE the 00:50:30 DB resync (rollout line < 56) ---');
console.log('persisted rows:', before.length, '| approval cards among them:', before.filter((r) => r.card).length);
console.log('non-card roles:', JSON.stringify(before.filter((r) => !r.card).reduce((a, r) => { a[r.role + '/' + (r.msg_type || '-')] = (a[r.role + '/' + (r.msg_type || '-')] || 0) + 1; return a; }, {})));

// agent 内存里 39 条 vs DB 54 条
console.log('\nworker log said: agent has 39 messages, DB has 54 -> delta', 54 - 39);
console.log('approval cards persisted before the resync:', before.filter((r) => r.card).length);
console.log('non-card persisted rows before resync:', before.filter((r) => !r.card).length);
