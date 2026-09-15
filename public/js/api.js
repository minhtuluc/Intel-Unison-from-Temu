/**
 * Session-aware API client.
 * Every request carries the session capability when one is held; a 401 raises a
 * single unauthorized signal so the app can open the PIN gate.
 */

export const SESSION_STORAGE_KEY = 'utrans_session_token';
export const HOST_STORAGE_KEY = 'utrans_host_token';
export const UNAUTHORIZED_EVENT = 'utrans:unauthorized';

function defaultStorage() {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
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

export function setHostToken(token) {
  apiClient().setHostToken(token);
}

export function clearHostToken() {
  apiClient().clearHostToken();
}

export function resetUnauthorizedNotification() {
  apiClient().resetUnauthorizedNotification();
}
