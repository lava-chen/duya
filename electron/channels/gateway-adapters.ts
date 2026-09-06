/**
 * gateway-adapters.ts — bridge to reuse deep gateway platform adapters inside
 * the electron main process (plan 488, Feishu + Weixin per-bot connectors).
 *
 * The gateway adapters live in `packages/gateway/src/adapters/*` and carry the
 * deep protocol work (Feishu WS/webhook + dedup + text/media batching + stream
 * cards + DM pairing; Weixin iLink long-poll + CDN media + context_token +
 * rate-limit circuit). Reusing the same classes here (instead of re-writing the
 * protocols) keeps the per-bot connectors thin glue on top of battle-tested
 * code.
 *
 * esbuild bundles these `.ts` sources (their internal `.js` ESM specifiers are
 * resolved to `.ts`), so electron main and the packaged app get them without a
 * separate gateway subprocess. Weixin's `wxApi` is instance-based here
 * (`WxApiClient`) so multiple WeChat bots can coexist in one process.
 */

export {
  FeishuChannel,
  createFeishuChannel,
} from '../../packages/gateway/src/adapters/feishu';
export {
  qrRegisterBegin,
  qrRegisterPoll,
  generateQrImage,
} from '../../packages/gateway/src/adapters/feishu/qr-registration';
export type {
  QrRegistrationBegin,
  QrRegistrationResult,
  QrPollInput,
} from '../../packages/gateway/src/adapters/feishu/qr-registration';
export type {
  FeishuConfig,
  FeishuAdapterOptions,
} from '../../packages/gateway/src/adapters/feishu/types';
export { WeixinAdapter } from '../../packages/gateway/src/adapters/weixin';
export {
  createWeixinApiClient,
  getMimeFromFilename,
} from '../../packages/gateway/src/adapters/weixin/api';
export type { WxApiClientConfiguration } from '../../packages/gateway/src/adapters/weixin/api';
export { WeixinStateStore } from '../../packages/gateway/src/adapters/weixin/state-store';
export type {
  NormalizedMessage,
  NormalizedReply,
  PlatformConfig,
  SendResult,
} from '../../packages/gateway/src/types';