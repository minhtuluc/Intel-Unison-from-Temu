/**
 * UniversalTrans Client Application Entry
 * SPA Router, state management, initialization, and error boundary.
 */

import { connection } from './connection.js';
import { FileBrowser } from './file-browser.js';
import { createElement, showQrModal, showToast } from './ui.js';

class App {
  constructor() {
    this.serverInfo = null;
    this.currentView = 'files';
    this.fileBrowser = null;
    this.mainContainer = null;
  }

  async init() {
    this.mainContainer = document.getElementById('main-view');
    this.fileBrowser = new FileBrowser(this.mainContainer);

    this._setupNavigation();
    this._setupConnectionEvents();
    this._setupQrModal();
    this._setupErrorBoundary();

    // Fetch initial server info
    await this._fetchServerInfo();

    // Route to initial view from URL hash
    this._handleRoute();

    // Connect WebSocket
    connection.connect();
  }

  async _fetchServerInfo() {
    try {
      const res = await fetch('/api/info');
      const json = await res.json();
      if (json.success && json.data) {
        this.serverInfo = json.data;
        const nameEl = document.getElementById('header-server-name');
        if (nameEl) {
          nameEl.textContent = `${json.data.serverName} (${json.data.ip})`;
        }
      }
    } catch {
      showToast({ type: 'warning', message: 'Could not fetch server info' });
    }
  }

  _setupNavigation() {
    window.addEventListener('hashchange', () => this._handleRoute());

    // Intercept navigation links
    document.querySelectorAll('[data-view]').forEach((link) => {
      link.addEventListener('click', (_e) => {
        const view = link.getAttribute('data-view');
        if (view) {
          window.location.hash = `#${view}`;
        }
      });
    });
  }

  _handleRoute() {
    const hash = window.location.hash.replace('#', '') || 'files';
    this.currentView = hash;

    // Update active class on desktop sidebar and mobile bottom nav
    document.querySelectorAll('[data-view]').forEach((link) => {
      const view = link.getAttribute('data-view');
      const isDesktop = link.classList.contains('nav-link');
      const activeClass = isDesktop ? 'nav-link--active' : 'bottom-nav__link--active';

      if (view === hash) {
        link.classList.add(activeClass);
      } else {
        link.classList.remove(activeClass);
      }
    });

    this._renderCurrentView();
  }

  _renderCurrentView() {
    if (!this.mainContainer) return;

    switch (this.currentView) {
      case 'files':
        this.fileBrowser.loadFiles();
        break;

      case 'upload':
        this._renderUploadPlaceholder();
        break;

      case 'transfers':
        this._renderTransfersPlaceholder();
        break;

      case 'devices':
        this._renderDevicesPlaceholder();
        break;

      default:
        this.fileBrowser.loadFiles();
        break;
    }
  }

  _renderUploadPlaceholder() {
    this.mainContainer.innerHTML = '';
    const header = createElement('div', { class: 'view-header' }, [
      createElement('h1', { class: 'view-title' }, 'Upload to PC'),
      createElement(
        'p',
        { class: 'view-subtitle' },
        'Transfer photos, videos, and files directly to host PC'
      ),
    ]);

    const card = createElement('div', { class: 'empty-state' }, [
      createElement('h3', { class: 'empty-state__title' }, 'Upload Engine Ready'),
      createElement(
        'p',
        { class: 'empty-state__desc' },
        'Ready for Phase 3: Mobile file picker, drag-and-drop zone, and chunked transfer engine.'
      ),
    ]);

    this.mainContainer.appendChild(header);
    this.mainContainer.appendChild(card);
  }

  _renderTransfersPlaceholder() {
    this.mainContainer.innerHTML = '';
    const header = createElement('div', { class: 'view-header' }, [
      createElement('h1', { class: 'view-title' }, 'Transfer Activity'),
      createElement(
        'p',
        { class: 'view-subtitle' },
        'Real-time progress, speeds, and transfer history'
      ),
    ]);

    const card = createElement('div', { class: 'empty-state' }, [
      createElement('h3', { class: 'empty-state__title' }, 'No Active Transfers'),
      createElement(
        'p',
        { class: 'empty-state__desc' },
        'Active uploads and downloads will display real-time speed and progress here.'
      ),
    ]);

    this.mainContainer.appendChild(header);
    this.mainContainer.appendChild(card);
  }

  _renderDevicesPlaceholder() {
    this.mainContainer.innerHTML = '';
    const header = createElement('div', { class: 'view-header' }, [
      createElement('h1', { class: 'view-title' }, 'Connected Devices'),
      createElement('p', { class: 'view-subtitle' }, 'Active peer devices on the same local WLAN'),
    ]);

    const serverName = this.serverInfo?.serverName || 'Host PC';
    const serverIp = this.serverInfo?.ip || '127.0.0.1';

    const card = createElement('div', { class: 'empty-state' }, [
      createElement('h3', { class: 'empty-state__title' }, `Hub: ${serverName}`),
      createElement(
        'p',
        { class: 'empty-state__desc' },
        `Local server IP: ${serverIp}. Scan QR code on other devices to connect.`
      ),
    ]);

    this.mainContainer.appendChild(header);
    this.mainContainer.appendChild(card);
  }

  _setupConnectionEvents() {
    const dot = document.getElementById('connection-dot');
    const text = document.getElementById('connection-text');

    connection.onStatusChange((status) => {
      if (dot && text) {
        dot.className = 'connection-dot';
        if (status === 'CONNECTED') {
          dot.classList.add('connection-dot--connected');
          text.textContent = 'Online';
        } else if (status === 'RECONNECTING') {
          dot.classList.add('connection-dot--reconnecting');
          text.textContent = 'Reconnecting';
        } else {
          text.textContent = 'Offline';
        }
      }
    });

    // Listen to real-time share updates
    connection.on('share:update', (data) => {
      if (data && data.files) {
        this.fileBrowser.setFiles(data.files);
        showToast({ type: 'info', message: 'Shared file list updated' });
      }
    });

    // Device join notification
    connection.on('device:join', (data) => {
      if (data && data.deviceName) {
        showToast({ type: 'info', message: `${data.deviceName} connected` });
      }
    });
  }

  _setupQrModal() {
    const qrBtn = document.getElementById('btn-qr-modal');
    if (qrBtn) {
      qrBtn.addEventListener('click', () => {
        if (this.serverInfo && this.serverInfo.qrCode) {
          showQrModal(this.serverInfo.qrCode, this.serverInfo.connectUrl);
        } else {
          showToast({ type: 'warning', message: 'QR code not ready yet' });
        }
      });
    }
  }

  _setupErrorBoundary() {
    window.addEventListener('error', (event) => {
      showToast({ type: 'danger', message: `App error: ${event.message}` });
    });

    window.addEventListener('unhandledrejection', (event) => {
      showToast({
        type: 'danger',
        message: `Unhandled request error: ${event.reason?.message || event.reason}`,
      });
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
