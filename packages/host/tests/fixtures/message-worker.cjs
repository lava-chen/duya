'use strict';

/**
 * A stand-in worker that sends ONE frame over the IPC channel, so the
 * supervisor's frame fan-out can be tested through the REAL child rather than
 * by calling a private method.
 *
 * The frame type is driven by an env var so one fixture covers both the
 * `compact:*` frames the session-level exits consume and a frame nobody
 * claims:
 *
 *   DUYA_TEST_FRAME_TYPE=compact:done   send that frame type
 *   DUYA_TEST_FRAME_HOLD=1              stay alive after sending
 */

const type = process.env.DUYA_TEST_FRAME_TYPE || 'test:frame';

if (typeof process.send === 'function') {
  process.send({ type, sessionId: process.env.SESSION_ID || '', payload: 'hello' });
}

if (process.env.DUYA_TEST_FRAME_HOLD === '1') {
  setInterval(() => {}, 1000);
} else {
  setTimeout(() => {}, 100);
}
