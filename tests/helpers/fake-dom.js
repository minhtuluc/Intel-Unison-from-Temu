/**
 * A minimal DOM for testing the browser modules directly under Node.
 *
 * The repo deliberately carries no DOM dependency, so these tests build just the
 * surface `public/js/ui.js` touches: element creation, attributes, children,
 * `textContent`, `innerHTML` and the two container lookups.
 */

export class FakeNode {}

/**
 * @param {string} tag
 * @returns {object} a fake element
 */
export function makeElement(tag) {
  const el = new FakeNode();
  el.tagName = String(tag).toUpperCase();
  el.children = [];
  el.attributes = {};
  el.style = {};
  el.dataset = {};
  el.className = '';
  el._text = '';
  el._html = '';

  el.setAttribute = function (name, value) {
    this.attributes[name] = String(value);
    if (name === 'class') this.className = String(value);
  };
  el.getAttribute = function (name) {
    return Object.prototype.hasOwnProperty.call(this.attributes, name)
      ? this.attributes[name]
      : null;
  };
  el.appendChild = function (child) {
    this.children.push(child);
    return child;
  };
  el.addEventListener = function (type, handler) {
    this.listeners = this.listeners || {};
    (this.listeners[type] = this.listeners[type] || []).push(handler);
  };
  el.dispatch = function (type, event) {
    for (const handler of this.listeners?.[type] || []) handler(event);
  };
  el.remove = function () {
    this.removed = true;
  };

  // defineProperty, not Object.assign: assignment would flatten the accessor into a
  // plain value and every parent would report an empty textContent.
  Object.defineProperty(el, 'textContent', {
    get() {
      if (this.children.length === 0) return this._text;
      return this.children.map((child) => child.textContent).join('');
    },
    set(value) {
      this._text = value;
      this.children = [];
    },
    enumerable: true,
    configurable: true,
  });

  Object.defineProperty(el, 'innerHTML', {
    get() {
      return this._html;
    },
    set(value) {
      this._html = String(value);
      if (this._html === '') this.children = [];
    },
    enumerable: true,
    configurable: true,
  });

  return el;
}

/** Finds every descendant (and the node itself) whose class list contains `className`. */
export function findByClass(node, className) {
  const found = [];
  const classes = String(node.className || '')
    .split(/\s+/)
    .filter(Boolean);
  if (classes.includes(className)) found.push(node);
  for (const child of node.children || []) found.push(...findByClass(child, className));
  return found;
}

/**
 * Installs a fake global document with the containers ui.js looks for.
 * @returns {{ container: object, modalContainer: object, body: object, warnings: string[], restore: Function, click: Function }}
 */
export function installFakeDom() {
  const container = makeElement('div');
  const modalContainer = makeElement('div');
  const body = makeElement('body');
  const warnings = [];

  globalThis.Node = FakeNode;
  globalThis.document = {
    body,
    getElementById: (id) => {
      if (id === 'toast-container') return container;
      if (id === 'modal-container') return modalContainer;
      return null;
    },
    createElement: makeElement,
    createElementNS: (_namespace, tag) => makeElement(tag),
    createTextNode: (text) => {
      const node = makeElement('#text');
      node.textContent = text;
      return node;
    },
  };

  const realWarn = console.warn;
  console.warn = (...args) => warnings.push(args.join(' '));

  return {
    container,
    modalContainer,
    body,
    warnings,
    restore() {
      console.warn = realWarn;
      delete globalThis.document;
      delete globalThis.Node;
    },
  };
}
