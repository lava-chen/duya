import { afterEach, expect, it, vi } from 'vitest';
import { FeishuWSClient, decodeFrame } from '../websocket-client';

type Frame = NonNullable<ReturnType<typeof decodeFrame>>;
interface TransportView {
  _handleFrame(frame: Frame): void;
  _writeFrame(frame: Frame): void;
}
afterEach(() => vi.restoreAllMocks());
function fixture(onEvent: () => Promise<void>, durable = true) {
  const client = new FeishuWSClient({ domain: 'feishu', appId: 'app', appSecret: 'secret',
    onEvent, ackAfterHandling: () => durable });
  const wire = client as unknown as TransportView;
  const writes: Frame[] = [];
  wire._writeFrame = (frame) => { writes.push(frame); };
  return { wire, writes };
}
function frame(payload = Buffer.from('{"event":{"message":"hello"}}'), seq = 0, sum = 1): Frame {
  return { seqId: BigInt(seq), logId: 1n, service: 1n, method: 1,
    headers: [{ key: 'type', value: 'event' }, { key: 'message_id', value: 'event-1' },
      { key: 'sum', value: String(sum) }, { key: 'seq', value: String(seq) }], payload };
}

it('holds a WebSocket ACK until the asynchronous durable consumer commits', async () => {
  let commit!: () => void;
  const h = fixture(() => new Promise<void>((resolve) => { commit = resolve; }));
  h.wire._handleFrame(frame());
  expect(h.writes).toEqual([]);
  commit();
  await vi.waitFor(() => expect(h.writes).toHaveLength(1));
  expect(JSON.parse(h.writes[0]!.payload.toString())).toEqual({ code: 200 });
});

it('a rejected admission is not acknowledged and a provider replay can succeed', async () => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const accept = vi.fn().mockRejectedValueOnce(new Error('storage_unavailable')).mockResolvedValue(undefined);
  const h = fixture(accept);
  h.wire._handleFrame(frame());
  await vi.waitFor(() => expect(accept).toHaveBeenCalledTimes(1));
  await Promise.resolve();
  expect(h.writes).toEqual([]);
  h.wire._handleFrame(frame());
  await vi.waitFor(() => expect(h.writes).toHaveLength(1));
  expect(accept).toHaveBeenCalledTimes(2);
});

it('acknowledges all multipart frames only after the reassembled event is accepted', async () => {
  let commit!: () => void;
  const accept = vi.fn(() => new Promise<void>((resolve) => { commit = resolve; }));
  const h = fixture(accept);
  h.wire._handleFrame(frame(Buffer.from('{"event":'), 0, 2));
  expect(h.writes).toEqual([]);
  expect(accept).not.toHaveBeenCalled();
  h.wire._handleFrame(frame(Buffer.from('{"message":"hello"}}'), 1, 2));
  expect(h.writes).toEqual([]);
  expect(accept).toHaveBeenCalledTimes(1);
  commit();
  await vi.waitFor(() => expect(h.writes).toHaveLength(2));
});

it('preserves immediate acknowledgement for legacy consumers', () => {
  const h = fixture(async () => new Promise<void>(() => {}), false);
  h.wire._handleFrame(frame());
  expect(h.writes).toHaveLength(1);
});
