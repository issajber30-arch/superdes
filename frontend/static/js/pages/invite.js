// Invitation accept #/invite/{token}.
import { api, errorText } from '../api.js';
import { h, field, notice, busy, fmtDate } from '../dom.js';
import { session } from '../state.js';
import { go, refreshSession } from '../app.js';

export async function invitePage(main, [token]) {
  const t = encodeURIComponent(token);
  let inv;
  try { inv = await api(`/public/invitations/${t}`); } catch (ex) {
    if (![404, 422].includes(ex.status)) throw ex;
    main.append(h('section', { class: 'page narrow' }, h('h1', null, 'Invitation not found'),
      h('p', { class: 'notice notice-error' }, 'This invitation link is not valid. Check that you copied the whole link, or ask your designer for a new one.')));
    return;
  }
  const page = h('section', { class: 'page narrow' }, h('h1', null, `Join ${inv.studio_name}`));
  main.append(page);
  if (!inv.valid) {
    page.append(h('p', { class: 'notice notice-error' }, 'This invitation has expired, was already used, or was revoked. Ask your designer for a new link.'));
    return;
  }
  page.append(h('p', { class: 'lead' }, inv.role === 'client'
    ? `You are invited as a client to the project “${inv.project_name}”.`
    : 'You are invited to join the studio as a designer.'),
  h('p', { class: 'muted' }, `Invitation valid until ${fmtDate(inv.expires_at)}.`));
  const err = notice();
  const accept = async (body) => {
    const res = await api(`/public/invitations/${t}/accept`, { method: 'POST', body });
    await refreshSession();
    go(res.project_id ? `#/p/${res.project_id}/plan` : '#/dashboard');
  };
  if (session.me) {
    const btn = h('button', { type: 'button', class: 'btn btn-primary' }, `Accept as ${session.me.user.email}`);
    btn.addEventListener('click', () => busy(btn, () => accept({}).catch((ex) => err.show(errorText(ex)))));
    page.append(h('div', { class: 'card' }, btn, err));
    return;
  }
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: 100 });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Create account and accept');
  const form = h('form', { class: 'card form' }, field('Your name', name), field('Email', email), field('Password', pw, 'At least 8 characters.'), btn, err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    if (pw.value.length < 8) { err.show('Password must be at least 8 characters.'); return; }
    const body = { email: email.value.trim(), password: pw.value };
    if (name.value.trim()) body.display_name = name.value.trim();
    busy(btn, () => accept(body).catch((ex) => err.show(errorText(ex))));
  });
  page.append(form, h('p', { class: 'muted' }, 'Already have an account? ', h('a', { href: `#/login?next=${encodeURIComponent(`#/invite/${token}`)}` }, 'Sign in first'), ', then come back to this link.'));
}
