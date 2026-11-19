// Designer/client dashboard: projects, invitations, credits/subscription, members, audit log.
import { api, errorText, PREVIEW } from '../api.js';
import { h, field, notice, busy, fmtDate, copyButton, badge, select, toast } from '../dom.js';
import { session, isStaff, isOwner } from '../state.js';
import { wizardForm } from '../editor/wizard.js';
import { go } from '../app.js';

const inviteLink = (token) => `${location.origin}${location.pathname}#/invite/${encodeURIComponent(token)}`;

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

export async function dashboardPage(main) {
  const me = session.me;
  if (!me.studio) { go('#/start'); return; }
  const staff = isStaff();
  const page = h('section', { class: 'page' });
  main.append(page);
  const [projects, studio] = await Promise.all([api('/projects'), api('/studio')]);

  page.append(h('div', { class: 'page-head' },
    h('div', null, h('p', { class: 'eyebrow' }, `${me.studio.name} · ${me.role}`), h('h1', null, 'Projects')),
    staff ? h('button', { type: 'button', class: 'btn btn-primary', onclick: () => { newBox.hidden = !newBox.hidden; if (!newBox.hidden) newBox.querySelector('input').focus(); } }, 'New project') : null));

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

  // --- project list ---
  const list = h('div', { class: 'grid cards' });
  if (!projects.projects.length) list.append(h('p', { class: 'muted' }, staff ? (PREVIEW ? 'No projects yet. Create one above.' : 'No projects yet. Create one, or share your studio link with clients.') : 'You have no projects yet.'));
  for (const p of projects.projects) {
    const inviteBox = h('div', { hidden: true });
    list.append(h('article', { class: 'card project-card' },
      h('h2', null, h('a', { href: `#/p/${p.id}/plan` }, p.name)),
      h('p', { class: 'row gap wrap' },
        badge(p.status), p.current_version_no ? badge(`Plan v${p.current_version_no}`) : null,
        p.review_status === 'provisional' ? badge('Needs professional review', 'warn') : null),
      h('p', { class: 'muted small' }, `Created ${fmtDate(p.created_at)}`),
      staff && !PREVIEW ? h('button', { type: 'button', class: 'btn btn-small', onclick: () => {
        inviteBox.hidden = !inviteBox.hidden;
        if (!inviteBox.hidden && !inviteBox.firstChild) inviteBox.append(inviteForm({ role: 'client', projectId: p.id, onCreated: refreshInvites }));
      } }, 'Invite client') : null,
      inviteBox));
  }
  page.append(list);

  if (!staff) return;

  // --- studio overview ---
  const sub = studio.subscription || {};
  const overview = h('section', { class: 'card' },
    h('h2', null, 'Studio'),
    h('dl', { class: 'facts' },
      h('dt', null, 'Plan'), h('dd', null, `${sub.plan_key || '—'} (${sub.status || 'unknown'})`),
      sub.trial_ends_at ? [h('dt', null, 'Trial ends'), h('dd', null, fmtDate(sub.trial_ends_at))] : null,
      h('dt', null, 'Render credits'), h('dd', null, String(studio.credits ?? '—')),
      PREVIEW ? null : [h('dt', null, 'Client link'), h('dd', null, h('div', { class: 'row gap wrap' },
        h('code', null, `${location.origin}${location.pathname}#/s/${me.studio.slug}`),
        copyButton(`${location.origin}${location.pathname}#/s/${me.studio.slug}`)))]));
  const ledger = h('details', null, h('summary', null, 'Credit history'));
  ledger.addEventListener('toggle', async () => {
    if (!ledger.open || ledger.dataset.loaded) return;
    ledger.dataset.loaded = '1';
    try {
      const c = await api('/studio/credits');
      ledger.append(table(['When', 'Change', 'Reason'], c.ledger.map((l) => [fmtDate(l.created_at), (l.delta > 0 ? '+' : '') + l.delta, l.reason])));
    } catch (ex) { ledger.append(h('p', { class: 'notice notice-error' }, errorText(ex))); }
  });
  overview.append(ledger);
  try {
    const plans = await api('/plans');
    overview.append(h('details', null, h('summary', null, 'Subscription tiers'),
      table(['Tier', 'Monthly credits', 'Price'], plans.plans.map((pl) => [pl.name, String(pl.monthly_credits), pl.price_note || '']))));
  } catch { /* optional */ }
  page.append(overview);

  // --- invitations ---
  const invList = h('div');
  async function refreshInvites() {
    try {
      const inv = await api('/invitations');
      const names = Object.fromEntries(projects.projects.map((p) => [p.id, p.name]));
      invList.replaceChildren(inv.invitations.length ? table(['Role', 'Project', 'Email', 'Expires', 'Status', ''], inv.invitations.map((i) => {
        const expired = new Date(i.expires_at) < new Date();
        const status = i.used_at ? 'used' : expired ? 'expired' : 'open';
        const revoke = status === 'open' ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: async (e) => {
          try { await busy(e.currentTarget, () => api(`/invitations/${i.id}`, { method: 'DELETE' })); toast('Invitation revoked'); refreshInvites(); } catch (ex) { toast(errorText(ex), 'error'); }
        } }, 'Revoke') : '';
        return [i.role, names[i.project_id] || '—', i.email || '—', fmtDate(i.expires_at), status, revoke];
      })) : h('p', { class: 'muted' }, 'No invitations yet.'));
    } catch (ex) { invList.replaceChildren(h('p', { class: 'notice notice-error' }, errorText(ex))); }
  }
  if (!PREVIEW) refreshInvites();
  if (!PREVIEW) page.append(h('section', { class: 'card' }, h('h2', null, 'Invitations'),
    isOwner() ? h('details', null, h('summary', null, 'Invite a designer to the studio'), inviteForm({ role: 'designer', onCreated: refreshInvites })) : null,
    invList));

  // --- members ---
  try {
    const m = await api('/studio/members');
    page.append(h('section', { class: 'card' }, h('h2', null, 'Members'),
      table(['Name', 'Email', 'Role', 'Joined'], m.members.map((x) => [x.display_name || '—', x.email, x.role, fmtDate(x.created_at)]))));
  } catch { /* staff-only; ignore */ }

  // --- audit (owner) ---
  if (isOwner()) {
    const body = h('div');
    const more = h('button', { type: 'button', class: 'btn btn-small' }, 'Load older events');
    let before = null;
    const rows = [];
    const load = async () => {
      try {
        const res = await api(`/studio/audit?limit=50${before ? `&before_id=${encodeURIComponent(before)}` : ''}`);
        rows.push(...res.events.map((ev) => [fmtDate(ev.created_at), ev.action, ev.target_type || '', ev.actor_id ? ev.actor_id.slice(0, 8) : 'system']));
        if (res.events.length) before = res.events[res.events.length - 1].id;
        more.hidden = res.events.length < 50;
        body.replaceChildren(rows.length ? table(['When', 'Action', 'Target', 'Actor'], rows) : h('p', { class: 'muted' }, 'No events.'));
      } catch (ex) { body.replaceChildren(h('p', { class: 'notice notice-error' }, errorText(ex))); }
    };
    more.addEventListener('click', () => busy(more, load));
    const audit = h('details', { class: 'card' }, h('summary', null, h('h2', { class: 'inline' }, 'Audit log')), body, more);
    audit.addEventListener('toggle', () => { if (audit.open && !rows.length) load(); });
    page.append(audit);
  }
}

export function table(headers, rows) {
  return h('div', { class: 'table-wrap' }, h('table', null,
    h('thead', null, h('tr', null, headers.map((x) => h('th', { scope: 'col' }, x)))),
    h('tbody', null, rows.map((r) => h('tr', null, r.map((c) => h('td', null, c)))))));
}
