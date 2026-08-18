// src/lib/voice/errors.ts — Chinese-facing error copy for the voice pipeline.
import type { VoiceErrorCode } from './types';

export interface StartErrorDescriptor {
  code: VoiceErrorCode;
  message: string;
}

/** Map a `voice:start` failure to a user-facing code + Chinese message. */
export function describeStartError(error?: string, message?: string): StartErrorDescriptor {
  switch (error) {
    case 'voice_disabled':
      return { code: 'model_not_ready', message: '语音输入未启用：请在 设置 → 语音输入 中开启' };
    case 'model_not_ready':
      return {
        code: 'model_not_ready',
        message: message ? `语音模型未就绪：${message}（可在设置中一键安装）` : '语音模型未就绪，请在设置中安装',
      };
    case 'cloud_engine_not_ready':
      return { code: 'model_not_ready', message: '云端语音识别未就绪：请在设置中选择 provider 并确认 API Key' };
    case 'permission_denied':
      return { code: 'permission_denied', message: '麦克风权限被拒绝，请在系统设置中允许 DUYA 访问麦克风' };
    case 'network':
      return { code: 'network', message: '网络异常，语音请求失败，请稍后重试' };
    default:
      return { code: 'internal', message: message ?? '语音识别启动失败' };
  }
}

/** Chinese copy for Main-side voice error events. */
export const VOICE_ERROR_MESSAGES: Record<VoiceErrorCode, string> = {
  no_speech: '未检测到语音输入',
  permission_denied: '麦克风权限被拒绝',
  model_not_ready: '语音模型未就绪，请在设置中安装',
  network: '网络异常，语音请求失败',
  internal: '语音识别内部错误',
};
