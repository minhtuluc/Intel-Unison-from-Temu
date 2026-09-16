/**
 * UT-011 — the toast contract.
 *
 * Live bug this locks down: `showToast` destructured its first argument, but many
 * callers passed `(message, type)` as two strings. That produced an empty body and
 * always the `info` styling, with no error anywhere. The cases below assert what is
 * actually rendered, for both an error and a success.
 */

import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { resolveToastContent, showToast, TOAST_TYPES } from '../../public/js/ui.js';
import { describeReason } from '../../public/js/utils.js';
import { findByClass, installFakeDom } from '../helpers/fake-dom.js';

describe('UT-011 toast contract', () => {
  let container;
  let warnings;

  let dom;
  function installDom() {
    dom = installFakeDom();
    container = dom.container;
    warnings = dom.warnings;
    return () => dom.restore();
  }

  let restore;
  afterEach(() => {
    if (restore) restore();
  });

  it('resolves a title and type for every supported toast type', () => {
    assert.deepEqual([...TOAST_TYPES], ['info', 'success', 'warning', 'danger']);
    assert.equal(resolveToastContent({ type: 'success', message: 'ok' }).title, 'Success');
    assert.equal(resolveToastContent({ type: 'danger', message: 'bad' }).title, 'Error');
    assert.equal(resolveToastContent({ type: 'warning', message: 'hmm' }).title, 'Notice');
    assert.equal(resolveToastContent({ type: 'info', message: 'fyi' }).title, 'Information');
  });

  it('falls back to a safe type instead of rendering uncoloured', () => {
    const resolved = resolveToastContent({ type: 'not-a-type', message: 'x' });
    assert.equal(resolved.type, 'info');
    assert.equal(resolved.title, 'Information');
  });

  it('keeps an explicit title and coerces a non-string message', () => {
    const resolved = resolveToastContent({ type: 'info', title: 'Custom', message: 42 });
    assert.equal(resolved.title, 'Custom');
    assert.equal(resolved.message, '42');
  });

  it('renders a readable error toast', () => {
    restore = installDom();
    showToast({ type: 'danger', message: 'Upload failed: disk full', duration: 0 });

    assert.equal(container.children.length, 1);
    const toast = container.children[0];
    assert.ok(String(toast.className).includes('toast--danger'));
    assert.equal(findByClass(toast, 'toast__message')[0].textContent, 'Upload failed: disk full');
    assert.equal(findByClass(toast, 'toast__title')[0].textContent, 'Error');
  });

  it('renders a readable success toast', () => {
    restore = installDom();
    showToast({ type: 'success', message: 'Transferred photo.jpg successfully!', duration: 0 });

    const toast = container.children[0];
    assert.ok(String(toast.className).includes('toast--success'));
    assert.equal(
      findByClass(toast, 'toast__message')[0].textContent,
      'Transferred photo.jpg successfully!'
    );
    assert.equal(findByClass(toast, 'toast__title')[0].textContent, 'Success');
  });

  it('shows something for the deprecated two-string shape instead of a blank toast', () => {
    restore = installDom();
    showToast('Shared 3 file(s) successfully!', 'success');

    const toast = container.children[0];
    assert.equal(
      findByClass(toast, 'toast__message')[0].textContent,
      'Shared 3 file(s) successfully!'
    );
    assert.ok(String(toast.className).includes('toast--success'));
    assert.equal(warnings.length, 1, 'the deprecated shape is reported, not silently accepted');
  });

  it('warns when a call carries no message at all', () => {
    restore = installDom();
    showToast({ type: 'info' });
    assert.equal(warnings.length, 1);
  });

  it('does nothing when the toast container is absent', () => {
    restore = installDom();
    globalThis.document.getElementById = () => null;
    assert.doesNotThrow(() => showToast({ message: 'nowhere to go' }));
  });

  it('no caller in the shipped frontend uses the two-string shape', () => {
    const twoStringCall = /showToast\(\s*(`(?:[^`\\]|\\.)*`|'(?:[^'\\]|\\.)*')\s*,/;
    for (const file of [
      'public/js/app.js',
      'public/js/drop-zone.js',
      'public/js/file-browser.js',
    ]) {
      const source = fs.readFileSync(file, 'utf8');
      assert.equal(
        twoStringCall.test(source),
        false,
        `${file} still calls showToast with a bare string first argument`
      );
    }
  });
});

describe('UT-011 error text for arbitrary rejection reasons', () => {
  it('reads a message out of whatever was thrown', () => {
    assert.equal(describeReason(new Error('boom')), 'boom');
    assert.equal(describeReason('plain string'), 'plain string');
    assert.equal(describeReason(42), '42');
    assert.equal(describeReason(null), 'Unknown error');
    assert.equal(describeReason(undefined), 'Unknown error');
  });

  it('never renders an object as the useless [object Object]', () => {
    assert.equal(describeReason({ code: 'X', detail: 'y' }), '{"code":"X","detail":"y"}');
    assert.equal(describeReason({}), 'Unknown error');
  });

  it('survives a circular reason', () => {
    const circular = {};
    circular.self = circular;
    assert.equal(describeReason(circular), 'Unknown error');
  });
});
