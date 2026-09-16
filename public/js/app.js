/**
 * UniversalTrans Client Application Entry
 * SPA Router, state management, Drop Zone, Transfer Engine, and PC Approval Modal.
 */

import { connection } from './connection.js';
import { FileBrowser } from './file-browser.js';
import { DropZone } from './drop-zone.js';
import { transferEngine } from './transfer.js';
import { createElement, getFileSvg, showModal, closeModal, showQrModal, showToast } from './ui.js';
import { formatFileSize, formatRelativeTime } from './utils.js';
import { initializeHostSession, hostHeaders } from './host-session.js';
import {
  UNAUTHORIZED_EVENT,
  apiFetch,
  getHostToken,
  resetUnauthorizedNotification,
  setSessionToken,
} from './api.js';

class App {
  constructor() {
    this.serverInfo = null;
    this.currentView = 'files';
    this.fileBrowser = null;
    this.dropZone = null;
    this.mainContainer = null;
    this.selectedUploadFiles = [];
    this.connectedDevices = [];
    this.wakeLockSentinel = null;
    this.deferredPrompt = null;
    this.isHost = false;
    this.pendingApprovals = [];
    // Batches announced by senders (UT-012). Consent happens here, before any bytes.
    this.pendingOffers = [];
  }

  async init() {
    initializeHostSession();
    this.mainContainer = document.getElementById('main-view');
    this.fileBrowser = new FileBrowser(this.mainContainer);

    // Initialize DropZone on PC
    this.dropZone = new DropZone(document.body, () => {
      if (this.currentView === 'files') {
        this.fileBrowser.loadFiles();
      }
    });

    this._setupNavigation();
    this._setupTransferEvents();
    this._setupConnectionEvents();
    this._setupQrModal();
    this._setupPwaInstall();
    this._setupTabGuard();
    this._setupErrorBoundary();
    this._registerServiceWorker();

    // Fetch initial server info
    await this._fetchServerInfo();

    // If this browser instance holds host capability, exchange for a session cookie
    // so media URLs and data APIs work seamlessly without PIN.
    if (getHostToken()) {
      try {
        const res = await apiFetch('/api/auth/host-session', { method: 'POST' });
        const json = await res.json();
        if (json.success && json.data?.token) {
          setSessionToken(json.data.token);
        }
      } catch {
        // Fall back to host headers
      }
    }

    // Route to initial view from URL hash
    this._handleRoute();

    // Connect WebSocket
    connection.connect();

    // PIN gate: opened on demand when an unauthenticated request is rejected
    window.addEventListener(UNAUTHORIZED_EVENT, () => {
      if (!getHostToken()) {
        this._showPinGate();
      }
    });
  }

  async _fetchServerInfo() {
    try {
      const res = await apiFetch('/api/info');
      const json = await res.json();
      if (json.success && json.data) {
        this.serverInfo = json.data;
        if (json.data.maxConcurrentTransfers) {
          transferEngine.maxConcurrent = json.data.maxConcurrentTransfers;
        }
        const nameEl = document.getElementById('header-server-name');
        if (nameEl) {
          nameEl.textContent = `${json.data.serverName} (${json.data.ip})`;
        }
      }
    } catch {
      showToast('Could not fetch server info', 'warning');
    }
  }

  _setupNavigation() {
    window.addEventListener('hashchange', () => this._handleRoute());

    document.querySelectorAll('[data-view]').forEach((link) => {
      link.addEventListener('click', () => {
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
        this._renderUploadView();
        break;

      case 'transfers':
        this._renderTransfersView();
        break;

      case 'devices':
        this._renderDevicesView();
        break;

      default:
        this.fileBrowser.loadFiles();
        break;
    }
  }

  /* ==========================================================================
     Upload View
     ========================================================================== */
  _renderUploadView() {
    this.mainContainer.innerHTML = '';

    const header = createElement('div', { class: 'view-header' }, [
      createElement('h1', { class: 'view-title' }, 'Upload to PC'),
      createElement(
        'p',
        { class: 'view-subtitle' },
        'Transfer photos, videos, and files directly to host PC'
      ),
    ]);

    const container = createElement('div', { class: 'upload-container' });

    // Hidden inputs
    const fileInput = createElement('input', {
      type: 'file',
      multiple: true,
      style: 'display:none',
      onchange: (e) => this._onFilesSelected(e.target.files),
    });

    const cameraInput = createElement('input', {
      type: 'file',
      accept: 'image/*',
      capture: 'environment',
      style: 'display:none',
      onchange: (e) => this._onFilesSelected(e.target.files),
    });

    // Dropzone card
    const dropzone = createElement(
      'div',
      {
        class: 'upload-dropzone',
        onclick: () => fileInput.click(),
      },
      [
        createElement('div', { class: 'upload-dropzone__icon' }, [getFileSvg('image')]),
        createElement('h3', { class: 'upload-dropzone__title' }, 'Select or Drop Files'),
        createElement(
          'p',
          { class: 'upload-dropzone__subtitle' },
          'Tap to browse files, photos, or drag & drop directly'
        ),
        createElement('div', { class: 'upload-btn-row' }, [
          createElement(
            'button',
            {
              type: 'button',
              class: 'btn btn--primary',
              onclick: (e) => {
                e.stopPropagation();
                fileInput.click();
              },
            },
            'Browse Files'
          ),
          createElement(
            'button',
            {
              type: 'button',
              class: 'btn btn--ghost',
              onclick: (e) => {
                e.stopPropagation();
                cameraInput.click();
              },
            },
            'Camera'
          ),
        ]),
      ]
    );

    container.appendChild(fileInput);
    container.appendChild(cameraInput);
    container.appendChild(dropzone);

    // Selected files preview list
    if (this.selectedUploadFiles.length > 0) {
      const listContainer = createElement('div', { class: 'upload-file-list' }, [
        createElement(
          'h4',
          {
            style:
              'margin-bottom: var(--space-2); font-size: var(--font-size-sm); font-weight: 600;',
          },
          `Ready to Upload (${this.selectedUploadFiles.length})`
        ),
      ]);

      let totalBytes = 0;
      this.selectedUploadFiles.forEach((file, index) => {
        totalBytes += file.size;
        const item = createElement('div', { class: 'upload-file-item' }, [
          createElement('div', { class: 'upload-file-item__info' }, [
            createElement('span', { class: 'upload-file-item__name' }, file.name),
            createElement('span', { class: 'upload-file-item__size' }, formatFileSize(file.size)),
          ]),
          createElement(
            'button',
            {
              class: 'btn btn--ghost btn--icon btn--sm',
              title: 'Remove',
              onclick: () => {
                this.selectedUploadFiles.splice(index, 1);
                this._renderUploadView();
              },
            },
            '✕'
          ),
        ]);
        listContainer.appendChild(item);
      });

      const summaryBar = createElement('div', { class: 'upload-summary-bar' }, [
        createElement(
          'div',
          { style: 'font-size: var(--font-size-sm); color: var(--color-text-secondary);' },
          `Total: ${formatFileSize(totalBytes)}`
        ),
        createElement('div', { style: 'display: flex; gap: var(--space-2);' }, [
          createElement(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              onclick: () => {
                this.selectedUploadFiles = [];
                this._renderUploadView();
              },
            },
            'Clear All'
          ),
          createElement(
            'button',
            {
              class: 'btn btn--primary',
              onclick: () => this._startUploadBatch(),
            },
            `Start Upload (${this.selectedUploadFiles.length})`
          ),
        ]),
      ]);

      container.appendChild(listContainer);
      container.appendChild(summaryBar);
    }

    this.mainContainer.appendChild(header);
    this.mainContainer.appendChild(container);
  }

  _onFilesSelected(fileList) {
    if (!fileList || fileList.length === 0) return;
    for (const file of fileList) {
      this.selectedUploadFiles.push(file);
    }
    this._renderUploadView();
  }

  _startUploadBatch() {
    if (this.selectedUploadFiles.length === 0) return;
    transferEngine.addFiles(this.selectedUploadFiles);
    this.selectedUploadFiles = [];
    window.location.hash = '#transfers';
    showToast('Upload queued! View progress in Transfers tab', 'info');
  }

  /* ==========================================================================
     Transfers View
     ========================================================================== */
  _renderTransfersView() {
    this.mainContainer.innerHTML = '';

    const header = createElement('div', { class: 'view-header' }, [
      createElement('h1', { class: 'view-title' }, 'Transfer Activity'),
      createElement(
        'p',
        { class: 'view-subtitle' },
        'Real-time progress, speed, and transfer history'
      ),
    ]);

    const container = createElement('div', { class: 'transfers-container' });
    const { active, queued, completed, failed } = transferEngine.getStatus();

    const hasAny =
      active.length > 0 || queued.length > 0 || completed.length > 0 || failed.length > 0;

    if (!hasAny) {
      const emptyCard = createElement('div', { class: 'empty-state' }, [
        createElement('h3', { class: 'empty-state__title' }, 'No Active Transfers'),
        createElement(
          'p',
          { class: 'empty-state__desc' },
          'Active uploads and downloads will display real-time speed and progress here.'
        ),
        createElement(
          'a',
          { href: '#upload', class: 'btn btn--primary', style: 'margin-top: var(--space-4);' },
          'Upload Files'
        ),
      ]);
      this.mainContainer.appendChild(header);
      this.mainContainer.appendChild(emptyCard);
      return;
    }

    // Active & Queued Group
    const allActive = [...active, ...queued];
    if (allActive.length > 0) {
      const activeGroup = createElement('div', { class: 'transfers-group' }, [
        createElement(
          'div',
          { class: 'transfers-group__title' },
          `In Progress (${allActive.length})`
        ),
      ]);

      allActive.forEach((task) => {
        const card = this._createTransferCard(task);
        activeGroup.appendChild(card);
      });

      container.appendChild(activeGroup);
    }

    // Completed Group
    if (completed.length > 0) {
      const compGroup = createElement('div', { class: 'transfers-group' }, [
        createElement('div', { class: 'transfers-group__title' }, [
          createElement('span', {}, `Completed (${completed.length})`),
          createElement(
            'button',
            {
              class: 'btn btn--ghost btn--sm',
              style: 'margin-left: auto; font-size: var(--font-size-xs);',
              onclick: () => {
                transferEngine.clearCompleted();
                this._renderTransfersView();
              },
            },
            'Clear'
          ),
        ]),
      ]);

      completed.forEach((task) => {
        const card = createElement('div', { class: 'transfer-card' }, [
          createElement('div', { class: 'transfer-card__header' }, [
            createElement('div', { class: 'transfer-card__file-info' }, [
              createElement('span', { class: 'badge badge--success' }, '✓ Done'),
              createElement('span', { class: 'transfer-card__name' }, task.name),
              createElement('span', { class: 'transfer-card__size' }, formatFileSize(task.size)),
            ]),
            createElement(
              'span',
              { style: 'font-size: var(--font-size-xs); color: var(--color-text-muted);' },
              formatRelativeTime(task.completedAt || Date.now())
            ),
          ]),
        ]);
        compGroup.appendChild(card);
      });

      container.appendChild(compGroup);
    }

    // Failed Group
    if (failed.length > 0) {
      const failGroup = createElement('div', { class: 'transfers-group' }, [
        createElement('div', { class: 'transfers-group__title' }, `Failed (${failed.length})`),
      ]);

      failed.forEach((task) => {
        const card = createElement('div', { class: 'transfer-card' }, [
          createElement('div', { class: 'transfer-card__header' }, [
            createElement('div', { class: 'transfer-card__file-info' }, [
              createElement('span', { class: 'badge badge--danger' }, 'Error'),
              createElement('span', { class: 'transfer-card__name' }, task.name),
              createElement('span', { class: 'transfer-card__size' }, formatFileSize(task.size)),
            ]),
            createElement(
              'button',
              {
                class: 'btn btn--ghost btn--sm',
                onclick: () => transferEngine.retry(task.id),
              },
              'Retry'
            ),
          ]),
          createElement(
            'div',
            { style: 'font-size: var(--font-size-xs); color: var(--color-danger);' },
            task.error || 'Upload failed'
          ),
        ]);
        failGroup.appendChild(card);
      });

      container.appendChild(failGroup);
    }

    this.mainContainer.appendChild(header);
    this.mainContainer.appendChild(container);
  }

  _createTransferCard(task) {
    const isAwaiting = task.status === 'awaiting_approval';
    const isPaused = task.status === 'paused';

    const fillClass = isAwaiting
      ? 'progress-bar__fill progress-bar__fill--success'
      : 'progress-bar__fill';

    const fill = createElement('div', {
      class: fillClass,
      style: `width: ${task.progress}%;`,
    });

    const progressBar = createElement('div', { class: 'progress-bar' }, [fill]);

    const metaRow = createElement('div', { class: 'transfer-card__meta' }, [
      createElement('div', { class: 'transfer-card__stats' }, [
        createElement('span', { style: 'font-weight: 600;' }, `${task.progress}%`),
        createElement('span', {}, task.speedFormatted),
        createElement(
          'span',
          {},
          isAwaiting ? 'Awaiting PC Acceptance' : `ETA: ${task.etaFormatted}`
        ),
      ]),
      createElement('div', { class: 'transfer-card__actions' }, [
        !isAwaiting &&
          createElement(
            'button',
            {
              class: 'btn btn--ghost btn--icon btn--sm',
              title: isPaused ? 'Resume' : 'Pause',
              onclick: () => {
                if (isPaused) {
                  transferEngine.resume(task.id);
                } else {
                  transferEngine.pause(task.id);
                }
              },
            },
            isPaused ? '▶' : '⏸'
          ),
        createElement(
          'button',
          {
            class: 'btn btn--ghost btn--icon btn--sm',
            title: 'Cancel',
            onclick: () => transferEngine.cancel(task.id),
          },
          '✕'
        ),
      ]),
    ]);

    return createElement('div', { class: 'transfer-card', id: `transfer-${task.id}` }, [
      createElement('div', { class: 'transfer-card__header' }, [
        createElement('div', { class: 'transfer-card__file-info' }, [
          createElement('span', { class: 'transfer-card__name' }, task.name),
          createElement('span', { class: 'transfer-card__size' }, formatFileSize(task.size)),
        ]),
        createElement(
          'span',
          { class: 'badge badge--info' },
          task.isChunked ? 'Chunked' : 'Direct'
        ),
      ]),
      progressBar,
      metaRow,
    ]);
  }

  /* ==========================================================================
     Devices View
     ========================================================================== */
  _renderDevicesView() {
    this.mainContainer.innerHTML = '';

    const header = createElement('div', { class: 'view-header' }, [
      createElement('h1', { class: 'view-title' }, 'Connected Devices'),
      createElement('p', { class: 'view-subtitle' }, 'Active peer devices on the same local WLAN'),
    ]);

    const grid = createElement('div', { class: 'devices-grid' });
    const localDeviceId = this.localDeviceId;

    if (this.connectedDevices.length === 0) {
      const serverName = this.serverInfo?.serverName || 'Host PC';
      const serverIp = this.serverInfo?.ip || '127.0.0.1';

      const card = createElement('div', { class: 'empty-state' }, [
        createElement('h3', { class: 'empty-state__title' }, `Host: ${serverName}`),
        createElement(
          'p',
          { class: 'empty-state__desc' },
          `Local server IP: ${serverIp}. Scan QR code on other devices to join.`
        ),
      ]);
      this.mainContainer.appendChild(header);
      this.mainContainer.appendChild(card);
      return;
    }

    this.connectedDevices.forEach((dev) => {
      const isCurrent = Boolean(localDeviceId) && dev.id === localDeviceId;

      const card = createElement('div', { class: 'device-card' }, [
        createElement('div', { class: 'device-avatar' }, [this._getPlatformIcon(dev.platform)]),
        createElement('div', { class: 'device-info' }, [
          createElement('div', { class: 'device-name' }, [
            document.createTextNode(dev.label || 'Peer Device'),
            isCurrent && createElement('span', { class: 'device-badge-current' }, 'This Device'),
          ]),
          createElement(
            'div',
            { class: 'device-meta' },
            `${dev.ip || 'LAN'} • Joined ${formatRelativeTime(dev.joinedAt || Date.now())}`
          ),
        ]),
        createElement('div', { class: 'device-status-dot', title: 'Online' }),
      ]);

      grid.appendChild(card);
    });

    this.mainContainer.appendChild(header);
    this.mainContainer.appendChild(grid);
  }

  _getPlatformIcon(platform = '') {
    const p = String(platform).toLowerCase();
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '2');
    svg.style.width = '24px';
    svg.style.height = '24px';

    if (p.includes('android')) {
      svg.innerHTML =
        '<path d="M4 10a8 8 0 0 1 16 0"/><line x1="8" y1="4" x2="6" y2="2"/><line x1="16" y1="4" x2="18" y2="2"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="8" r="1"/><rect x="4" y="11" width="16" height="10" rx="2"/>';
    } else if (
      p.includes('ios') ||
      p.includes('iphone') ||
      p.includes('ipad') ||
      p.includes('mac')
    ) {
      svg.innerHTML =
        '<path d="M12 20.94c1.5 0 2.75 1.06 4 1.06 3 0 6-8 6-12.22A4.91 4.91 0 0 0 17 5c-2.22 0-4 1.44-5 2-1-.56-2.78-2-5-2a4.9 4.9 0 0 0-5 4.78C2 14 5 22 8 22c1.25 0 2.5-1.06 4-1.06Z"/><path d="M10 2c1 .5 2 2 2 5"/>';
    } else if (p.includes('windows')) {
      svg.innerHTML =
        '<rect x="3" y="3" width="8" height="8"/><rect x="13" y="3" width="8" height="8"/><rect x="3" y="13" width="8" height="8"/><rect x="13" y="13" width="8" height="8"/>';
    } else {
      svg.innerHTML =
        '<rect x="4" y="2" width="16" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/>';
    }
    return svg;
  }

  /* ==========================================================================
     PC Approval Modal Flow
     ========================================================================== */
  _showApprovalModal(pending) {
    if (!pending || !this.isHost) return;

    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    // Sender label is client-reported; treat it as a label, not identity.
    const sender = pending.sender || {};
    const senderTitle = sender.label || 'A device';

    const content = createElement('div', { class: 'approval-modal-body' }, [
      createElement('div', { class: 'approval-icon' }, [
        getFileSvg(pending.mimeType?.startsWith('image/') ? 'image' : 'video'),
      ]),
      createElement(
        'h4',
        { style: 'margin-bottom: var(--space-1);' },
        `${senderTitle} wants to send a file:`
      ),
      createElement('div', { class: 'approval-file-info' }, [
        createElement('div', { class: 'approval-file-name' }, pending.fileName),
        createElement(
          'div',
          { class: 'approval-file-meta' },
          `${formatFileSize(pending.fileSize)} • ${pending.mimeType || 'file'}`
        ),
      ]),
      createElement(
        'p',
        { style: 'font-size: var(--font-size-xs); color: var(--color-text-secondary);' },
        'Accepting will save this file directly into your UniversalTrans Downloads folder.'
      ),
      createElement('div', { class: 'approval-actions' }, [
        createElement(
          'button',
          {
            class: 'btn btn--danger',
            onclick: async () => {
              closeModal();
              await this._submitApprovalDecision(pending.transferId, 'decline');
            },
          },
          'Decline'
        ),
        createElement(
          'button',
          {
            class: 'btn btn--primary',
            onclick: async () => {
              closeModal();
              await this._submitApprovalDecision(pending.transferId, 'accept');
            },
          },
          'Accept File'
        ),
      ]),
    ]);

    showModal({
      title: 'Incoming File Transfer',
      contentNode: content,
      actions: [],
    });
  }

  async _submitApprovalDecision(transferId, action) {
    try {
      const res = await apiFetch('/api/upload/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hostHeaders() },
        body: JSON.stringify({ transferId, action }),
      });

      if (!res.ok) {
        throw new Error(`Decision error: ${res.status}`);
      }

      if (action === 'accept') {
        showToast({ message: 'File accepted and saved to Downloads!', type: 'success' });
      } else {
        showToast({ message: 'File transfer declined', type: 'warning' });
      }
    } catch (err) {
      showToast({ message: `Error processing transfer: ${err.message}`, type: 'danger' });
    } finally {
      await this._loadPendingApprovals();
    }
  }

  /**
   * Consent dialog for one batch. The host sees name/size/type for each file and
   * decides per file, because agreeing to a batch is not agreeing to every item in it.
   */
  _showOfferModal(offer) {
    if (!offer || !this.isHost) return;

    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    const senderTitle = offer.sender?.label || 'A device';
    const selected = new Set(offer.files.map((file) => file.index));
    const trustCheckbox = createElement('input', { type: 'checkbox', id: 'offer-trust-device' });

    const fileRows = offer.files.map((file) =>
      createElement('label', { class: 'offer-file-row' }, [
        createElement('input', {
          type: 'checkbox',
          checked: true,
          onchange: (event) => {
            if (event.target.checked) selected.add(file.index);
            else selected.delete(file.index);
          },
        }),
        createElement('div', { class: 'offer-file-text' }, [
          createElement('div', { class: 'approval-file-name' }, file.name),
          createElement(
            'div',
            { class: 'approval-file-meta' },
            `${formatFileSize(file.size)} • ${file.mimeType || 'file'}`
          ),
        ]),
      ])
    );

    const content = createElement('div', { class: 'approval-modal-body' }, [
      createElement(
        'h4',
        { style: 'margin-bottom: var(--space-1);' },
        `${senderTitle} wants to send ${offer.files.length} file${offer.files.length === 1 ? '' : 's'}:`
      ),
      createElement('div', { class: 'offer-file-list' }, fileRows),
      createElement(
        'p',
        { style: 'font-size: var(--font-size-xs); color: var(--color-text-secondary);' },
        'Approved files transfer straight to your Downloads folder. Nothing is sent until you decide.'
      ),
      createElement('label', { class: 'offer-trust-row' }, [
        trustCheckbox,
        createElement(
          'span',
          {},
          'Remember this device and skip this prompt next time (revocable in Settings)'
        ),
      ]),
      createElement('div', { class: 'approval-actions' }, [
        createElement(
          'button',
          {
            class: 'btn btn--danger',
            onclick: async () => {
              closeModal();
              await this._submitOfferDecision(
                offer.offerId,
                offer.files.map((file) => ({ index: file.index, action: 'reject' })),
                trustCheckbox.checked
              );
            },
          },
          'Decline All'
        ),
        createElement(
          'button',
          {
            class: 'btn btn--primary',
            onclick: async () => {
              closeModal();
              await this._submitOfferDecision(
                offer.offerId,
                offer.files.map((file) => ({
                  index: file.index,
                  action: selected.has(file.index) ? 'approve' : 'reject',
                })),
                trustCheckbox.checked
              );
            },
          },
          'Approve Selected'
        ),
      ]),
    ]);

    showModal({
      title: 'Incoming File Transfer',
      contentNode: content,
      actions: [],
    });
  }

  async _submitOfferDecision(offerId, decisions, trustDevice = false) {
    try {
      const res = await apiFetch('/api/transfer/offer/decision', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...hostHeaders() },
        body: JSON.stringify({ offerId, decisions, trustDevice }),
      });
      if (!res.ok) throw new Error(`Decision error: ${res.status}`);

      const approved = decisions.filter((d) => d.action === 'approve').length;
      if (approved === 0) {
        showToast({ message: 'Transfer declined', type: 'warning' });
      } else {
        showToast({
          message: `Approved ${approved} of ${decisions.length} file(s)`,
          type: 'success',
        });
      }
    } catch (err) {
      showToast({ message: `Error processing transfer: ${err.message}`, type: 'danger' });
    } finally {
      await this._loadPendingOffers();
    }
  }

  async _loadPendingOffers() {
    if (!this.isHost) return;
    try {
      const res = await apiFetch('/api/transfer/offers', { headers: hostHeaders() });
      if (!res.ok) return;
      const body = await res.json();
      this.pendingOffers = body.data || [];
      if (this.pendingOffers.length) this._showOfferModal(this.pendingOffers[0]);
    } catch {
      // Reconnect registration will retry the authoritative offer list.
    }
  }

  async _loadPendingApprovals() {
    if (!this.isHost) return;
    try {
      const res = await apiFetch('/api/upload/pending', { headers: hostHeaders() });
      if (!res.ok) return;
      const body = await res.json();
      this.pendingApprovals = body.data || [];
      if (this.pendingApprovals.length) this._showApprovalModal(this.pendingApprovals[0]);
    } catch {
      // Reconnect registration will retry the authoritative pending list.
    }
  }

  /**
   * PIN gate: the host requires a PIN before clients may read or send files.
   * Uses a raw fetch so a rejected PIN cannot re-trigger the unauthorized signal.
   */
  _showPinGate() {
    if (this.pinModalOpen) return;
    this.pinModalOpen = true;

    const input = createElement('input', {
      type: 'password',
      inputmode: 'numeric',
      autocomplete: 'off',
      class: 'input pin-input',
      placeholder: 'PIN from the host screen',
      maxlength: '6',
    });

    const errorText = createElement('div', { class: 'pin-error' }, '');

    const submitBtn = createElement(
      'button',
      { class: 'btn btn--primary', type: 'button' },
      'Connect'
    );

    const submit = async () => {
      const pin = input.value.trim();
      if (!pin) {
        errorText.textContent = 'Enter the PIN shown on the host computer.';
        return;
      }

      submitBtn.disabled = true;
      try {
        const res = await fetch('/api/auth', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ pin }),
        });
        const body = await res.json().catch(() => ({}));

        if (res.ok && body?.data?.token && body.data.token !== 'bypass') {
          setSessionToken(body.data.token);
          resetUnauthorizedNotification();
          this.pinModalOpen = false;
          closeModal();
          showToast({ type: 'success', message: 'Connected to the host session' });
          connection.reconnect();
          this.fileBrowser?.loadFiles();
          return;
        }

        errorText.textContent =
          res.status === 429
            ? 'Too many attempts. Try again in 5 minutes.'
            : 'Wrong PIN. Check the host screen.';
      } catch {
        errorText.textContent = 'Could not reach the host.';
      } finally {
        submitBtn.disabled = false;
      }
    };

    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') submit();
    });
    submitBtn.addEventListener('click', submit);

    const content = createElement('div', { class: 'pin-gate' }, [
      createElement(
        'p',
        {},
        'This host requires a PIN before files can be listed, sent or downloaded.'
      ),
      input,
      errorText,
    ]);

    showModal({ title: 'Host PIN required', contentNode: content, actions: [submitBtn] });
    input.focus();
  }

  /* ==========================================================================
     Transfer & Connection Events Setup
     ========================================================================== */
  _setupTransferEvents() {
    transferEngine.on('task:started', () => {
      this._updateWakeLock();
      if (this.currentView === 'transfers') {
        this._renderTransfersView();
      }
    });

    transferEngine.on('task:progress', () => {
      if (this.currentView === 'transfers') {
        this._renderTransfersView();
      }
    });

    transferEngine.on('queue:updated', () => {
      this._updateWakeLock();
      if (this.currentView === 'transfers') {
        this._renderTransfersView();
      }
    });

    transferEngine.on('task:completed', (task) => {
      this._updateWakeLock();
      showToast(`Transferred ${task.name} successfully!`, 'success');
      if (this.currentView === 'transfers') {
        this._renderTransfersView();
      }
    });

    transferEngine.on('task:error', (task) => {
      this._updateWakeLock();
      showToast(`Upload failed: ${task.name} (${task.error})`, 'danger');
      if (this.currentView === 'transfers') {
        this._renderTransfersView();
      }
    });

    transferEngine.on('task:awaiting_approval', (task) => {
      showToast(`Uploaded ${task.name}. Awaiting PC acceptance...`, 'info');
      if (this.currentView === 'transfers') {
        this._renderTransfersView();
      }
    });
  }

  _setupConnectionEvents() {
    const dot = document.getElementById('connection-dot');
    const text = document.getElementById('connection-text');
    const latencyEl = document.getElementById('connection-latency');

    connection.onStatusChange((status) => {
      if (dot && text) {
        dot.className = 'connection-dot';
        if (status === 'CONNECTED') {
          dot.classList.add('connection-dot--connected');
          text.textContent = 'Online';
          transferEngine.reconcileAwaitingTransfers();
        } else if (status === 'RECONNECTING') {
          dot.classList.add('connection-dot--reconnecting');
          text.textContent = 'Reconnecting';
          if (latencyEl) latencyEl.style.display = 'none';
        } else {
          text.textContent = 'Offline';
          if (latencyEl) latencyEl.style.display = 'none';
        }
      }
    });

    connection.on('latency:update', (data) => {
      if (latencyEl && data && typeof data.latencyMs === 'number') {
        latencyEl.textContent = `${data.latencyMs}ms`;
        latencyEl.style.display = 'inline-block';
      }
    });

    // Real-time share list update
    connection.on('share:update', (data) => {
      if (data && data.files) {
        this.fileBrowser.setFiles(data.files);
        showToast('Shared file list updated', 'info');
      }
    });

    // Device joined or registered
    connection.on('client:registered', (data) => {
      if (data && data.devices) {
        this.connectedDevices = data.devices;
        if (this.currentView === 'devices') {
          this._renderDevicesView();
        }
      }
    });

    connection.on('device:join', (data) => {
      if (data && data.device) {
        this.connectedDevices = this.connectedDevices
          .filter((d) => d.id !== data.device.id)
          .concat(data.device);
        showToast(`${data.device.label} joined the network`, 'info');
        if (this.currentView === 'devices') {
          this._renderDevicesView();
        }
      }
    });

    connection.on('device:leave', (data) => {
      if (data && data.deviceId) {
        this.connectedDevices = this.connectedDevices.filter((d) => d.id !== data.deviceId);
        showToast(`${data.label || 'A device'} left`, 'warning');
        if (this.currentView === 'devices') {
          this._renderDevicesView();
        }
      }
    });

    // PC Approval Modal trigger
    connection.on('upload:request', (data) => {
      if (this.isHost && data?.pending) {
        if (!this.pendingApprovals.some((p) => p.transferId === data.pending.transferId)) {
          this.pendingApprovals.push(data.pending);
        }
        this._showApprovalModal(this.pendingApprovals[0]);
      }
    });

    // A sender announced a batch; nothing has been written yet (UT-012).
    connection.on('transfer:offer', (data) => {
      if (this.isHost && data?.offer) {
        if (!this.pendingOffers.some((o) => o.offerId === data.offer.offerId)) {
          this.pendingOffers.push(data.offer);
        }
        this._showOfferModal(this.pendingOffers[0]);
      }
    });

    connection.on('transfer:offer:decision', (data) => {
      transferEngine.handleWebSocketEvent('transfer:offer:decision', data);
      if (this.isHost) this._loadPendingOffers();
    });

    connection.on('transfer:offer:expired', (data) => {
      transferEngine.handleWebSocketEvent('transfer:offer:expired', data);
      if (this.isHost) this._loadPendingOffers();
    });

    connection.on('client:registered', (data) => {
      this.isHost = data?.device?.isHost === true;
      // Server-issued identity for this connection; used only to flag "This Device".
      this.localDeviceId = data?.device?.id || this.localDeviceId;
      if (data?.connectionId) {
        window.utransConnectionId = data.connectionId;
        transferEngine.connectionId = data.connectionId;
      }
      this._loadPendingApprovals();
      this._loadPendingOffers();
    });

    // Server refused the socket because this client holds no valid capability.
    connection.on('client:rejected', () => {
      if (!getHostToken()) {
        this._showPinGate();
      }
    });

    // Transfer status updates from WS
    connection.on('transfer:complete', (data) => {
      transferEngine.handleWebSocketEvent('transfer:complete', data);
      if (this.isHost) {
        closeModal();
        this._loadPendingApprovals();
      }
    });

    connection.on('transfer:rejected', (data) => {
      transferEngine.handleWebSocketEvent('transfer:rejected', data);
      if (this.isHost) {
        closeModal();
        this._loadPendingApprovals();
      }
    });

    connection.on('transfer:expired', (data) => {
      transferEngine.handleWebSocketEvent('transfer:expired', data);
      if (this.isHost) {
        closeModal();
        this._loadPendingApprovals();
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
          showToast('QR code not ready yet', 'warning');
        }
      });
    }
  }

  _setupPwaInstall() {
    const pwaBtn = document.getElementById('btn-pwa-install');
    if (!pwaBtn) return;

    window.addEventListener('beforeinstallprompt', (e) => {
      e.preventDefault();
      this.deferredPrompt = e;
      pwaBtn.style.display = 'inline-flex';
    });

    // If on iOS Safari outside standalone mode, show install button to open guide
    if (this._isIos() && !this._isStandalone()) {
      pwaBtn.style.display = 'inline-flex';
    }

    pwaBtn.addEventListener('click', async () => {
      if (this.deferredPrompt) {
        this.deferredPrompt.prompt();
        await this.deferredPrompt.userChoice;
        this.deferredPrompt = null;
        pwaBtn.style.display = 'none';
      } else if (this._isIos()) {
        this._showIosInstallGuide();
      }
    });

    window.addEventListener('appinstalled', () => {
      this.deferredPrompt = null;
      pwaBtn.style.display = 'none';
      showToast('UniversalTrans installed successfully!', 'success');
    });
  }

  _isIos() {
    const ua = window.navigator.userAgent.toLowerCase();
    return (
      /iphone|ipad|ipod/.test(ua) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
    );
  }

  _isStandalone() {
    return (
      ('standalone' in window.navigator && window.navigator.standalone) ||
      window.matchMedia('(display-mode: standalone)').matches
    );
  }

  _showIosInstallGuide() {
    const content = createElement('div', { class: 'ios-guide' }, [
      createElement('div', { class: 'ios-guide__step' }, [
        createElement('span', { class: 'ios-guide__badge' }, '1'),
        createElement('span', {}, [
          'Tap the ',
          createElement('strong', {}, 'Share'),
          ' button (arrow pointing up) in Safari’s toolbar.',
        ]),
      ]),
      createElement('div', { class: 'ios-guide__step' }, [
        createElement('span', { class: 'ios-guide__badge' }, '2'),
        createElement('span', {}, [
          'Scroll down and tap ',
          createElement('strong', {}, 'Add to Home Screen'),
          '.',
        ]),
      ]),
      createElement('div', { class: 'ios-guide__step' }, [
        createElement('span', { class: 'ios-guide__badge' }, '3'),
        createElement('span', {}, [
          'Tap ',
          createElement('strong', {}, 'Add'),
          ' in the top-right corner.',
        ]),
      ]),
    ]);

    showModal({
      title: 'Install UniversalTrans on iOS',
      contentNode: content,
      actions: [
        {
          label: 'Got it',
          primary: true,
          onClick: () => closeModal(),
        },
      ],
    });
  }

  _setupTabGuard() {
    window.addEventListener('beforeunload', (e) => {
      const status = transferEngine.getStatus();
      if (status.active && status.active.length > 0) {
        e.preventDefault();
        e.returnValue = 'Transfer in progress. Are you sure you want to leave?';
        return e.returnValue;
      }
    });
  }

  async _acquireWakeLock() {
    if ('wakeLock' in navigator && !this.wakeLockSentinel) {
      try {
        this.wakeLockSentinel = await navigator.wakeLock.request('screen');
        this.wakeLockSentinel.addEventListener('release', () => {
          this.wakeLockSentinel = null;
        });
      } catch {
        // Silently handle if rejected or unsupported
      }
    }
  }

  async _releaseWakeLock() {
    if (this.wakeLockSentinel) {
      try {
        await this.wakeLockSentinel.release();
      } catch {
        // Silently handle
      }
      this.wakeLockSentinel = null;
    }
  }

  _updateWakeLock() {
    const status = transferEngine.getStatus();
    if (status.active && status.active.length > 0) {
      this._acquireWakeLock();
    } else {
      this._releaseWakeLock();
    }
  }

  _registerServiceWorker() {
    if ('serviceWorker' in navigator) {
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          this._updateWakeLock();
        }
      });

      window.addEventListener('load', async () => {
        try {
          const registration = await navigator.serviceWorker.register('/sw.js', { scope: '/' });
          registration.addEventListener('updatefound', () => {
            const newWorker = registration.installing;
            if (newWorker) {
              newWorker.addEventListener('statechange', () => {
                if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  showToast('New version available. Refresh to update.', 'info');
                }
              });
            }
          });
        } catch (err) {
          console.warn('ServiceWorker registration skipped:', err.message);
        }
      });
    }
  }

  _setupErrorBoundary() {
    window.addEventListener('error', (event) => {
      showToast(`App error: ${event.message}`, 'danger');
    });

    window.addEventListener('unhandledrejection', (event) => {
      showToast(`Request error: ${event.reason?.message || event.reason}`, 'danger');
    });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const app = new App();
  app.init();
});
