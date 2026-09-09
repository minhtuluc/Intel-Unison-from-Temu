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
          if (message.event === 'server:pong' && this.lastPingTime) {
            const latency = Math.max(1, Date.now() - this.lastPingTime);
            this._dispatchEvent('latency:update', { latency });
          }
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
    this.sendPing();
    this.pingTimer = setInterval(() => {
      this.sendPing();
    }, 30000);
  }

  sendPing() {
    this.lastPingTime = Date.now();
    this.send('client:ping', {});
  }

  _stopHeartbeat() {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  _registerDevice() {
    let deviceId = localStorage.getItem('utrans_device_id');
    if (!deviceId) {
      deviceId = `dev_${Math.random().toString(36).slice(2, 10)}`;
      localStorage.setItem('utrans_device_id', deviceId);
    }

    const isMobile = /Android|iPhone|iPad|iPod/i.test(navigator.userAgent);
    let platform = 'web';
    if (/iPhone|iPad|iPod/i.test(navigator.userAgent)) platform = 'ios';
    else if (/Android/i.test(navigator.userAgent)) platform = 'android';
    else if (/Windows/i.test(navigator.userAgent)) platform = 'windows';
    else if (/Linux/i.test(navigator.userAgent)) platform = 'linux';
    else if (/Mac/i.test(navigator.userAgent)) platform = 'mac';

    let deviceName = localStorage.getItem('utrans_device_name');
    if (!deviceName) {
      deviceName = isMobile ? `${platform.toUpperCase()} Mobile` : `${platform.toUpperCase()} PC`;
      localStorage.setItem('utrans_device_name', deviceName);
    }

    this.send('client:register', {
      deviceId,
      deviceName,
      platform,
      isHost:
        !isMobile &&
        (window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'),
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
