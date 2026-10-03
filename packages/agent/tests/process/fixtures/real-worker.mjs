// The REAL worker frame source, as a standalone program.
//
// ## Why this exists in `packages/agent/tests/process/fixtures/`
//
// The subprocess transport's framing has to be proven against a real worker's
// output, and "a real worker" means the worker's own `sendEvent` -- the function
// that does `JSON.stringify`, injects `_logger: 'worker'`, escapes embedded
// newlines and writes to `process.stdout`. Every property that makes framing
// non-trivial lives in that function, and a hand-written fixture that omitted
// them would be a fixture shaped to pass.
//
// The location is not arbitrary. The architecture checker resolves module edges
// by package identity anywhere in the tree, so a fixture under
// `packages/agent-runtime` (a `managed: true` module) or under `e2e` that
// reaches `packages/agent` is a NEW blocking `module-dependency` violation --
// measured, not assumed: both placements were tried and both were refused. Here
// the import is RELATIVE and stays inside the module that owns the worker, so
// the gate is unchanged at `module-dependency` 559.
//
// ## The two channels are real and separate
//
// stdout carries frames and NOTHING else. stderr carries diagnostics. Commands
// arrive on stdin. That is the same split the real worker has, and it is the
// arrangement that makes "control does not travel the event channel" a property
// of this program rather than a claim about it: there is no path from a stdin
// command to stdout other than the framing under test.
//
// Usage: node real-worker.mjs
//   stdin  : one JSON command per line.
//            {cmd:'start', frames:[...], private:{...}, fragment:N}
//            {cmd:'stop'}  {cmd:'close'}
//   stdout : one real `sendEvent` frame per line.
//   stderr : diagnostics.

import { createInterface } from 'node:readline';
import { sendEvent } from '../../../dist/process/worker-protocol.js';

/**
 * Emit frames, optionally forcing the OS to split them.
 *
 * `fragment` is the number of BYTES handed to a single `write` call. It exists
 * because "chunk boundaries" cannot be tested by a real pipe on demand: a pipe
 * coalesces, and on a fast producer with a fast reader the whole scenario can
 * arrive in one chunk. Setting `fragment: 1` makes the worker write one byte at
 * a time, which splits every frame, every newline, and every multi-byte
 * character boundary. That is the adversarial case a decoder is most likely to
 * get wrong and the one a real pipe will not produce for us.
 */
function emit(frames, fragment) {
  if (!fragment || fragment <= 0) {
    for (const frame of frames) sendEvent(frame);
    return;
  }
  // Re-implementing the write is not allowed here -- this program must produce
  // REAL output. So the fragmentation is applied by capturing what the real
  // `sendEvent` produced and re-emitting those exact bytes in small pieces.
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
  for (let i = 0; i < all.length; i += fragment) {
    original(all.subarray(i, Math.min(i + fragment, all.length)));
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
    // The private config is acknowledged on STDERR, never echoed to stdout.
    // A credential that reached the event channel would be in the frame log,
    // and the test asserts on stdout's exact bytes, so this separation is what
    // makes that assertion meaningful rather than hopeful.
    if (command.private) {
      const keys = Object.keys(command.private).sort().join(',');
      process.stderr.write(`private-config-accepted:${keys}\n`);
    }
    emit(command.frames ?? [], command.fragment ?? 0);
    process.stderr.write(`frames-emitted:${(command.frames ?? []).length}\n`);
    // A scenario that CONTAINS A TERMINAL is a finished run, and a finished
    // run's worker exits -- which is what lets the host's stdout reach 'end'.
    // Without this the child stays alive after the last frame and the host has
    // no way to tell "the run is over" from "the worker is quiet", which is the
    // real distinction a transport has to preserve.
    const frames = command.frames ?? [];
    if (frames.some((f) => f && f.type === 'chat:done')) break;
  } else if (command.cmd === 'flood') {
    // Emit far more than an OS pipe buffer holds, then STAY OPEN.
    //
    // This is what makes the two-pipes claim measurable rather than asserted:
    // while the host is still working through a backed-up stdout, a command on
    // STDIN still has to arrive. `stayOpen` matters as much as the volume --
    // a worker that exited would empty the pipe and prove nothing.
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
    emit(command.frames ?? [], command.fragment ?? 0);
  } else if (command.cmd === 'close') {
    break;
  } else {
    process.stderr.write(`unknown-command:${String(command.cmd)}\n`);
  }
}

process.exit(0);
