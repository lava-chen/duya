// src/lib/voice/voice-devices.ts — audio input device enumeration helpers.
//
// Labels are only populated once the user has granted microphone permission
// (browser security behavior); until then devices show generic names.

export interface VoiceInputDevice {
  deviceId: string;
  label: string;
  /** Whether this is the system default input. */
  isDefault: boolean;
}

/** Enumerate audio input devices, falling back to generic labels. */
export async function listAudioInputDevices(): Promise<VoiceInputDevice[]> {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices?.enumerateDevices) {
    return [];
  }
  const devices = await navigator.mediaDevices.enumerateDevices();
  let fallbackIndex = 0;
  return devices
    .filter((d) => d.kind === 'audioinput')
    .map((d) => ({
      deviceId: d.deviceId,
      label: d.label?.trim() || `麦克风 ${++fallbackIndex}`,
      isDefault: d.deviceId === 'default' || d.deviceId === '',
    }));
}

/** Subscribe to device plug/unplug events; returns an unsubscribe fn. */
export function subscribeDeviceChange(cb: () => void): () => void {
  if (typeof navigator === 'undefined' || !navigator.mediaDevices) return () => {};
  const handler = () => cb();
  navigator.mediaDevices.addEventListener('devicechange', handler);
  return () => navigator.mediaDevices.removeEventListener('devicechange', handler);
}
