/**
 * Session-aware API client.
 * Every request carries the session capability when one is held; a 401 raises a
 * single unauthorized signal so the app can open the PIN gate.
 */

export const SESSION_STORAGE_KEY = 'utrans_session_token';
export const HOST_STORAGE_KEY = 'utrans_host_token';
/**
 * The device's own secret for "remember this device" trust. It lives in
 * localStorage rather than sessionStorage because the whole point is to survive a
 * restart; the server only ever stores its hash.
 */
export const DEVICE_TOKEN_KEY = 'utrans_device_token';
export const UNAUTHORIZED_EVENT = 'utrans:unauthorized';

function defaultStorage() {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
}

function defaultDeviceStorage() {
  return typeof localStorage === 'undefined' ? null : localStorage;
}

/** 256-bit random hex, matching the server's `^[a-f0-9]{64}$` contract. */
function generateDeviceToken() {
  const bytes = new Uint8Array(32);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function isSameOriginRequest(url) {
  if (!url || typeof url !== 'string') return false;
  if (url.startsWith('/') && !url.startsWith('//')) return true;
  if (typeof window !== 'undefined' && window.location?.origin) {
    try {
      const parsed = new URL(url, window.location.origin);
      return parsed.origin === window.location.origin;
    } catch {
      return false;
    }
  }
  // In non-browser environments where relative paths are used
  return !url.includes('://');
}

/**
 * @param {{ storage?: object|null, fetchImpl?: Function, onUnauthorized?: Function }} [options]
 */
export function createApiClient({
  storage = defaultStorage(),
  deviceStorage = defaultDeviceStorage(),
  fetchImpl,
  onUnauthorized = null,
} = {}) {
  const doFetch = fetchImpl || ((url, options) => fetch(url, options));
  let notified = false;

  function getToken() {
    return storage?.getItem(SESSION_STORAGE_KEY) || '';
  }

  function getHostToken() {
    return storage?.getItem(HOST_STORAGE_KEY) || '';
  }

  /** Returns this device's token, minting one on first use so trust can be remembered. */
  function getDeviceToken() {
    if (!deviceStorage) return '';
    let token = deviceStorage.getItem(DEVICE_TOKEN_KEY);
    if (!/^[a-f0-9]{64}$/.test(token || '')) {
      token = generateDeviceToken();
      try {
        deviceStorage.setItem(DEVICE_TOKEN_KEY, token);
      } catch {
        // A storage-blocked browser still works; it just cannot be remembered.
      }
    }
    return token;
  }

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (isSameOriginRequest(url)) {
      const token = getToken();
      if (token && !headers.has('X-Session-Token')) {
        headers.set('X-Session-Token', token);
      }
      const hostToken = getHostToken();
      if (hostToken && !headers.has('X-Host-Token')) {
        headers.set('X-Host-Token', hostToken);
      }
      const deviceToken = getDeviceToken();
      if (deviceToken && !headers.has('X-Device-Token')) {
        headers.set('X-Device-Token', deviceToken);
      }
    }

    const response = await doFetch(url, { ...options, headers });

    if (response.status === 401) {
      if (!notified) {
        notified = true;
        if (onUnauthorized) onUnauthorized(response);
      }
    } else {
      notified = false;
    }

    return response;
  }

  return {
    apiFetch,
    getToken,
    getHostToken,
    getDeviceToken,
    setToken(token) {
      if (token) storage?.setItem(SESSION_STORAGE_KEY, token);
    },
    clearToken() {
      storage?.removeItem(SESSION_STORAGE_KEY);
      notified = false;
    },
    setHostToken(token) {
      if (token) storage?.setItem(HOST_STORAGE_KEY, token);
    },
    clearHostToken() {
      storage?.removeItem(HOST_STORAGE_KEY);
    },
    resetUnauthorizedNotification() {
      notified = false;
    },
  };
}

let sharedClient = null;

/** Shared browser client wired to sessionStorage and a window-level event. */
export function apiClient() {
  if (!sharedClient) {
    sharedClient = createApiClient({
      onUnauthorized: () => {
        if (typeof globalThis.dispatchEvent === 'function') {
          globalThis.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
        }
      },
    });
  }
  return sharedClient;
}

export function apiFetch(url, options) {
  return apiClient().apiFetch(url, options);
}

export function getSessionToken() {
  return apiClient().getToken();
}

export function setSessionToken(token) {
  apiClient().setToken(token);
}

export function clearSessionToken() {
  apiClient().clearToken();
}

export function getHostToken() {
  return apiClient().getHostToken();
}

export function getDeviceToken() {
  return apiClient().getDeviceToken();
}

export function setHostToken(token) {
  apiClient().setHostToken(token);
}

export function clearHostToken() {
  apiClient().clearHostToken();
}

export function resetUnauthorizedNotification() {
  apiClient().resetUnauthorizedNotification();
}
