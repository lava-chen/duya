import { describe, expect, it } from 'vitest';

import { decodeFrame, encodeFrame } from '../websocket-client';

// The pbbp2.Frame wire format is pinned by the official SDKs
// (oapi-sdk-go ws/pbbp2.pb.go). These golden bytes were hand-derived from
// the protobuf definition: field1 SeqID varint, 2 LogID varint,
// 3 Service varint, 4 Method varint, 5 repeated Header{1 key, 2 value},
// 8 Payload bytes.
const GOLDEN_PING = Buffer.from([
  0x08, 0x00, // field1 (SeqID) = 0
  0x10, 0x00, // field2 (LogID) = 0
  0x18, 0x05, // field3 (Service) = 5
  0x20, 0x00, // field4 (Method) = 0 (CONTROL)
  0x2a, 0x0c, // field5 (Headers), length 12
  0x0a, 0x04, 0x74, 0x79, 0x70, 0x65, // Header key "type"
  0x12, 0x04, 0x70, 0x69, 0x6e, 0x67, // Header value "ping"
]);

describe('Feishu WS frame codec (pbbp2 protobuf)', () => {
  it('decodes the golden PING control frame', () => {
    const frame = decodeFrame(GOLDEN_PING);
    expect(frame).not.toBeNull();
    expect(frame!.method).toBe(0);
    expect(frame!.service).toBe(5n);
    expect(frame!.headers).toEqual([{ key: 'type', value: 'ping' }]);
    expect(frame!.payload.length).toBe(0);
  });

  it('re-encodes the golden PING byte-identically', () => {
    const frame = decodeFrame(GOLDEN_PING)!;
    expect(encodeFrame(frame).equals(GOLDEN_PING)).toBe(true);
  });

  it('round-trips a DATA event frame with payload and multi headers', () => {
    const frame = {
      seqId: 7n,
      logId: 42n,
      service: 9n,
      method: 1, // DATA
      headers: [
        { key: 'type', value: 'event' },
        { key: 'message_id', value: 'm-1' },
        { key: 'sum', value: '1' },
        { key: 'seq', value: '0' },
      ],
      payload: Buffer.from(JSON.stringify({ header: { event_type: 'im.message.receive_v1' } }), 'utf-8'),
    };
    const decoded = decodeFrame(encodeFrame(frame))!;
    expect(decoded.seqId).toBe(7n);
    expect(decoded.logId).toBe(42n);
    expect(decoded.service).toBe(9n);
    expect(decoded.method).toBe(1);
    expect(decoded.headers).toEqual(frame.headers);
    expect(JSON.parse(decoded.payload.toString('utf-8')).header.event_type).toBe('im.message.receive_v1');
  });

  it('rejects garbage as null instead of throwing', () => {
    expect(decodeFrame(Buffer.from([0xff, 0xff, 0xff]))).toBeNull();
  });
});
