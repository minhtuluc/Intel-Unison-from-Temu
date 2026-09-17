/**
 * Relay inbox (M4 / UT-023) — the receiver's side of a relay transfer.
 *
 * A relay is addressed to this device, not to the host, so the receiver is the one who
 * decides. The download capability issued at decision time is kept per file and appended
 * to the download URL: `<a download>` cannot carry headers, and without a PIN there is no
 * session cookie to identify this device either.
 */

import { createElement, showModal, closeModal, showToast } from './ui.js';
import { apiFetch } from './api.js';
import { formatFileSize, formatRelativeTime } from './utils.js';

const TOKEN_KEY = 'utrans_relay_tokens';

export class RelayInbox {
  constructor() {
    /** @type {object[]} files currently waiting for this receiver */
    this.files = [];
  }

  /** @private */
  _readTokens() {
    try {
      const raw = sessionStorage.getItem(TOKEN_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  /** @private */
  _writeTokens(map) {
    try {
      sessionStorage.setItem(TOKEN_KEY, JSON.stringify(map));
    } catch {
      // A browser that refuses storage still lets the file be fetched by device identity.
    }
  }

  /**
   * Remembers the capabilities handed out with a decision. They are returned exactly
   * once, so this is the only chance to keep them.
   */
  rememberTokens(relayId, files = []) {
    const map = this._readTokens();
    let stored = 0;
    for (const file of files) {
      if (!file?.relayToken) continue;
      map[`${relayId}:${file.index}`] = file.relayToken;
      stored++;
    }
    if (stored > 0) this._writeTokens(map);
    return stored;
  }

  /** The capability for one relayed file, if this device still holds it. */
  tokenFor(relayId, fileIndex) {
    return this._readTokens()[`${relayId}:${fileIndex}`] || null;
  }

  /** Download URL for a relayed file, carrying its capability when we have it. */
  downloadUrl(file) {
    const token = this.tokenFor(file.relayId, file.fileIndex);
    const base = `/api/download/${file.fileId}`;
    return token ? `${base}?rt=${encodeURIComponent(token)}` : base;
  }

  /** Reloads the files addressed to this device. */
  async load() {
    try {
      const res = await apiFetch('/api/relay/incoming');
      if (!res.ok) return this.files;
      const body = await res.json();
      this.files = body.data?.files || [];
    } catch {
      // Keep whatever was last known; a failed refresh must not empty the list.
    }
    return this.files;
  }

  /**
   * Accepts or declines individual files. Only the receiver can do this; the server
   * enforces that, and a rejection here is reported rather than swallowed.
   */
  async decide(relayId, decisions) {
    const res = await apiFetch('/api/relay/decision', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ relayId, decisions }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(body?.error?.message || `HTTP ${res.status}`);
    }
    this.rememberTokens(relayId, body.data?.files || []);
    return body.data;
  }

  /**
   * Prompts this device to accept a relay offered to it.
   * @param {object} offer sanitized relay from the server
   * @param {{ onDecided?: Function }} [options]
   */
  promptOffer(offer, { onDecided } = {}) {
    if (!offer?.relayId) return;

    if (navigator.vibrate) {
      navigator.vibrate([100, 50, 100]);
    }

    const senderTitle = offer.sender?.label || 'A device';
    const selected = new Set(offer.files.map((file) => file.index));

    const rows = offer.files.map((file) =>
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

    const submit = async (decisions) => {
      try {
        await this.decide(offer.relayId, decisions);
        const accepted = decisions.filter((d) => d.action === 'accept').length;
        showToast(
          accepted === 0
            ? { message: 'Transfer declined', type: 'warning' }
            : { message: `Receiving ${accepted} file(s)`, type: 'success' }
        );
      } catch (err) {
        showToast({ message: `Could not answer the sender: ${err.message}`, type: 'danger' });
      } finally {
        if (typeof onDecided === 'function') await onDecided();
      }
    };

    const content = createElement('div', { class: 'approval-modal-body' }, [
      createElement(
        'h4',
        { style: 'margin-bottom: var(--space-1);' },
        `${senderTitle} wants to send this device ${offer.files.length} file${offer.files.length === 1 ? '' : 's'}:`
      ),
      createElement('div', { class: 'offer-file-list' }, rows),
      createElement(
        'p',
        { style: 'font-size: var(--font-size-xs); color: var(--color-text-secondary);' },
        'Accepted files are held on the host for you to download. The host cannot read them.'
      ),
      createElement('div', { class: 'approval-actions' }, [
        createElement(
          'button',
          {
            class: 'btn btn--danger',
            onclick: async () => {
              closeModal();
              await submit(offer.files.map((file) => ({ index: file.index, action: 'decline' })));
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
              await submit(
                offer.files.map((file) => ({
                  index: file.index,
                  action: selected.has(file.index) ? 'accept' : 'decline',
                }))
              );
            },
          },
          'Accept Selected'
        ),
      ]),
    ]);

    showModal({ title: 'File sent to this device', contentNode: content, actions: [] });
  }

  /**
   * Renders the inbox view into a container.
   * @param {HTMLElement} container
   */
  renderInto(container) {
    container.innerHTML = '';

    const header = createElement('div', { class: 'view-header' }, [
      createElement('h1', { class: 'view-title' }, 'Incoming'),
      createElement(
        'p',
        { class: 'view-subtitle' },
        'Files other devices sent to this one. Only this device can download them.'
      ),
    ]);
    container.appendChild(header);

    if (this.files.length === 0) {
      container.appendChild(
        createElement(
          'div',
          { class: 'empty-state' },
          createElement(
            'p',
            {},
            'Nothing waiting. Files addressed to this device appear here until they expire.'
          )
        )
      );
      return;
    }

    const list = createElement('div', { class: 'relay-inbox-list' });
    for (const file of this.files) {
      list.appendChild(
        createElement('div', { class: 'relay-inbox-item' }, [
          createElement('div', { class: 'relay-inbox-item__info' }, [
            createElement('span', { class: 'relay-inbox-item__name' }, file.name),
            createElement(
              'span',
              { class: 'relay-inbox-item__meta' },
              `${formatFileSize(file.size)} • from ${file.sender?.label || 'a device'} • ${formatRelativeTime(file.storedAt)}`
            ),
            createElement(
              'span',
              { class: 'relay-inbox-item__meta' },
              `available until ${new Date(file.expiresAt).toLocaleTimeString()}`
            ),
          ]),
          createElement(
            'a',
            {
              class: 'btn btn--primary btn--sm',
              href: this.downloadUrl(file),
              download: file.name,
            },
            'Download'
          ),
        ])
      );
    }
    container.appendChild(list);
  }
}

export const relayInbox = new RelayInbox();
