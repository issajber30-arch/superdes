// App entry: hash router, top bar and session/branding bootstrap.
import { api, apiUrl, ApiError, errorText, PREVIEW } from './api.js';
import { h, badge } from './dom.js';
import { icon } from './icons.js';
import { session, loadMe, applyBranding, isOwner } from './state.js';
import { landingPage } from './pages/landing.js';
import { loginPage, startPage } from './pages/auth.js';
import { guestPage } from './pages/guest.js';
import { studioEntryPage } from './pages/studio.js';
import { invitePage } from './pages/invite.js';
import { dashboardPage } from './pages/dashboard.js';
import { brandingPage } from './pages/branding.js';
import { projectPage } from './pages/project.js';

const unavailable = (main) => main.append(h('section', { class: 'page narrow' },
  h('h1', null, 'Not available in personal preview'),
  h('p', null, 'Client links, invitations and the guest trial are switched off while the app runs in single-owner preview mode.'),
  h('p', null, h('a', { href: '#/' }, 'Go to the start page'))));

const routes = [
  [/^\/?$/, landingPage],
  [/^\/login$/, loginPage],
  [/^\/start$/, startPage],
  [/^\/guest$/, PREVIEW ? unavailable : guestPage],
  [/^\/s\/([a-z0-9-]{3,40})$/, PREVIEW ? unavailable : studioEntryPage, { ownBranding: !PREVIEW }],
  [/^\/invite\/([^/]+)$/, PREVIEW ? unavailable : invitePage, { ownBranding: !PREVIEW }],
  [/^\/dashboard$/, dashboardPage, { auth: true }],
  [/^\/branding$/, brandingPage, { auth: true }],
  [/^\/p\/([0-9a-fA-F-]{36})(?:\/([a-z]+))?$/, projectPage, { auth: true }],
];

const main = document.getElementById('main');
let cleanup = null;
let navSeq = 0;
let leaveGuard = null; // set by a page; returns false to cancel navigation away from it
let lastHash = location.hash;
export const setLeaveGuard = (fn) => { leaveGuard = fn; };
let chrome = null; // { topbar, rail } nodes set by the project page; cleared on every navigation

/** Project context in the top bar (breadcrumb + step group) and the left rail / bottom bar. */
export function setProjectChrome(c) {
  chrome = c;
  const host = document.getElementById('rail-host');
  host.replaceChildren(...(c && c.rail ? [c.rail] : []));
  document.body.classList.toggle('has-rail', !!(c && c.rail));
  renderTopbar();
}

export const go = (hash) => { if (location.hash === hash) route(); else location.hash = hash; };
export const currentNav = () => navSeq;

export async function refreshSession() {
  await loadMe();
  session.branding = null;
  if (session.me && session.me.studio) {
    try { session.branding = await api('/studio/branding'); } catch { /* branding is cosmetic */ }
  }
  renderTopbar();
}

export function renderTopbar() {
  const bar = document.getElementById('topbar');
  const me = session.me;
  const b = session.branding;
  const studio = me && me.studio;
  const brandName = (b && b.display_name) || (studio && studio.name) || 'SuperDes';
  const logo = studio && b && b.logo_upload_id ? h('img', { src: apiUrl(`/public/studios/${encodeURIComponent(studio.slug)}/logo?v=${encodeURIComponent(b.updated_at || '')}`), alt: '', class: 'topbar-logo' }) : null;
  const links = PREVIEW ? [badge('Personal preview')] : [];
  if (me) {
    if (studio) links.push(h('a', { href: '#/dashboard' }, 'Projects'));
    if (isOwner()) links.push(h('a', { href: '#/branding' }, 'Branding'));
    links.push(h('span', { class: 'topbar-user', title: me.user.email },
      h('span', { class: 'avatar' }, icon('person', 20)),
      h('span', { class: 'who' }, h('b', null, me.user.display_name || me.user.email), h('span', null, me.role || 'member'))));
    links.push(h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: logout }, 'Sign out'));
  } else {
    if (!PREVIEW) links.push(h('a', { href: '#/guest' }, 'Try it free'));
    links.push(h('a', { href: '#/login', class: 'btn btn-small' }, 'Sign in'));
  }
  bar.replaceChildren(
    h('a', { href: me && studio ? '#/dashboard' : '#/', class: 'brand' },
      logo || h('span', { class: 'brand-mark', 'aria-hidden': 'true' }, (brandName.trim()[0] || 'S').toUpperCase()),
      h('span', { class: 'brand-name' }, brandName)),
    chrome && chrome.topbar ? chrome.topbar : '', // replaceChildren(null) would render "null"
    h('nav', { class: 'topnav', 'aria-label': 'Main' }, links));
}

async function logout() {
  try { await api('/auth/logout', { method: 'POST' }); } catch { /* cookie may already be gone */ }
  session.me = null;
  session.branding = null;
  applyBranding(null);
  renderTopbar();
  go('#/');
}

function parseHash() {
  const raw = location.hash.replace(/^#/, '') || '/';
  const [path, qs] = raw.split('?');
  return { path, query: Object.fromEntries(new URLSearchParams(qs || '')) };
}

export async function route() {
  if (leaveGuard && location.hash !== lastHash && !leaveGuard()) {
    history.replaceState(null, '', lastHash || '#/'); // stay; replaceState fires no hashchange
    return;
  }
  leaveGuard = null;
  lastHash = location.hash;
  const seq = ++navSeq;
  if (cleanup) { try { cleanup(); } catch { /* ignore */ } cleanup = null; }
  const { path, query } = parseHash();
  const match = routes.map(([re, page, opts]) => [path.match(re), page, opts || {}]).find(([m]) => m);
  main.replaceChildren();
  if (chrome) setProjectChrome(null);
  window.scrollTo(0, 0);
  if (!match) {
    main.append(h('section', { class: 'page narrow' }, h('h1', null, 'Page not found'), h('p', null, h('a', { href: '#/' }, 'Go to the start page'))));
    return;
  }
  const [m, page, opts] = match;
  if (!opts.ownBranding) applyBranding(session.branding);
  if (opts.auth && !session.me) { go(`#/login?next=${encodeURIComponent(location.hash)}`); return; }
  try {
    const res = await page(main, m.slice(1).map((x) => (x === undefined ? x : decodeURIComponent(x))), query);
    if (seq !== navSeq) { if (typeof res === 'function') res(); return; }
    cleanup = typeof res === 'function' ? res : null;
  } catch (err) {
    if (seq !== navSeq) return;
    showPageError(err);
  }
  main.focus({ preventScroll: true });
}

export function showPageError(err) {
  if (err instanceof ApiError && err.status === 401) {
    session.me = null;
    renderTopbar();
    go(`#/login?next=${encodeURIComponent(location.hash)}`);
    return;
  }
  const notFound = err instanceof ApiError && err.status === 404;
  main.replaceChildren(h('section', { class: 'page narrow' },
    h('h1', null, notFound ? 'Not found' : 'Something went wrong'),
    h('p', { class: 'notice notice-error' }, notFound ? 'This item does not exist or you do not have access to it.' : errorText(err)),
    h('p', null, h('a', { href: '#/' }, 'Back to start'))));
}

window.addEventListener('hashchange', route);
window.addEventListener('unhandledrejection', (e) => {
  if (e.reason instanceof ApiError && e.reason.status === 401) showPageError(e.reason);
});

(async () => {
  try { await refreshSession(); } catch { session.me = null; renderTopbar(); }
  route();
})();
