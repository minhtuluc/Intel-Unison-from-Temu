/**
 * UniversalTrans UI Component Helpers & Modals
 * Safe DOM rendering without unsafe innerHTML interpolation.
 */

import { copyToClipboard } from './utils.js';

/**
 * Creates a DOM element safely with attributes and children.
 * @param {string} tag
 * @param {object} [attributes={}]
 * @param {(string|Node)[]} [children=[]]
 * @returns {HTMLElement}
 */
export function createElement(tag, attributes = {}, children = []) {
  const el = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes)) {
    if (value === undefined || value === null) continue;

    if (key.startsWith('on') && typeof value === 'function') {
      const eventName = key.slice(2).toLowerCase();
      el.addEventListener(eventName, value);
    } else if (key === 'className' || key === 'class') {
      el.className = value;
    } else if (key === 'dataset' && typeof value === 'object') {
      for (const [dataKey, dataVal] of Object.entries(value)) {
        el.dataset[dataKey] = dataVal;
      }
    } else if (typeof value === 'boolean') {
      if (value) el.setAttribute(key, '');
    } else {
      el.setAttribute(key, String(value));
    }
  }

  const childArray = Array.isArray(children) ? children : [children];
  for (const child of childArray) {
    if (child === null || child === undefined) continue;

    if (typeof child === 'string' || typeof child === 'number') {
      el.appendChild(document.createTextNode(String(child)));
    } else if (child instanceof Node) {
      el.appendChild(child);
    }
  }

  return el;
}

/**
 * Creates SVG vector icon element for file categories.
 * @param {'image'|'video'|'audio'|'apk'|'document'|'archive'|'other'} type
 * @returns {SVGSVGElement}
 */
export function getFileSvg(type) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '2');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.style.width = '100%';
  svg.style.height = '100%';

  switch (type) {
    case 'image':
      svg.innerHTML =
        '<rect x="3" y="3" width="18" height="18" rx="2" ry="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/>';
      break;
    case 'video':
      svg.innerHTML =
        '<polygon points="23 7 16 12 23 17 23 7"/><rect x="1" y="5" width="15" height="14" rx="2" ry="2"/>';
      break;
    case 'audio':
      svg.innerHTML =
        '<path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/>';
      break;
    case 'apk':
      svg.innerHTML =
        '<path d="M4 10a8 8 0 0 1 16 0"/><line x1="8" y1="4" x2="6" y2="2"/><line x1="16" y1="4" x2="18" y2="2"/><circle cx="9" cy="8" r="1"/><circle cx="15" cy="8" r="1"/><rect x="4" y="11" width="16" height="10" rx="2"/>';
      break;
    case 'document':
      svg.innerHTML =
        '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/>';
      break;
    case 'archive':
      svg.innerHTML =
        '<polyline points="21 8 21 21 3 21 3 8"/><rect x="1" y="3" width="22" height="5"/><line x1="10" y1="12" x2="14" y2="12"/>';
      break;
    default:
      svg.innerHTML =
        '<path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/>';
      break;
  }

  return svg;
}

/**
 * Displays a toast notification on screen.
 * @param {{ type?: 'info'|'success'|'warning'|'danger', title?: string, message: string, duration?: number }} options
 */
export function showToast({ type = 'info', title = '', message, duration = 3500 }) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  const defaultTitle =
    {
      success: 'Success',
      warning: 'Notice',
      danger: 'Error',
      info: 'Information',
    }[type] || 'Notice';

  const toast = createElement('div', { class: `toast toast--${type}` }, [
    createElement('div', { class: 'toast__content' }, [
      createElement('div', { class: 'toast__title' }, title || defaultTitle),
      createElement('div', { class: 'toast__message' }, message),
    ]),
    createElement(
      'button',
      {
        class: 'toast__close',
        onclick: () => toast.remove(),
      },
      '✕'
    ),
  ]);

  container.appendChild(toast);

  if (duration > 0) {
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      toast.style.transition = 'all 200ms ease';
      setTimeout(() => toast.remove(), 200);
    }, duration);
  }
}

/**
 * Displays a modal dialog with glassmorphic backdrop.
 * @param {{ title: string, contentNode: HTMLElement, actions?: HTMLElement[] }} options
 */
export function showModal({ title, contentNode, actions = [] }) {
  closeModal();

  const container = document.getElementById('modal-container');
  if (!container) return;

  const closeBtn = createElement(
    'button',
    {
      class: 'btn btn--ghost btn--icon',
      onclick: closeModal,
      title: 'Close',
    },
    '✕'
  );

  const header = createElement('div', { class: 'modal__header' }, [
    createElement('h3', { class: 'modal__title' }, title),
    closeBtn,
  ]);

  const body = createElement('div', { class: 'modal__body' }, [contentNode]);

  const children = [header, body];

  if (actions.length > 0) {
    const footer = createElement('div', { class: 'modal__footer' }, actions);
    children.push(footer);
  }

  const modal = createElement('div', { class: 'modal' }, children);
  const overlay = createElement(
    'div',
    {
      class: 'modal-overlay',
      onclick: (e) => {
        if (e.target === overlay) closeModal();
      },
    },
    [modal]
  );

  container.appendChild(overlay);
}

/**
 * Closes the currently opened modal dialog.
 */
export function closeModal() {
  const container = document.getElementById('modal-container');
  if (container) {
    container.innerHTML = '';
  }
}

/**
 * Opens image preview modal with direct zoomed view.
 * @param {string} fileId
 * @param {string} fileName
 */
export function showImagePreviewModal(fileId, fileName) {
  const downloadUrl = `/api/download/${fileId}`;

  const img = createElement('img', {
    src: downloadUrl,
    alt: fileName,
    class: 'modal-preview-img',
  });

  const downloadBtn = createElement(
    'a',
    {
      href: downloadUrl,
      download: fileName,
      class: 'btn btn--primary',
    },
    'Download Image'
  );

  showModal({
    title: fileName,
    contentNode: img,
    actions: [downloadBtn],
  });
}

/**
 * Opens QR Code modal for connecting mobile devices.
 * @param {string} qrDataUrl
 * @param {string} connectUrl
 */
export function showQrModal(qrDataUrl, connectUrl) {
  const img = createElement('img', {
    src: qrDataUrl,
    alt: 'Scan QR Code',
    class: 'modal-qr-img',
  });

  const urlDisplay = createElement('div', { class: 'modal-qr-url' }, connectUrl);

  const copyBtn = createElement(
    'button',
    {
      class: 'btn btn--secondary btn--sm',
      onclick: async () => {
        const success = await copyToClipboard(connectUrl);
        if (success) {
          showToast({ type: 'success', message: 'Connection URL copied to clipboard!' });
        }
      },
    },
    'Copy URL'
  );

  const content = createElement('div', { class: 'modal-qr-content' }, [
    createElement(
      'p',
      { style: 'margin-bottom: 1rem;' },
      'Scan this QR code with your phone camera or browser on the same Wi-Fi:'
    ),
    img,
    urlDisplay,
    copyBtn,
  ]);

  showModal({
    title: 'Connect Mobile Device',
    contentNode: content,
  });
}
