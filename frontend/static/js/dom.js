// DOM helpers. Text is always set via text nodes / textContent, never innerHTML.
const SVG_NS = 'http://www.w3.org/2000/svg';
const PROPS = new Set(['value', 'checked', 'disabled', 'selected', 'hidden', 'multiple', 'indeterminate']);

function apply(el, attrs, isSvg) {
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.setAttribute('class', v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'style') for (const [p, val] of Object.entries(v)) el.style.setProperty(p, val);
    else if (!isSvg && PROPS.has(k)) el[k] = v;
    else el.setAttribute(k, v === true ? '' : String(v));
  }
}

function append(el, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  apply(el, attrs, false);
  return append(el, children);
}

export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  apply(el, attrs, true);
  return append(el, children);
}

export const clear = (el) => { el.replaceChildren(); return el; };

let fieldSeq = 0;
// Labelled form field. `input` is an element; returns a wrapper with a <label for>.
export function field(label, input, hint) {
  if (!input.id) input.id = `f${++fieldSeq}`;
  const hintEl = hint ? h('small', { class: 'hint', id: `${input.id}-hint` }, hint) : null;
  if (hintEl) input.setAttribute('aria-describedby', hintEl.id);
  return h('div', { class: 'field' }, h('label', { for: input.id }, label), input, hintEl);
}

export function select(options, value, attrs = {}) {
  return h('select', attrs, options.map(([v, label]) => h('option', { value: v, selected: String(v) === String(value ?? '') }, label)));
}

export function toast(message, kind = 'info') {
  const box = document.getElementById('toasts');
  const t = h('div', { class: `toast toast-${kind}` }, message);
  box.append(t);
  setTimeout(() => t.remove(), kind === 'error' ? 7000 : 3500);
}

// Inline error/notice area for forms.
export function notice() {
  const el = h('p', { class: 'notice', role: 'alert', hidden: true });
  el.show = (msg, kind = 'error') => { el.textContent = msg; el.className = `notice notice-${kind}`; el.hidden = !msg; };
  el.clear = () => { el.hidden = true; el.textContent = ''; };
  return el;
}

// Disable a button while an async action runs.
export async function busy(btn, fn) {
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  try { return await fn(); } finally { btn.disabled = false; btn.removeAttribute('aria-busy'); }
}

export const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '');
export const money = (n, cur = 'EUR') => {
  try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, maximumFractionDigits: 0 }).format(n || 0); } catch { return `${Math.round(n || 0)} ${cur}`; }
};

export function copyButton(text, label = 'Copy link') {
  const b = h('button', { class: 'btn btn-small', type: 'button' }, label);
  b.addEventListener('click', async () => {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); } catch { toast('Copy failed — select the text and copy it manually.', 'error'); }
  });
  return b;
}

export const badge = (text, kind = '') => h('span', { class: `badge ${kind ? `badge-${kind}` : ''}` }, text);
