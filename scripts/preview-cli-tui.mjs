#!/usr/bin/env node
/** Inspect the real TUI in a local xterm backed by a Windows/Unix PTY. */
import { createServer } from 'node:http';
import { readFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { build } from 'esbuild';
import { WebSocketServer } from 'ws';
import pty from 'node-pty';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const artifactDir = resolve(root, 'output/playwright/tui-foundation');
mkdirSync(artifactDir, { recursive: true });
const fixture = resolve(artifactDir, 'fixture.cjs');
await build({
  entryPoints: [resolve(root, 'packages/cli/src/tui/dev/preview.ts')],
  outfile: fixture,
  platform: 'node',
  format: 'cjs',
  bundle: true,
  define: { 'import.meta.url': JSON.stringify(pathToFileURL(fixture).href) },
  external: ['blessed', '@iarna/toml'],
  alias: { '@duya/input-completion': resolve(root, 'packages/input-completion/src/index.ts') },
  logLevel: 'warning',
});
if (process.argv.includes('--build-only')) process.exit(0);

const xtermRoot = resolve(dirname(require.resolve('@xterm/xterm')), '..');
const html = `<!doctype html><html><head><meta charset="utf-8">
<link rel="stylesheet" href="/xterm.css"><style>
html,body{margin:0;background:#171717;color:#aaa;font:13px system-ui}
header{padding:12px 20px;border-bottom:1px solid #333}#terminal{padding:16px}
</style></head><body><header>Duya TUI · local PTY fixture · no model calls</header>
<div id="terminal"></div><script src="/xterm.js"></script><script>
const args=new URLSearchParams(location.search);
const cols=Number(args.get('cols')||100),rows=Number(args.get('rows')||28);
const term=new Terminal({cols,rows,fontSize:16,fontFamily:'Consolas, "Microsoft YaHei", monospace',
 cursorBlink:false,allowProposedApi:true,theme:{background:'#171717',foreground:'#dedbd5',cursor:'#e8a477'}});
term.open(document.getElementById('terminal'));term.focus();window.term=term;
const ws=new WebSocket('ws://'+location.host+'/?'+args);
ws.onmessage=e=>term.write(e.data,()=>document.body.dataset.ready='true');
term.onData(data=>ws.send(JSON.stringify({data})));
window.resizeTerminal=(columns,lines)=>{term.resize(columns,lines);ws.send(JSON.stringify({cols:columns,rows:lines}))};
window.screenText=()=>Array.from({length:term.rows},(_,i)=>term.buffer.active.getLine(term.buffer.active.viewportY+i)?.translateToString(true)||'').join('\\n');
</script></body></html>`;

const server = createServer((request, response) => {
  if (request.url === '/xterm.js') {
    response.setHeader('Content-Type', 'text/javascript');
    response.end(readFileSync(resolve(xtermRoot, 'lib/xterm.js')));
  } else if (request.url === '/xterm.css') {
    response.setHeader('Content-Type', 'text/css');
    response.end(readFileSync(resolve(xtermRoot, 'css/xterm.css')));
  } else {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(html);
  }
});
const sockets = new WebSocketServer({ server });
const terminals = new Set();
sockets.on('connection', (socket, request) => {
  const args = new URL(request.url ?? '/', 'http://localhost').searchParams;
  const previewEnv = { ...process.env };
  delete previewEnv['NO_COLOR'];
  const terminal = pty.spawn(process.execPath, [fixture], {
    name: 'xterm-256color', cwd: root,
    cols: Number(args.get('cols') || 100), rows: Number(args.get('rows') || 28),
    env: { ...previewEnv, TERM: 'xterm-256color', COLORTERM: 'truecolor',
      DUYA_TUI_INLINE: args.get('mode') === 'fullscreen' ? '0' : '1', FORCE_COLOR: '1' },
  });
  terminals.add(terminal);
  terminal.onData((data) => { if (socket.readyState === 1) socket.send(data); });
  terminal.onExit(() => { terminals.delete(terminal); socket.close(); });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString());
    if (typeof message.data === 'string') terminal.write(message.data);
    if (Number.isInteger(message.cols) && Number.isInteger(message.rows)) {
      terminal.resize(Math.max(1, Math.min(300, message.cols)), Math.max(1, Math.min(100, message.rows)));
    }
  });
  socket.on('close', () => { terminals.delete(terminal); terminal.kill(); });
});
server.listen(0, '127.0.0.1', () => {
  process.stdout.write('TUI preview: http://127.0.0.1:' + server.address().port + '\n');
});
function close() {
  for (const terminal of terminals) terminal.kill();
  sockets.close();
  server.close();
}
process.on('SIGINT', close);
process.on('SIGTERM', close);
