// The real worker frame source for agent-runtime's subprocess tests.
//
// This fixture imports the Host's built sendEvent implementation. The previous
// fixture imported packages/agent/dist, but @duya/agent is retired and is no
// longer part of the normal package build. The protocol assertions stay the
// same while following the worker that Desktop, Web and CLI actually run.

import { createInterface } from 'node:readline';
import { sendEvent } from '../../dist/worker-transport.js';

async function emit(frames, fragment) {
  // Capture the real sendEvent bytes, then write those exact bytes to stdout.
  // Optional fragmentation forces decoder coverage for split newlines and
  // UTF-8 characters; callbacks ensure the child exits only after the bytes
  // have reached the pipe.
  const captured = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = (chunk) => {
    captured.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(String(chunk), 'utf8'));
    return true;
  };
  try {
    for (const frame of frames) sendEvent(frame);
  } finally {
    process.stdout.write = original;
  }
  const all = Buffer.concat(captured);
  const chunkSize = fragment && fragment > 0 ? fragment : all.length;
  for (let i = 0; i < all.length; i += chunkSize) {
    const chunk = all.subarray(i, Math.min(i + chunkSize, all.length));
    await new Promise((resolve, reject) => {
      original(chunk, (error) => error ? reject(error) : resolve());
    });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of rl) {
  if (!line.trim()) continue;
  let command;
  try {
    command = JSON.parse(line);
  } catch (error) {
    process.stderr.write(`unparseable command: ${String(error)}\n`);
    continue;
  }

  if (command.cmd === 'start') {
    if (command.private) {
      const keys = Object.keys(command.private).sort().join(',');
      process.stderr.write(`private-config-accepted:${keys}\n`);
    }
    await emit(command.frames ?? [], command.fragment ?? 0);
    process.stderr.write(`frames-emitted:${(command.frames ?? []).length}\n`);
    if ((command.frames ?? []).some((frame) => frame && frame.type === 'chat:done')) {
      rl.close();
      process.exit(0);
    }
  } else if (command.cmd === 'flood') {
    const count = command.count ?? 200;
    const size = command.size ?? 4096;
    const filler = 'x'.repeat(size);
    for (let i = 0; i < count; i += 1) {
      sendEvent({ type: 'chat:text', messageId: `flood-${i}`, content: filler });
    }
    process.stderr.write(`flooded:${count}\n`);
  } else if (command.cmd === 'stop') {
    process.stderr.write('stop-acknowledged\n');
    sendEvent({ type: 'chat:done', status: 'cancelled' });
  } else if (command.cmd === 'emit') {
    await emit(command.frames ?? [], command.fragment ?? 0);
  } else if (command.cmd === 'close') {
    break;
  } else {
    process.stderr.write(`unknown-command:${String(command.cmd)}\n`);
  }
}
