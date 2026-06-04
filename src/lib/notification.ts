import { getAllSettingsIPC } from './ipc-client';

/**
 * Check if notifications are enabled in settings
 */
async function areNotificationsEnabled(): Promise<boolean> {
  try {
    const raw = await getAllSettingsIPC();
    return raw.notificationsEnabled !== 'false';
  } catch {
    return true;
  }
}

/**
 * Check if sound effects are enabled in settings
 */
async function areSoundEffectsEnabled(): Promise<boolean> {
  try {
    const raw = await getAllSettingsIPC();
    return raw.soundEffectsEnabled !== 'false';
  } catch {
    return true;
  }
}

/**
 * Play a subtle notification sound
 */
function playNotificationSound(): void {
  try {
    const audioContext = new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.setValueAtTime(880, audioContext.currentTime);
    oscillator.frequency.setValueAtTime(1100, audioContext.currentTime + 0.1);

    gainNode.gain.setValueAtTime(0.1, audioContext.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, audioContext.currentTime + 0.3);

    oscillator.start(audioContext.currentTime);
    oscillator.stop(audioContext.currentTime + 0.3);
  } catch {
    // Ignore audio errors
  }
}

/**
 * Options accepted by showNotification. `actions` is forwarded to the
 * platform notification so the user can reply / allow / deny without
 * switching back to the DUYA window.
 */
export interface ShowNotificationOptions {
  title: string;
  body: string;
  sessionId?: string;
  type?: 'message' | 'permission';
  actions?: { id: string; label: string }[];
  replyPlaceholder?: string;
  permissionId?: string;
  toolName?: string;
}

/**
 * Show a system notification if enabled
 */
export async function showNotification(options: ShowNotificationOptions): Promise<boolean> {
  const enabled = await areNotificationsEnabled();
  if (!enabled) {
    return false;
  }

  // Try Electron native notification first
  if (typeof window !== 'undefined' && window.electronAPI?.notification?.show) {
    try {
      const result = await window.electronAPI.notification.show(options);
      if (result) {
        const soundEnabled = await areSoundEffectsEnabled();
        if (soundEnabled) {
          playNotificationSound();
        }
        return true;
      }
    } catch {
      // Fall through to Web Notification API
    }
  }

  // Fallback to Web Notification API — actions / replyPlaceholder are
  // silently dropped, the basic click-to-focus behavior still works.
  if (typeof window !== 'undefined' && 'Notification' in window) {
    try {
      const permission = await Notification.requestPermission();
      if (permission === 'granted') {
        new Notification(options.title, {
          body: options.body,
          icon: '/icon.png',
        });
        const soundEnabled = await areSoundEffectsEnabled();
        if (soundEnabled) {
          playNotificationSound();
        }
        return true;
      }
    } catch {
      // Ignore notification errors
    }
  }

  return false;
}

/**
 * Show a message completion notification. Provides a "Reply" action so
 * the user can answer from the system tray without refocusing the
 * window (the typed text is delivered via `onNotificationAction` with
 * `actionId === '__reply'`).
 */
export async function showMessageCompletionNotification(
  sessionId?: string,
  sessionTitle?: string,
): Promise<boolean> {
  const title = sessionTitle || 'DUYA';
  return showNotification({
    title,
    body: 'Message completed',
    sessionId,
    type: 'message',
    actions: [{ id: 'open', label: 'Open' }, { id: 'reply', label: 'Reply' }],
    replyPlaceholder: 'Type a reply…',
  });
}

/**
 * Show a permission-request notification. Renders the request as a
 * system notification with Allow / Deny actions so the user can decide
 * from the tray. The decision is delivered through `onNotificationAction`
 * keyed by `actionId`; the caller is responsible for routing it to
 * `usePermissions.respondToPermission`.
 */
export async function showPermissionNotification(args: {
  sessionId: string;
  permissionId: string;
  toolName: string;
  title?: string;
  body?: string;
}): Promise<boolean> {
  return showNotification({
    title: args.title ?? 'Permission required',
    body: args.body ?? `Allow ${args.toolName} to run?`,
    sessionId: args.sessionId,
    type: 'permission',
    permissionId: args.permissionId,
    toolName: args.toolName,
    actions: [
      { id: 'allow', label: 'Allow' },
      { id: 'deny', label: 'Deny' },
    ],
  });
}

/**
 * Test notification - used in settings to verify notifications work
 */
export async function testNotification(): Promise<boolean> {
  return showNotification({
    title: 'DUYA',
    body: 'This is a test notification',
  });
}
