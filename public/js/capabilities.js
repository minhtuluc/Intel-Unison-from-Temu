/**
 * Browser capability detection.
 *
 * The app runs over plain HTTP on a LAN, which is not a secure context. Several
 * APIs still *exist* in that situation while their call rejects — `navigator.wakeLock`
 * is the clearest case — so "is the property present" is not enough. Everything here
 * reports support honestly and explains what is missing, so the UI can say why a
 * feature is unavailable instead of failing silently.
 */

/** True in a secure context (HTTPS, localhost, or file://). */
export function isSecureContextOk() {
  if (typeof globalThis.isSecureContext === 'boolean') return globalThis.isSecureContext;
  if (typeof window === 'undefined') return false;
  const protocol = window.location?.protocol;
  return protocol === 'https:' || protocol === 'file:';
}

/** The offline shell and PWA install both require a service worker. */
export function supportsServiceWorker() {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return false;
  return isSecureContextOk();
}

/** Screen wake lock is secure-context only, and rejects rather than throws when absent. */
export function supportsWakeLock() {
  if (typeof navigator === 'undefined' || !('wakeLock' in navigator)) return false;
  return isSecureContextOk();
}

/** @returns {{ secureContext: boolean, serviceWorker: boolean, wakeLock: boolean, pwaInstall: boolean }} */
export function getCapabilities() {
  const secureContext = isSecureContextOk();
  return {
    secureContext,
    serviceWorker: supportsServiceWorker(),
    wakeLock: supportsWakeLock(),
    pwaInstall: supportsServiceWorker(),
  };
}

/**
 * Capabilities this browser cannot offer, each with a reason a person can act on.
 * Empty when everything is available.
 * @returns {Array<{ key: string, message: string }>}
 */
export function describeMissingCapabilities() {
  const capabilities = getCapabilities();
  const missing = [];

  if (!capabilities.secureContext) {
    missing.push({
      key: 'secureContext',
      message:
        'This page is open over plain HTTP on the LAN. The browser withholds install and screen-wake features outside a secure context.',
    });
    return missing;
  }

  if (!capabilities.serviceWorker) {
    missing.push({
      key: 'serviceWorker',
      message: 'This browser has no service worker support, so the app cannot be installed.',
    });
  }
  if (!capabilities.wakeLock) {
    missing.push({
      key: 'wakeLock',
      message: 'Screen wake lock is unavailable, so the screen may sleep during a long transfer.',
    });
  }
  return missing;
}
