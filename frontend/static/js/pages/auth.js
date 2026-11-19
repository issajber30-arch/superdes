// Sign in and designer onboarding (register + create studio).
import { api, errorText, PREVIEW } from '../api.js';
import { h, field, notice, busy } from '../dom.js';
import { session, isStaff } from '../state.js';
import { go, refreshSession } from '../app.js';
import { saveGuestPlan, hasGuestPlan } from './guest.js';

const safeNext = (n) => (n && /^#\/[A-Za-z0-9/_?=&.%-]*$/.test(n) ? n : null);

// After any sign-in/sign-up: save a pending guest plan if asked, otherwise go on.
export async function afterAuth(query, err) {
  await refreshSession();
  const me = session.me;
  if (query.save === 'guest' && hasGuestPlan()) {
    if (!me.studio) return go('#/start?save=guest');
    if (isStaff()) {
      const p = await saveGuestPlan();
      return go(`#/p/${p.id}/plan`);
    }
    err.show('Client accounts cannot create projects directly. Ask your designer for a studio link to save this plan.', 'info');
    return null;
  }
  const next = safeNext(query.next);
  if (!me.studio && !(next && next.startsWith('#/invite/'))) return go('#/start');
  return go(next || '#/dashboard');
}

export function loginPage(main, _params, query) {
  const err = notice();
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true, maxlength: 128 });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Sign in');
  const form = h('form', { class: 'card form' },
    query.save === 'guest' ? h('p', { class: 'notice notice-info' }, 'Sign in to save your guest plan to your studio.') : null,
    field('Email', email), field('Password', pw), btn, err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    busy(btn, async () => {
      try {
        await api('/auth/login', { method: 'POST', body: { email: email.value.trim(), password: pw.value } });
        await afterAuth(query, err);
      } catch (ex) { err.show(errorText(ex)); }
    });
  });
  main.append(h('section', { class: 'page narrow' },
    h('h1', null, 'Sign in'), form,
    PREVIEW ? null : h('p', { class: 'muted' }, 'New here? ', h('a', { href: `#/start${query.save ? '?save=guest' : ''}` }, 'Create a designer studio'), ' or ', h('a', { href: '#/guest' }, 'try it as a guest'), '. Clients join through their designer’s studio link or invitation.')));
}

const slugify = (v) => v.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);

export function startPage(main, _params, query) {
  const me = session.me;
  if (me && me.studio) {
    if (query.save === 'guest' && hasGuestPlan() && isStaff()) {
      return saveGuestPlan().then((p) => go(`#/p/${p.id}/plan`));
    }
    go('#/dashboard');
    return null;
  }
  const err = notice();
  const name = h('input', { type: 'text', autocomplete: 'name', maxlength: 100 });
  const email = h('input', { type: 'email', autocomplete: 'email', required: true, maxlength: 254 });
  const pw = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8, maxlength: 128 });
  const studioName = h('input', { type: 'text', required: true, maxlength: 100, autocomplete: 'organization' });
  const slug = h('input', { type: 'text', required: true, pattern: '[a-z0-9-]{3,40}', maxlength: 40, autocapitalize: 'off', spellcheck: 'false' });
  let slugTouched = false;
  slug.addEventListener('input', () => { slugTouched = true; });
  studioName.addEventListener('input', () => { if (!slugTouched) slug.value = slugify(studioName.value); });
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, me ? 'Create studio' : 'Create account and studio');
  const account = me ? [h('p', { class: 'muted' }, `Signed in as ${me.user.email}. Create your studio to continue.`)] : [
    h('h2', null, 'Your account'), field('Your name', name), field('Email', email), field('Password', pw, 'At least 8 characters.')];
  const form = h('form', { class: 'card form' },
    query.save === 'guest' ? h('p', { class: 'notice notice-info' }, 'Create your account to save the plan you drew as a guest. It becomes the first project in your studio.') : null,
    account,
    h('h2', null, 'Your studio'), field('Studio name', studioName),
    field('Studio link', slug, '3–40 lowercase letters, numbers or dashes. Clients use it to join you.'),
    btn, err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    if (!/^[a-z0-9-]{3,40}$/.test(slug.value)) { err.show('Studio link must be 3–40 lowercase letters, numbers or dashes.'); return; }
    if (!studioName.value.trim()) { err.show('Enter a studio name.'); return; }
    busy(btn, async () => {
      try {
        if (session.me && session.me.studio) { await afterAuth({ ...query, next: '#/dashboard' }, err); return; }
        if (!session.me) {
          if (pw.value.length < 8) { err.show('Password must be at least 8 characters.'); return; }
          const body = { email: email.value.trim(), password: pw.value };
          if (name.value.trim()) body.display_name = name.value.trim();
          session.me = await api('/auth/register', { method: 'POST', body });
        }
        await api('/studios', { method: 'POST', body: { name: studioName.value.trim(), slug: slug.value } });
        await afterAuth({ ...query, next: '#/dashboard' }, err);
      } catch (ex) {
        err.show(errorText(ex));
        if (session.me && !me) { // account exists now; keep only the studio part of the form
          form.querySelectorAll('input[type=email],input[type=password],input[autocomplete=name]').forEach((i) => i.closest('.field').remove());
          btn.textContent = 'Create studio';
        }
      }
    });
  });
  main.append(h('section', { class: 'page narrow' },
    h('h1', null, 'Set up your design studio'),
    h('p', { class: 'lead' }, 'Your studio gets a 14-day trial with 50 render credits.'), form,
    me ? null : h('p', { class: 'muted' }, 'Already registered? ', h('a', { href: `#/login${query.save ? '?save=guest' : ''}` }, 'Sign in'))));
  return null;
}
