/**
 * Session-aware API client.
 * Every request carries the session capability when one is held; a 401 raises a
 * single unauthorized signal so the app can open the PIN gate.
 */

export const SESSION_STORAGE_KEY = 'utrans_session_token';
export const UNAUTHORIZED_EVENT = 'utrans:unauthorized';

function defaultStorage() {
  return typeof sessionStorage === 'undefined' ? null : sessionStorage;
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

  async function apiFetch(url, options = {}) {
    const headers = new Headers(options.headers || {});
    const token = getToken();
    if (token) {
      headers.set('X-Session-Token', token);
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
    setToken(token) {
      if (token) storage?.setItem(SESSION_STORAGE_KEY, token);
    },
    clearToken() {
      storage?.removeItem(SESSION_STORAGE_KEY);
      notified = false;
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

export function resetUnauthorizedNotification() {
  apiClient().resetUnauthorizedNotification();
}
