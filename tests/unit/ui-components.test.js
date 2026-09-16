/**
 * Coverage for the shared UI primitives. These build the DOM the whole app renders
 * through, so an attribute that silently stops being applied breaks every view at
 * once — worth pinning rather than discovering on a phone.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  closeModal,
  createElement,
  getFileSvg,
  showImagePreviewModal,
  showModal,
  showQrModal,
} from '../../public/js/ui.js';
import { findByClass, installFakeDom } from '../helpers/fake-dom.js';

describe('createElement', () => {
  let dom;
  afterEach(() => dom?.restore());

  it('applies class, attributes and children', () => {
    dom = installFakeDom();
    const el = createElement('div', { class: 'card', 'data-role': 'x', title: 'Hi' }, [
      'text',
      createElement('span', {}, 'child'),
    ]);

    assert.equal(el.className, 'card');
    assert.equal(el.getAttribute('data-role'), 'x');
    assert.equal(el.getAttribute('title'), 'Hi');
    assert.equal(el.textContent, 'textchild');
  });

  it('treats a boolean attribute as present-or-absent', () => {
    dom = installFakeDom();
    assert.equal(createElement('input', { disabled: true }).getAttribute('disabled'), '');
    assert.equal(createElement('input', { disabled: false }).getAttribute('disabled'), null);
  });

  it('wires event handlers and default dataset entries', () => {
    dom = installFakeDom();
    let clicked = 0;
    const el = createElement('button', {
      onclick: () => clicked++,
      dataset: { id: 'abc' },
    });

    el.dispatch('click', {});
    assert.equal(clicked, 1);
    assert.equal(el.dataset.id, 'abc');
  });

  it('skips null and undefined attributes and children', () => {
    dom = installFakeDom();
    const el = createElement('div', { title: null, id: undefined }, [null, undefined, 'kept']);
    assert.equal(el.getAttribute('title'), null);
    assert.equal(el.getAttribute('id'), null);
    assert.equal(el.textContent, 'kept');
  });
});

describe('getFileSvg', () => {
  let dom;
  afterEach(() => dom?.restore());

  it('returns a sized svg for every known category', () => {
    dom = installFakeDom();
    for (const type of ['image', 'video', 'audio', 'apk', 'document', 'archive']) {
      const svg = getFileSvg(type);
      assert.equal(svg.style.width, '100%', `${type} svg is sized`);
      assert.ok(svg.innerHTML.length > 0, `${type} svg has a path`);
    }
  });

  it('falls back to a generic icon for an unknown category', () => {
    dom = installFakeDom();
    const svg = getFileSvg('something-else');
    assert.ok(svg.innerHTML.includes('path'));
  });
});

describe('modal helpers', () => {
  let dom;
  afterEach(() => dom?.restore());

  it('renders a modal with a title and body into the modal container', () => {
    dom = installFakeDom();
    showModal({
      title: 'Incoming File Transfer',
      contentNode: createElement('p', {}, 'body copy'),
    });

    assert.equal(dom.modalContainer.children.length, 1);
    assert.equal(
      findByClass(dom.modalContainer, 'modal__title')[0].textContent,
      'Incoming File Transfer'
    );
    assert.equal(findByClass(dom.modalContainer, 'modal__body')[0].textContent, 'body copy');
    assert.equal(findByClass(dom.modalContainer, 'modal__footer').length, 0);
  });

  it('adds a footer only when actions are supplied', () => {
    dom = installFakeDom();
    showModal({
      title: 'With actions',
      contentNode: createElement('p', {}, 'x'),
      actions: [createElement('button', {}, 'Download')],
    });

    assert.equal(findByClass(dom.modalContainer, 'modal__footer')[0].textContent, 'Download');
  });

  it('replaces any previously open modal rather than stacking', () => {
    dom = installFakeDom();
    showModal({ title: 'First', contentNode: createElement('p', {}, 'one') });
    showModal({ title: 'Second', contentNode: createElement('p', {}, 'two') });

    assert.equal(dom.modalContainer.children.length, 1);
    assert.equal(findByClass(dom.modalContainer, 'modal__title')[0].textContent, 'Second');
  });

  it('closes the overlay when the backdrop itself is clicked', () => {
    dom = installFakeDom();
    showModal({ title: 'Dismissable', contentNode: createElement('p', {}, 'x') });

    const overlay = findByClass(dom.modalContainer, 'modal-overlay')[0];
    overlay.dispatch('click', { target: overlay });
    assert.equal(dom.modalContainer.children.length, 0, 'backdrop click dismisses');
  });

  it('closeModal is safe with nothing open and with no container', () => {
    dom = installFakeDom();
    assert.doesNotThrow(() => closeModal());

    globalThis.document.getElementById = () => null;
    assert.doesNotThrow(() => closeModal());
    assert.doesNotThrow(() => showModal({ title: 'nowhere', contentNode: null }));
  });

  it('does nothing when the modal container is absent', () => {
    dom = installFakeDom();
    globalThis.document.getElementById = () => null;
    assert.doesNotThrow(() => showModal({ title: 'x', contentNode: createElement('p', {}, 'y') }));
  });

  it('builds an image preview with a download action', () => {
    dom = installFakeDom();
    showImagePreviewModal('f_123', 'holiday.jpg');

    const image = findByClass(dom.modalContainer, 'modal-preview-img')[0];
    assert.equal(image.getAttribute('src'), '/api/download/f_123');
    assert.equal(image.getAttribute('alt'), 'holiday.jpg');

    const link = findByClass(dom.modalContainer, 'btn--primary')[0];
    assert.equal(link.getAttribute('href'), '/api/download/f_123');
    assert.equal(link.getAttribute('download'), 'holiday.jpg');
  });

  it('builds a QR modal showing the connect URL', () => {
    dom = installFakeDom();
    showQrModal('data:image/png;base64,AAAA', 'http://192.168.1.5:8080');

    assert.equal(
      findByClass(dom.modalContainer, 'modal-qr-img')[0].getAttribute('src'),
      'data:image/png;base64,AAAA'
    );
    assert.equal(
      findByClass(dom.modalContainer, 'modal-qr-url')[0].textContent,
      'http://192.168.1.5:8080'
    );
    assert.equal(findByClass(dom.modalContainer, 'btn--sm')[0].textContent, 'Copy URL');
  });
});
