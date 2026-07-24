/**
 * Web Push subscription helper.
 *
 * Platform reality worth knowing when this "doesn't work":
 *  - Android/Chrome: works in the browser and installed. No caveats.
 *  - iOS/Safari: only once the app is added to the Home Screen (iOS 16.4+).
 *    In a Safari tab `PushManager` is simply absent, which is why we report
 *    `needsInstall` rather than a generic failure — the fix is to install it.
 *  - Any browser: the permission prompt must come from a real tap.
 */

import { api } from './api';

/** VAPID keys travel as base64url; the subscribe call needs raw bytes. */
function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = window.atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

export function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

export function isIos() {
  return /iphone|ipad|ipod/i.test(window.navigator.userAgent);
}

/**
 * What this device can do right now. `state` is one of:
 *   unsupported | needs-install | default | granted | denied
 */
export function pushSupport() {
  const hasSw = 'serviceWorker' in navigator;
  const hasPush = 'PushManager' in window && 'Notification' in window;

  if (!hasSw || !hasPush) {
    // On iOS this is almost always "not installed yet" rather than "never".
    if (isIos() && !isStandalone()) return { supported: false, state: 'needs-install' };
    return { supported: false, state: 'unsupported' };
  }
  return { supported: true, state: Notification.permission };
}

export async function getPermissionState() {
  return pushSupport().state;
}

/**
 * Asks for permission and registers this device. Must be called from a click.
 * Returns { ok, state, reason }.
 */
export async function enablePush() {
  const support = pushSupport();
  if (!support.supported) return { ok: false, state: support.state };

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return { ok: false, state: permission };

  const { publicKey, enabled } = await api.get('/api/notifications/push/public-key');
  if (!enabled || !publicKey) return { ok: false, state: 'server-not-configured' };

  const registration = await navigator.serviceWorker.ready;

  // Reuse an existing subscription when there is one; re-subscribing with a
  // different key would silently break delivery to this device.
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(publicKey),
    });
  }

  await api.post('/api/notifications/push/subscribe', { subscription: subscription.toJSON() });
  return { ok: true, state: 'granted' };
}

export async function disablePush() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.ready;
  const subscription = await registration.pushManager.getSubscription();
  if (!subscription) return;
  await api.post('/api/notifications/push/unsubscribe', { endpoint: subscription.endpoint }).catch(() => {});
  await subscription.unsubscribe().catch(() => {});
}

export async function sendTestPush() {
  return api.post('/api/notifications/push/test');
}

/**
 * Keeps the server's copy of this device's subscription fresh on every load.
 * Browsers can rotate or drop a subscription silently; without this a device
 * would look subscribed while quietly receiving nothing.
 */
export async function resyncSubscription() {
  try {
    if (!pushSupport().supported || Notification.permission !== 'granted') return;
    const registration = await navigator.serviceWorker.ready;
    const subscription = await registration.pushManager.getSubscription();
    if (subscription) {
      await api.post('/api/notifications/push/subscribe', { subscription: subscription.toJSON() });
    }
  } catch (err) {
    /* non-fatal: in-app notifications still work */
  }
}
