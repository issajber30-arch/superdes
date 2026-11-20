// Designer/client dashboard (Stitch "Projects Overview & Multi-Client Portfolio"), filled with real studio data only:
// banner, metric tiles, status filter, project cards, invitations + activity panels, studio details.
import { api, apiUrl, errorText, PREVIEW } from '../api.js';
import { h, field, notice, busy, fmtDate, copyButton, badge, select, toast } from '../dom.js';
import { icon } from '../icons.js';
import { session, isStaff, isOwner } from '../state.js';
import { wizardForm } from '../editor/wizard.js';
import { go } from '../app.js';

const inviteLink = (token) => `${location.origin}${location.pathname}#/invite/${encodeURIComponent(token)}`;
const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const TRIAL_CREDITS = 50; // backend settings.trial_credits: the credits bar is relative to the trial grant

function linkBox(url, note) {
  const input = h('input', { type: 'text', readonly: true, value: url, class: 'linkbox', 'aria-label': 'Invitation link' });
  input.addEventListener('focus', () => input.select());
  return h('div', { class: 'invite-result' }, h('p', { class: 'small' }, note), h('div', { class: 'row gap' }, input, copyButton(url)));
}

function inviteForm({ role, projectId, onCreated }) {
  const email = h('input', { type: 'email', maxlength: 254, placeholder: 'optional' });
  const ttl = select([[24, '1 day'], [168, '7 days'], [720, '30 days']], 168);
  const err = notice();
  const out = h('div');
  const btn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, role === 'client' ? 'Create client link' : 'Create designer link');
  const form = h('form', { class: 'inline-form' }, field('Email (for your reference)', email), field('Valid for', ttl), btn, err, out);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    busy(btn, async () => {
      try {
        const body = { role, ttl_hours: Number(ttl.value) };
        if (projectId) body.project_id = projectId;
        if (email.value.trim()) body.email = email.value.trim();
        const inv = await api('/invitations', { method: 'POST', body });
        out.replaceChildren(linkBox(inviteLink(inv.token), 'Copy this link and send it yourself — it is shown only once and works one time.'));
        if (onCreated) onCreated();
      } catch (ex) { err.show(errorText(ex)); }
    });
  });
  return form;
}

const metric = ({ label, ic, tone, value, unit, note, bar, barTone }) => h('div', { class: 'metric' },
  h('div', { class: 'metric-head' }, h('span', { class: 'label-mono' }, label), ic ? h('span', { class: `metric-icon ${tone || ''}` }, icon(ic, 20)) : null),
  h('div', null,
    h('div', { class: 'metric-value' }, h('span', { class: 'metric-num' }, value), unit ? h('span', { class: 'metric-unit' }, unit) : null),
    note ? h('div', { class: 'metric-note' }, note) : null),
  h('div', { class: 'metric-bar' }, h('div', { class: `metric-fill ${barTone || ''}`, style: `width:${Math.round(Math.max(0, Math.min(1, bar)) * 100)}%` })));

const dot = (tone) => h('span', { class: `dot ${tone || ''}`, 'aria-hidden': 'true' });

function panel(ic, title, ...body) {
  return h('section', { class: 'dash-panel' }, h('div', { class: 'dash-panel-head' }, h('div', { class: 'row gap-sm' }, icon(ic, 22), h('h2', null, title))), ...body);
}

export async function dashboardPage(main) {
  const me = session.me;
  if (!me.studio) { go('#/start'); return; }
  const staff = isStaff();
  const page = h('section', { class: 'page wide dash' });
  main.append(page);
  const [projects, studio, members] = await Promise.all([api('/projects'), api('/studio'),
    staff ? api('/studio/members').catch(() => null) : null]);
  const all = projects.projects;
  const sub = studio.subscription || {};
  const active = all.filter((p) => p.status === 'active');
  const review = all.filter((p) => p.review_status === 'provisional');

  // --- banner ---
  const newBtn = staff ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { newBox.hidden = !newBox.hidden; if (!newBox.hidden) newBox.querySelector('input').focus(); } },
    icon('add', 18), 'New project') : null;
  page.append(h('div', { class: 'dash-banner' },
    h('div', { class: 'row gap min0' },
      h('div', { class: 'dash-banner-icon', 'aria-hidden': 'true' }, icon('architecture', 20)),
      h('div', { class: 'min0' },
        h('div', { class: 'row gap-sm wrap' }, h('h1', null, 'Projects'), sub.plan_key ? h('span', { class: 'chip-dark' }, sub.status && sub.status !== sub.plan_key ? `${sub.plan_key} · ${sub.status}` : sub.plan_key) : null),
        h('p', { class: 'muted small' }, `${me.studio.name} · ${me.role} · ${all.length} project${all.length === 1 ? '' : 's'}${sub.trial_ends_at ? ` · trial ends ${fmtDate(sub.trial_ends_at)}` : ''}`))),
    newBtn));

  // --- new project (staff) ---
  const newBox = h('div', { class: 'card', hidden: true });
  if (staff) {
    const err = notice();
    const name = h('input', { type: 'text', required: true, maxlength: 200 });
    const useWizard = h('input', { type: 'checkbox', checked: true });
    const wiz = h('div');
    const create = async (geometry) => {
      if (!name.value.trim()) { err.show('Give the project a name.'); name.focus(); return; }
      try {
        const body = { name: name.value.trim() };
        if (geometry) body.geometry = geometry;
        const p = await api('/projects', { method: 'POST', body });
        go(`#/p/${p.id}/plan`);
      } catch (ex) { err.show(errorText(ex)); }
    };
    const blankBtn = h('button', { type: 'button', class: 'btn btn-primary', hidden: true, onclick: () => create(null) }, 'Create empty project');
    const renderWiz = () => {
      wiz.replaceChildren(useWizard.checked ? wizardForm((g) => create(g), { submitLabel: 'Create project' }) : blankBtn);
      blankBtn.hidden = useWizard.checked;
    };
    useWizard.addEventListener('change', renderWiz);
    renderWiz();
    newBox.append(h('h2', null, 'New project'), field('Project name', name), h('label', { class: 'check' }, useWizard, ' Lay out rooms with the guided wizard'), wiz, err);
    page.append(newBox);
  }

  // --- metrics ---
  const n = (x) => String(x);
  const tiles = [metric({ label: 'Active projects', ic: 'apartment', tone: 'tone-secondary', value: n(active.length), unit: 'Projects',
    note: [dot('tone-secondary'), `${all.length - active.length} archived · ${all.length} total`], bar: all.length ? active.length / all.length : 0, barTone: 'fill-secondary' })];
  if (studio.credits != null) {
    tiles.push(metric({ label: 'Render credits', ic: 'toll', value: n(studio.credits), unit: 'Credits',
      note: `1 credit per concept render${sub.plan_key ? ` · ${sub.plan_key} plan` : ''}`, bar: studio.credits / TRIAL_CREDITS, barTone: 'fill-primary' }));
  }
  tiles.push(metric({ label: 'Needs professional review', ic: 'flag', tone: 'tone-error', value: n(review.length), unit: review.length === 1 ? 'Project' : 'Projects',
    note: [dot('tone-error'), 'Walls, openings, kitchens or bathrooms changed'], bar: all.length ? review.length / all.length : 0, barTone: 'fill-error' }));
  if (members) {
    const count = (r) => members.members.filter((m) => m.role === r).length;
    tiles.push(metric({ label: 'Studio team', ic: 'group', tone: 'tone-secondary', value: n(members.members.length), unit: 'Members',
      note: `${count('owner') + count('designer')} designer${count('owner') + count('designer') === 1 ? '' : 's'} · ${count('client')} client${count('client') === 1 ? '' : 's'}`,
      bar: 1, barTone: 'fill-secondary-soft' }));
  }
  page.append(h('div', { class: 'metric-grid' }, tiles));

  // --- filter bar + cards ---
  const filters = [['all', 'All projects', all], ['active', 'Active', active], ['archived', 'Archived', all.filter((p) => p.status !== 'active')], ['review', 'Needs review', review]];
  let current = 'all';
  const filterBtns = filters.map(([k, label, list]) => h('button', { type: 'button', class: 'filter-btn', 'aria-pressed': String(k === current), onclick: () => { current = k; renderCards(); } }, `${label} (${list.length})`));
  const showing = h('span', { class: 'strong' });
  page.append(h('div', { class: 'filter-bar', role: 'group', 'aria-label': 'Filter projects' }, h('span', { class: 'label-mono' }, 'Filter view:'), filterBtns));
  page.append(h('div', { class: 'list-meta' }, showing));
  const grid = h('div', { class: 'project-grid' });
  page.append(grid);

  const renderCache = new Map(); // project id -> Promise of its renders (fetched once, shown on every filter)
  function card(p) {
    const media = h('div', { class: 'pc-media' }, h('div', { class: 'pc-placeholder' }, icon('photo_camera', 28), h('span', null, 'No concept render yet')));
    const renderCount = h('div', { class: 'mono strong' }, '…');
    if (!renderCache.has(p.id)) renderCache.set(p.id, api(`/projects/${p.id}/renders`).catch(() => ({ renders: [] })));
    renderCache.get(p.id).then(({ renders }) => {
      const done = renders.filter((r) => r.status === 'succeeded' && r.result_url);
      renderCount.textContent = `${done.length} concept render${done.length === 1 ? '' : 's'}`;
      if (done[0]) {
        const r = done[0];
        media.replaceChildren(h('img', { src: apiUrl(r.result_url), alt: `Latest concept render of ${p.name}`, loading: 'lazy' }),
          h('span', { class: 'pc-caption' }, `Plan v${r.plan_version_no} · ${(r.view && r.view.style) || 'concept'}`));
      }
    });
    const provisional = p.review_status === 'provisional';
    const inviteBox = h('div', { hidden: true });
    const tile = (label, value, note, tone) => h('div', { class: 'pc-tile' }, h('span', { class: 'label-mono' }, label), h('strong', null, value), h('span', { class: `small ${tone || 'muted'}` }, note));
    return h('article', { class: 'project-card' },
      h('div', { class: 'pc-head' },
        h('div', { class: 'row gap-sm wrap' },
          h('span', { class: `status-chip ${p.status === 'active' ? '' : 'muted-chip'}` }, dot(p.status === 'active' ? 'tone-secondary pulse' : ''), p.status.toUpperCase()),
          p.current_version_no ? h('span', { class: 'label-mono flat' }, `PLAN V${p.current_version_no}`) : null,
          provisional ? badge('Needs professional review', 'warn') : null),
        h('h3', null, h('a', { href: `#/p/${p.id}/plan` }, p.name)),
        h('p', { class: 'muted small' }, `Created ${fmtDate(p.created_at)}`)),
      h('div', { class: 'pc-body' }, media,
        h('div', { class: 'pc-profile' },
          h('div', null, h('span', { class: 'label-mono' }, 'Project profile'), h('div', { class: 'strong' }, p.current_version_no ? `Plan version ${p.current_version_no}` : 'No plan yet'),
            h('div', { class: 'muted small' }, provisional ? 'Provisional — needs professional review' : 'Conceptual')),
          h('div', { class: 'pc-box' }, h('span', { class: 'label-mono' }, 'Renders'), renderCount))),
      h('div', { class: 'pc-tiles' },
        tile('Plan', p.current_version_no ? `v${p.current_version_no}` : '—', 'Current version'),
        tile('Review', provisional ? 'Provisional' : 'Conceptual', provisional ? 'Needs a professional' : 'No flags', provisional ? 'warn-text' : 'secondary-text'),
        tile('Status', p.status === 'active' ? 'Active' : 'Archived', p.status === 'active' ? 'In progress' : 'Read only')),
      h('div', { class: 'pc-foot' },
        h('a', { class: 'btn btn-primary btn-small', href: `#/p/${p.id}/plan` }, icon('architecture', 16), 'Open plan'),
        staff && !PREVIEW ? h('button', { type: 'button', class: 'btn btn-small btn-soft', onclick: () => {
          inviteBox.hidden = !inviteBox.hidden;
          if (!inviteBox.hidden && !inviteBox.firstChild) inviteBox.append(inviteForm({ role: 'client', projectId: p.id, onCreated: refreshInvites }));
        } }, icon('mail', 16), 'Invite client') : null),
      inviteBox);
  }
  function renderCards() {
    const list = filters.find(([k]) => k === current)[2];
    filterBtns.forEach((b, i) => b.setAttribute('aria-pressed', String(filters[i][0] === current)));
    showing.textContent = `Showing ${list.length} of ${all.length} project${all.length === 1 ? '' : 's'}`;
    grid.replaceChildren(...(list.length ? list.map(card) : [h('p', { class: 'muted' }, !all.length
      ? (staff ? (PREVIEW ? 'No projects yet. Create one above.' : 'No projects yet. Create one, or share your studio link with clients.') : 'You have no projects yet.')
      : 'No projects match this filter.')]));
  }
  renderCards();

  if (!staff) return;

  // --- invitations (left) + activity and client link (right) ---
  const names = Object.fromEntries(all.map((p) => [p.id, p.name]));
  const invList = h('div', { class: 'timeline' });
  async function refreshInvites() {
    try {
      const inv = await api('/invitations');
      invList.replaceChildren(...(inv.invitations.length ? inv.invitations.map((i) => {
        const exp = new Date(i.expires_at);
        const status = i.used_at ? 'used' : exp < new Date() ? 'expired' : 'open';
        const revoke = status === 'open' ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: async (e) => {
          try { await busy(e.currentTarget, () => api(`/invitations/${i.id}`, { method: 'DELETE' })); toast('Invitation revoked'); refreshInvites(); } catch (ex) { toast(errorText(ex), 'error'); }
        } }, 'Revoke') : null;
        return h('div', { class: 'tl-row' },
          h('div', { class: 'row gap-sm min0' },
            h('div', { class: 'date-block' }, h('span', { class: 'label-mono' }, exp.toLocaleString(undefined, { month: 'short' })), h('strong', { class: 'mono' }, String(exp.getDate()))),
            h('div', { class: 'min0' },
              h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'strong' }, `${i.role === 'client' ? 'Client' : 'Designer'} invitation${i.project_id ? ` — ${names[i.project_id] || 'project'}` : ''}`),
                badge(status.toUpperCase(), status === 'open' ? 'ok' : null)),
              h('p', { class: 'muted small' }, `${i.email || 'No email noted'} · expires ${fmtDate(i.expires_at)}`))),
          revoke);
      }) : [h('p', { class: 'muted' }, 'No invitations yet.')]));
    } catch (ex) { invList.replaceChildren(h('p', { class: 'notice notice-error' }, errorText(ex))); }
  }
  const left = PREVIEW ? null : panel('calendar_month', 'Invitations',
    isOwner() ? h('details', null, h('summary', null, 'Invite a designer to the studio'), inviteForm({ role: 'designer', onCreated: refreshInvites })) : null,
    invList);
  if (!PREVIEW) refreshInvites();

  const right = panel('history', isOwner() ? 'Studio activity' : 'Client link');
  if (isOwner()) {
    const who = Object.fromEntries(((members && members.members) || []).map((m) => [m.id, m.display_name || m.email]));
    const feed = h('div', { class: 'feed' });
    const more = h('button', { type: 'button', class: 'btn btn-small btn-ghost' }, 'Load older events');
    let before = null;
    const load = async () => {
      const lim = before ? 50 : 6; // the panel opens with the latest few, like the Stitch activity list
      try {
        const res = await api(`/studio/audit?limit=${lim}${before ? `&before_id=${encodeURIComponent(before)}` : ''}`);
        feed.append(...res.events.map((ev) => {
          const name = ev.actor_id ? (who[ev.actor_id] || ev.actor_id.slice(0, 8)) : 'System';
          return h('div', { class: 'feed-row' }, h('span', { class: 'avatar' }, initials(name)),
            h('div', { class: 'min0' }, h('p', null, h('span', { class: 'strong' }, name), ` ${ev.action.replace(/[._]/g, ' ')}`, ev.target_type ? h('span', { class: 'secondary-text' }, ` · ${ev.target_type}`) : null),
              h('span', { class: 'label-mono flat' }, fmtDate(ev.created_at))));
        }));
        if (!feed.childElementCount) feed.append(h('p', { class: 'muted' }, 'No events yet.'));
        if (res.events.length) before = res.events[res.events.length - 1].id;
        more.hidden = res.events.length < lim;
      } catch (ex) { feed.replaceChildren(h('p', { class: 'notice notice-error' }, errorText(ex))); more.hidden = true; }
    };
    more.addEventListener('click', () => busy(more, load));
    right.append(feed, more);
    load();
  }
  if (!PREVIEW) {
    const url = `${location.origin}${location.pathname}#/s/${me.studio.slug}`;
    right.append(h('div', { class: 'client-link' },
      h('div', { class: 'row between' }, h('span', { class: 'label-mono' }, 'Client link'), h('span', { class: 'label-mono flat secondary-text' }, 'Studio sign-up')),
      h('div', { class: 'row gap-sm' }, h('input', { type: 'text', readonly: true, value: url, class: 'linkbox', 'aria-label': 'Studio client link' }), copyButton(url, 'Copy'))));
  }
  if (left || right.childElementCount > 1) page.append(h('div', { class: 'dash-bottom' }, left, right.childElementCount > 1 ? right : null));

  // --- studio details: plan, credit history, tiers, members ---
  const details = panel('tune', 'Studio',
    h('dl', { class: 'facts' },
      h('dt', null, 'Plan'), h('dd', null, `${sub.plan_key || '—'} (${sub.status || 'unknown'})`),
      sub.trial_ends_at ? [h('dt', null, 'Trial ends'), h('dd', null, fmtDate(sub.trial_ends_at))] : null,
      h('dt', null, 'Render credits'), h('dd', null, String(studio.credits ?? '—'))));
  const ledger = h('details', null, h('summary', null, 'Credit history'));
  ledger.addEventListener('toggle', async () => {
    if (!ledger.open || ledger.dataset.loaded) return;
    ledger.dataset.loaded = '1';
    try {
      const c = await api('/studio/credits');
      ledger.append(table(['When', 'Change', 'Reason'], c.ledger.map((l) => [fmtDate(l.created_at), (l.delta > 0 ? '+' : '') + l.delta, l.reason])));
    } catch (ex) { ledger.append(h('p', { class: 'notice notice-error' }, errorText(ex))); }
  });
  details.append(ledger);
  try {
    const plans = await api('/plans');
    details.append(h('details', null, h('summary', null, 'Subscription tiers'),
      table(['Tier', 'Monthly credits', 'Price'], plans.plans.map((pl) => [pl.name, String(pl.monthly_credits), pl.price_note || '']))));
  } catch { /* optional */ }
  if (members) {
    details.append(h('details', null, h('summary', null, `Members (${members.members.length})`),
      table(['Name', 'Email', 'Role', 'Joined'], members.members.map((x) => [x.display_name || '—', x.email, x.role, fmtDate(x.created_at)]))));
  }
  page.append(details);
}

export function table(headers, rows) {
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c)))))));
}
