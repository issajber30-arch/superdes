// Public studio entry #/s/{slug}: studio branding, join as client, or try as guest.
import { api, apiUrl, errorText } from '../api.js';
import { h, field, notice, busy } from '../dom.js';
import { session, applyBranding, loadGuest, clearGuest } from '../state.js';
import { isEmpty } from '../editor/svg-editor.js';
import { go, refreshSession } from '../app.js';

export async function studioEntryPage(main, [slug], query) {
  const studio = await api(`/public/studios/${encodeURIComponent(slug)}`);
  applyBranding(studio);
  const title = studio.display_name || studio.name;
  const guest = loadGuest();
  const hasPlan = guest && guest.geometry && !isEmpty(guest.geometry);
  const err = notice();
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: 100 });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 });
  const project = h('input', { type: 'text', maxlength: 200, value: (guest && guest.name) || 'My home' });
  const usePlan = h('input', { type: 'checkbox', checked: true });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create my account');
  const form = h('form', { class: 'card form' },
    h('h2', null, 'Start your project with us'),
    field('Your name', name), field('Email', email), field('Password', pw, 'At least 8 characters.'),
    field('Project name', project),
    hasPlan ? h('label', { class: 'check' }, usePlan, ' Use the plan I drew as a guest') : null,
    btn, err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    if (pw.value.length < 8) { err.show('Password must be at least 8 characters.'); return; }
    busy(btn, async () => {
      try {
        const body = { email: email.value.trim(), password: pw.value, project_name: project.value.trim() || 'My project' };
        if (name.value.trim()) body.display_name = name.value.trim();
        if (hasPlan && usePlan.checked) body.geometry = guest.geometry;
        const res = await api(`/public/studios/${encodeURIComponent(slug)}/join`, { method: 'POST', body });
        if (body.geometry) clearGuest();
        await refreshSession();
        go(`#/p/${res.project.id}/plan`);
      } catch (ex) { err.show(errorText(ex)); }
    });
  });
  const logo = studio.logo_url ? h('img', { src: apiUrl(studio.logo_url), alt: `${title} logo`, class: 'studio-logo' }) : null;
  main.append(h('section', { class: 'page narrow studio-entry' },
    h('header', { class: 'studio-head' }, logo, h('h1', null, title)),
    h('p', { class: 'lead' }, `Plan your space with ${title}: sketch your rooms, share your brief and see concepts take shape.`),
    query.save === 'guest' && hasPlan ? h('p', { class: 'notice notice-info' }, 'Create your account below to save the plan you drew.') : null,
    session.me ? h('p', { class: 'notice notice-info' }, `You are signed in as ${session.me.user.email}. To join this studio with a different account, sign out first.`) : form,
    h('p', null, h('a', { class: 'btn btn-ghost', href: `#/guest?studio=${encodeURIComponent(slug)}` }, 'Try it first as a guest'),
      ' ', h('a', { href: '#/login' }, 'I already have an account'))));
}
