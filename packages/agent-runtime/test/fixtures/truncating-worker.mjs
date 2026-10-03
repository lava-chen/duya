// A worker that dies mid-frame, on purpose.
//
// The subprocess transport's truncation path is otherwise unreachable from a
// test: a real worker that is killed between two writes is a race, and a race
// in a test is a flake. This program makes the fault deterministic by writing
// half of a frame, flushing, and then calling `process.exit()` -- which is
// exactly what a SIGKILLed worker leaves behind on the pipe.
//
// It deliberately does NOT import the worker's `sendEvent`. The point is the
// transport's RESPONSE to a truncated stream, and a real `sendEvent` would
// always terminate its frame, so the fault has to be manufactured here.

process.stdout.write('{"type":"chat:text","messageId":"m1","content":"half a fra');
// Give the bytes a chance to reach the pipe before the process disappears.
setTimeout(() => {
  process.exit(9);
}, 20);
