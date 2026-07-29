/**
 * Passkey (Face ID / fingerprint) helpers, wrapping @simplewebauthn/browser.
 *
 * Availability:
 *  - iPhone: iOS 16+, in Safari or installed — no Home-Screen requirement (unlike
 *    push). Face ID is the unlock gesture.
 *  - Android: Chrome, fingerprint/face, installed or in-browser.
 * The prompt must come from a user tap, so these are only ever called from a
 * button handler.
 */

import { startRegistration, startAuthentication, browserSupportsWebAuthn } from '@simplewebauthn/browser';
import { api, auth as authApi } from './api';

export function passkeySupported() {
  return browserSupportsWebAuthn();
}

/** Register this device's biometric for the signed-in user. */
export async function registerPasskey(deviceLabel) {
  const options = await api.post('/api/auth/webauthn/register/options');
  const credential = await startRegistration({ optionsJSON: options });
  return api.post('/api/auth/webauthn/register/verify', { credential, deviceLabel });
}

/** Sign in with a passkey — the phone offers its saved credentials, no username. */
export async function loginWithPasskey() {
  const options = await authApi.webauthnLoginOptions();
  const credential = await startAuthentication({ optionsJSON: options });
  return authApi.webauthnLoginVerify(credential);
}

export const passkeyDevices = {
  list: () => api.get('/api/auth/webauthn/devices'),
  remove: (id) => api.del(`/api/auth/webauthn/devices/${id}`),
};
