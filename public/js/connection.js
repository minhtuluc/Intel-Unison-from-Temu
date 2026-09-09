/**
 * UniversalTrans WebSocket Connection Manager
 * Handles connection lifecycle, exponential backoff reconnects,
 * heartbeat ping-pong, and event dispatching.
 */

export class ConnectionManager {
  constructor() {
    this.ws = null;
    this.listeners = new Map();
    this.statusListeners = new Set();
    this.status = 'DISCONNECTED';
    this.reconnectAttempts = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
  }

  /**
   * Initializes connection to the server.
   */
  connect() {
    if (
      this.ws &&
      (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)
    ) {
      return;
    }

    this._setStatus(this.reconnectAttempts > 0 ? 'RECONNECTING' : 'CONNECTING');

    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.host;

    // Persist last successful host in localStorage for mobile quick-reconnect
    try {
      localStorage.setItem('utrans_last_host', host);
    } catch {
      // Ignore localStorage errors
    }

    const wsUrl = `${protocol}//${host}/ws`;

    try {
      this.ws = new WebSocket(wsUrl);

      this.ws.onopen = () => {
        this.reconnectAttempts = 0;
        this._setStatus('CONNECTED');
        this._startHeartbeat();
        this._registerDevice();
      };

      this.ws.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          this._dispatchEvent(message.event, message.data);
        } catch {
          // Ignore invalid messages
        }
      };

      this.ws.onclose = () => {
        this._stopHeartbeat();
        this._setStatus('DISCONNECTED');
        this._scheduleReconnect();
      };

      this.ws.onerror = () => {
        this.ws?.close();
      };
    } catch {
      this._scheduleReconnect();
    }
  }

  /**
   * Registers listener for a specific WebSocket event.
   * @param {string} event
   * @param {Function} callback
   */
  on(event, callback) {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event).add(callback);
  }

  /**
   * Removes listener for an event.
   * @param {string} event
   * @param {Function} callback
   */
  off(event, callback) {
    if (this.listeners.has(event)) {
      this.listeners.get(event).delete(callback);
    }
  }

  /**
   * Subscribes to connection status changes.
   * @param {Function} callback
   */
  onStatusChange(callback) {
    this.statusListeners.add(callback);
    callback(this.status);
  }

  /**
   * Sends an event message to server.
   * @param {string} event
   * @param {object} [data={}]
   */
  send(event, data = {}) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify({ event, data, timestamp: new Date().toISOString() }));
    }
  }

  _setStatus(newStatus) {
    this.status = newStatus;
    for (const cb of this.statusListeners) {
      try {
        cb(newStatus);
      } catch {
        // Ignore listener errors
      }
    }
  }

  _scheduleReconnect() {
    if (this.reconnectTimer) return;

    // Exponential backoff: 1s, 2s, 4s, 8s, max 30s
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
    this.reconnectAttempts++;

    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    this.pingTimer = setInterval(() => {
      this.send('client:ping', {});
    }, 30000);
  }

  _stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _registerDevice() {
    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    const platform = /iPhone|iPad|iPod/i.test(navigator.userAgent)
      ? 'iOS'
      : /Android/i.test(navigator.userAgent)
        ? 'Android'
        : /Windows/i.test(navigator.userAgent)
          ? 'Windows'
          : /Linux/i.test(navigator.userAgent)
            ? 'Linux'
            : 'Other';

    this.send('client:register', {
      deviceName: isMobile ? `${platform} Mobile` : `${platform} PC`,
      platform,
      userAgent: navigator.userAgent,
    });
  }

  _dispatchEvent(event, data) {
    if (this.listeners.has(event)) {
      for (const cb of this.listeners.get(event)) {
        try {
          cb(data);
        } catch {
          // Ignore handler error
        }
      }
    }
  }
}

export const connection = new ConnectionManager();
