// Guest trial: wizard + editor fully in localStorage; saving requires an account (QA 1).
import { api } from '../api.js';
import { h, toast } from '../dom.js';
import { loadGuest, saveGuest, clearGuest } from '../state.js';
import { PlanEditor, CAVEAT, isEmpty } from '../editor/svg-editor.js';
import { wizardForm } from '../editor/wizard.js';
import { go } from '../app.js';

export const hasGuestPlan = () => { const g = loadGuest(); return !!(g && g.geometry && !isEmpty(g.geometry)); };

export async function saveGuestPlan() {
  const g = loadGuest();
  const p = await api('/projects', { method: 'POST', body: { name: (g && g.name) || 'My first plan', geometry: g.geometry } });
  clearGuest();
  return p;
}

const CATALOG_KEY = 'sd_catalog_v1';
export async function loadCatalog() {
  try {
    const res = await api('/catalog/furniture');
    try { localStorage.setItem(CATALOG_KEY, JSON.stringify(res.items)); } catch { /* quota */ }
    return res.items;
  } catch {
    try { return JSON.parse(localStorage.getItem(CATALOG_KEY)) || []; } catch { return []; }
  }
}

export async function guestPage(main, _params, query) {
  const guest = loadGuest() || {};
  if (query.studio && /^[a-z0-9-]{3,40}$/.test(query.studio)) { guest.studio_slug = query.studio; saveGuest(guest); }
  const page = h('section', { class: 'page wide' });
  main.append(page);

  if (!guest.geometry || query.new === '1') {
    page.append(
      h('h1', null, 'Guest trial — describe your rooms'),
      h('p', { class: 'notice notice-info' }, 'Nothing is sent to a server while you try things out: your plan is kept in this browser only.'),
      h('div', { class: 'card' }, wizardForm((geometry) => {
        if (!saveGuest({ ...guest, geometry })) toast('This browser blocks local storage, so the plan will be lost on reload.', 'error');
        go('#/guest');
      }, { submitLabel: 'Open in editor' })),
      h('p', null, h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { saveGuest({ ...guest, geometry: {} }); go('#/guest'); } }, 'Start with an empty canvas instead')));
    return null;
  }

  const savePanel = h('div', { class: 'card save-panel', hidden: true });
  const name = h('input', { type: 'text', value: guest.name || 'My first plan', maxlength: 200, 'aria-label': 'Plan name' });
  name.addEventListener('change', () => saveGuest({ ...loadGuest(), name: name.value.trim().slice(0, 200) || 'My first plan' }));
  const showSave = () => {
    savePanel.hidden = false;
    const slug = (loadGuest() || {}).studio_slug;
    savePanel.replaceChildren(
      h('h2', null, 'Create an account to save your plan'),
      h('p', null, 'Guest plans live only in this browser. Register to keep it, share it and keep working on it with a designer.'),
      h('div', { class: 'row gap wrap' },
        slug ? h('a', { class: 'btn btn-primary', href: `#/s/${slug}?save=guest` }, 'Join the studio as a client') : null,
        h('a', { class: `btn ${slug ? '' : 'btn-primary'}`, href: '#/start?save=guest' }, "I'm a designer — create my studio"),
        h('a', { class: 'btn', href: '#/login?save=guest' }, 'I already have an account'),
        h('button', { type: 'button', class: 'btn btn-ghost', onclick: () => { savePanel.hidden = true; } }, 'Not now')));
    savePanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  };
  const host = h('div');
  page.append(
    h('div', { class: 'page-head' },
      h('h1', null, 'Guest plan'),
      h('div', { class: 'row gap wrap' }, name,
        h('button', { type: 'button', class: 'btn btn-primary', onclick: showSave }, 'Save'),
        h('a', { class: 'btn btn-ghost', href: '#/guest?new=1' }, 'Restart with wizard'))),
    h('p', { class: 'caveat', role: 'note' }, CAVEAT),
    savePanel, host);
  const editor = new PlanEditor(host, {
    geometry: guest.geometry,
    catalog: await loadCatalog(),
    onChange: (g) => saveGuest({ ...loadGuest(), geometry: g }),
  });
  return () => editor.destroy();
}
