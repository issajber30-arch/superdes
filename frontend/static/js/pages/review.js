// Stitch "Designer Review & Markups" for the Collaboration and Compare sections: plan redlines / visual concepts A-B,
// markup (comment) log and design alternatives; spec audit + budget check; decision log, action tasks and the
// client message thread. Each route scrolls to its own column on small screens.
import { api, errorText } from '../api.js';
import { h, field, notice, busy, select, fmtDate, toast, money } from '../dom.js';
import { icon } from '../icons.js';
import { PlanEditor } from '../editor/svg-editor.js';
import { renderCard } from './renders.js';
import { flagList } from './plan.js';
import { table } from './dashboard.js';

const initials = (name) => (name || '?').trim().split(/\s+/).slice(0, 2).map((w) => w[0]).join('').toUpperCase();
const mid = (lo, hi) => (lo + hi) / 2;

export async function render(el, ctx) {
  const { base, pid, project, staff, tab } = ctx;
  const people = project.people || [];
  const nameOf = (id) => { const p = people.find((x) => x.id === id); return p ? (p.display_name || p.email) : '—'; };
  const [versions, renders, alts, styles, est, briefRes] = await Promise.all([api(`${base}/plan/versions`), api(`${base}/renders`), api(`${base}/alternatives`),
    api('/catalog/styles'), api(`${base}/estimates`), api(`${base}/brief`)]);
  const vs = versions.versions;
  const vOpts = vs.map((v) => [v.version_no, `v${v.version_no}${v.label ? ` — ${v.label}` : ''}`]);
  let alive = true;
  let timer = null;
  const editors = [];
  const panelHead = (title, sub, right) => h('div', { class: 'row between gap-sm align-start' }, h('div', null, h('h2', { class: 'col-head' }, title), sub ? h('span', { class: 'label-mono flat' }, sub) : null), right || null);

  // =============== column 1: redlines / concepts, markup log, alternatives ===============
  const fromSel = select(vOpts, vs.length > 1 ? vs[1].version_no : vs[0].version_no);
  const toSel = select(vOpts, vs[0].version_no);
  fromSel.setAttribute('aria-label', 'Compare from version'); toSel.setAttribute('aria-label', 'Compare to version');
  const panes = h('div', { class: 'stack-sm' });
  const diffBox = h('div', { class: 'stack-xs' });
  const cmpErr = notice();
  async function compare() {
    cmpErr.clear();
    editors.splice(0).forEach((e) => e.destroy());
    const a = Number(fromSel.value); const b = Number(toSel.value);
    try {
      const [va, vb, cmp] = await Promise.all([api(`${base}/plan/versions/${a}`), api(`${base}/plan/versions/${b}`), api(`${base}/plan/compare?from=${a}&to=${b}`)]);
      const changed = new Set(Object.values(cmp.diff).flatMap((d) => [...d.added, ...d.removed, ...d.changed]));
      panes.replaceChildren();
      for (const v of [va, vb]) {
        const host = h('div', { class: 'redline-pane' }, h('span', { class: 'pane-tag' }, `v${v.version_no}${v.label ? ` · ${v.label}` : ''}`));
        panes.append(host);
        editors.push(new PlanEditor(host, { geometry: v.geometry, readOnly: true, panel: false, highlight: changed }));
      }
      const rows = [];
      for (const [layer, d] of Object.entries(cmp.diff)) for (const kind of ['added', 'removed', 'changed']) for (const id of d[kind]) rows.push([layer, kind, id]);
      diffBox.replaceChildren(h('div', { class: 'row between' }, h('span', { class: 'label-mono flat' }, `Changes v${a} → v${b}`), h('span', { class: 'pill-soft' }, h('span', { class: 'dot tone-secondary' }), `${rows.length} change${rows.length === 1 ? '' : 's'}`)),
        rows.length ? table(['Layer', 'Change', 'Element'], rows) : h('p', { class: 'muted small flat' }, 'No differences.'),
        cmp.flags && cmp.flags.length ? [h('span', { class: 'label-mono flat' }, 'Professional review flags'), flagList({ review_flags: cmp.flags })] : null,
        h('p', { class: 'muted small flat' }, 'Changed elements are highlighted in both plans.'));
    } catch (ex) { cmpErr.show(errorText(ex)); }
  }
  fromSel.addEventListener('change', compare);
  toSel.addEventListener('change', compare);
  const redlines = h('div', { class: 'stack-sm' }, h('div', { class: 'row gap-sm wrap' }, h('label', { class: 'param' }, h('span', { class: 'label-mono flat' }, 'From'), fromSel),
    h('label', { class: 'param' }, h('span', { class: 'label-mono flat' }, 'To'), toSel)), cmpErr, panes, diffBox);

  const done = renders.renders.filter((r) => r.status === 'succeeded');
  const rOpts = done.map((r) => [r.id, `Plan v${r.plan_version_no} · ${r.view.angle}${r.view.style ? ` · ${r.view.style}` : ''} · ${fmtDate(r.created_at)}`]);
  const renderPanes = h('div', { class: 'stack-sm' });
  const rA = select(rOpts, done[1] ? done[1].id : done[0] && done[0].id);
  const rB = select(rOpts, done[0] && done[0].id);
  rA.setAttribute('aria-label', 'Concept A'); rB.setAttribute('aria-label', 'Concept B');
  const showRenders = () => renderPanes.replaceChildren(...[rA, rB].map((s) => { const r = done.find((x) => x.id === s.value); return r ? renderCard(r) : h('p', { class: 'muted' }, '—'); }));
  rA.addEventListener('change', showRenders);
  rB.addEventListener('change', showRenders);
  showRenders();
  const concepts = h('div', { class: 'stack-sm', hidden: true }, done.length ? [field('Concept A', rA), field('Concept B', rB), renderPanes]
    : h('p', { class: 'muted small' }, 'No finished renders yet — request some in the AI visualizer.'));
  const viewBtn = (label, ic, show) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(show === redlines), onclick: (e) => {
    redlines.hidden = show !== redlines; concepts.hidden = show !== concepts;
    e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget)));
  } }, icon(ic, 16), label);

  // markup log = comments
  const commentList = h('div', { class: 'stack-xs' });
  const cFilter = select([['', 'All versions'], ...vOpts], '');
  cFilter.setAttribute('aria-label', 'Show comments for');
  async function loadComments() {
    const res = await api(`${base}/comments${cFilter.value ? `?plan_version_no=${cFilter.value}` : ''}`);
    commentList.replaceChildren(...(res.comments.length ? res.comments.map((c, i) => h('div', { class: 'markup' },
      h('span', { class: 'markup-no' }, String(i + 1)),
      h('div', { class: 'min0' }, h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'strong' }, c.author_name || 'Someone'), h('span', { class: 'code-chip' }, `v${c.plan_version_no}`),
        c.element_id ? h('span', { class: 'status-tag status-info' }, `on ${c.element_id}`) : null),
      h('p', { class: 'small flat pre' }, c.body), h('span', { class: 'label-mono flat' }, fmtDate(c.created_at))))) : [h('p', { class: 'muted small flat' }, 'No comments yet.')]));
  }
  cFilter.addEventListener('change', () => loadComments().catch((ex) => toast(errorText(ex), 'error')));
  const cBody = h('textarea', { rows: 2, maxlength: 5000, required: true });
  const cVer = select(vOpts, vs[0].version_no);
  const cEl = h('input', { type: 'text', maxlength: 64, placeholder: 'optional, e.g. w1t' });
  const cErr = notice();
  const cBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Post comment');
  const cForm = h('form', { class: 'stack-sm' }, field('Comment', cBody), h('div', { class: 'row gap wrap' }, field('Plan version', cVer), field('Element id', cEl, 'Shown in the Plan tab element list.')), cBtn, cErr);
  cForm.addEventListener('submit', (e) => {
    e.preventDefault();
    cErr.clear();
    if (!cBody.value.trim()) { cErr.show('Write a comment first.'); return; }
    const body = { body: cBody.value.trim(), plan_version_no: Number(cVer.value) };
    if (cEl.value.trim()) body.element_id = cEl.value.trim();
    busy(cBtn, async () => { try { await api(`${base}/comments`, { method: 'POST', body }); cBody.value = ''; cEl.value = ''; await loadComments(); } catch (ex) { cErr.show(errorText(ex)); } });
  });

  // alternatives
  const altList = h('div', { class: 'stack-xs' });
  const drawAlts = (items) => altList.replaceChildren(...(items.length ? items.map((a) => h('div', { class: 'tl-row' },
    h('div', { class: 'min0' }, h('span', { class: 'strong' }, a.name), a.description ? h('p', { class: 'small flat' }, a.description) : null,
      h('span', { class: 'label-mono flat' }, `${a.style_key ? `Style ${a.style_key} · ` : ''}${fmtDate(a.created_at)}`)),
    h('div', { class: 'row gap-sm' }, h('a', { class: 'btn btn-small btn-soft', href: `#/p/${pid}/plan?v=${a.plan_version_no}` }, `Plan v${a.plan_version_no}`),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: async (e) => {
        if (!window.confirm(`Delete alternative “${a.name}”?`)) return;
        try { await busy(e.currentTarget, () => api(`${base}/alternatives/${a.id}`, { method: 'DELETE' })); drawAlts((await api(`${base}/alternatives`)).alternatives); } catch (ex) { toast(errorText(ex), 'error'); }
      } }, 'Delete')))) : [h('p', { class: 'muted small flat' }, 'No alternatives yet.')]));
  drawAlts(alts.alternatives);
  const aName = h('input', { type: 'text', maxlength: 100, required: true, placeholder: 'e.g. Option B — open kitchen' });
  const aDesc = h('textarea', { rows: 2, maxlength: 2000 });
  const aStyle = select([['', '—'], ...styles.styles.map((st) => [st.key, st.name])], '');
  const aVer = select(vOpts, vs[0].version_no);
  const aErr = notice();
  const aBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Create alternative');
  const aForm = h('form', { class: 'stack-sm' }, h('div', { class: 'row gap wrap' }, field('Name', aName), field('From plan version', aVer), field('Style', aStyle)), field('Description', aDesc), aBtn, aErr);
  aForm.addEventListener('submit', (e) => {
    e.preventDefault();
    aErr.clear();
    if (!aName.value.trim()) { aErr.show('Enter a name.'); return; }
    const body = { name: aName.value.trim(), plan_version_no: Number(aVer.value) };
    if (aDesc.value.trim()) body.description = aDesc.value.trim();
    if (aStyle.value) body.style_key = aStyle.value;
    busy(aBtn, async () => {
      try { await api(`${base}/alternatives`, { method: 'POST', body }); aName.value = ''; aDesc.value = ''; drawAlts((await api(`${base}/alternatives`)).alternatives); } catch (ex) { aErr.show(errorText(ex)); }
    });
  });

  const col1 = h('div', { class: 'review-col', id: 'review-compare' },
    h('section', { class: 'sheet-card' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Review view' }, viewBtn('Plan redlines', 'draw', redlines), viewBtn('Visual concepts (A/B)', 'compare', concepts)),
      redlines, concepts,
      panelHead('Markup log', 'Comments on plan versions', cFilter), commentList,
      h('details', { class: 'flat' }, h('summary', null, 'Add a comment'), cForm)),
    h('section', { class: 'sheet-card' }, panelHead('Design alternatives', 'Plan versions presented side by side'), altList,
      h('details', { class: 'flat' }, h('summary', null, 'Create an alternative'), aForm)));

  // =============== column 2: spec audit + budget check ===============
  const cur = est.currency;
  const items = est.items.filter((it) => !it.excluded);
  const specCards = items.map((it, i) => h('div', { class: 'spec-card' },
    h('div', { class: 'row between gap-sm' }, h('span', { class: 'label-mono flat secondary-text' }, `${String(i + 1).padStart(2, '0')} · ${it.category.replace('_', ' ')}`),
      h('span', { class: 'code-chip' }, it.source === 'manual' ? 'Added' : it.overridden ? 'Edited' : 'Estimated')),
    h('h4', null, it.label),
    h('div', { class: 'rate-grid' }, h('div', null, h('span', { class: 'label-mono flat' }, 'Unit rate'), h('span', { class: 'mono' }, `${money(it.unit_low, cur)}–${money(it.unit_high, cur)} / ${it.unit}`)),
      h('div', null, h('span', { class: 'label-mono flat secondary-text' }, `Total (${it.qty} ${it.unit})`), h('span', { class: 'mono secondary-text' }, `${money(it.total_low, cur)}–${money(it.total_high, cur)}`))),
    (it.rooms || []).length ? h('span', { class: 'label-mono flat' }, it.rooms.join(', ')) : null));
  const cap = briefRes.brief.budget && briefRes.brief.budget.max;
  const estMid = mid(est.totals.low, est.totals.high);
  const col2 = h('div', { class: 'review-col' },
    h('section', { class: 'sheet-card' }, panelHead('FF&E specification audit', `${items.length} item${items.length === 1 ? '' : 's'} in the estimate`, h('a', { class: 'btn btn-small btn-soft', href: `#/p/${pid}/budget` }, 'Edit')),
      specCards.length ? specCards : h('p', { class: 'muted small flat' }, 'No items yet — place furniture or choose finishes.')),
    h('section', { class: 'dark-card' },
      h('div', { class: 'row between gap-sm align-start' }, h('div', null, h('span', { class: 'label-mono flat' }, 'Budget check'), h('h2', null, 'Estimate vs client budget')),
        cap ? h('span', { class: `chip-bright ${estMid > cap ? 'over' : ''}` }, estMid > cap ? `Over budget +${Math.round(((estMid - cap) / cap) * 100)}%` : `Under budget −${Math.round(((cap - estMid) / cap) * 100)}%`) : null),
      h('div', { class: 'dark-tiles' },
        h('div', null, h('span', { class: 'label-mono flat' }, 'Client budget'), h('strong', null, cap ? money(cap, cur) : '—'), h('span', { class: 'small' }, cap ? 'Maximum from the brief' : 'Not set in the brief')),
        h('div', null, h('span', { class: 'label-mono flat' }, 'Estimate (midpoint)'), h('strong', null, money(estMid, cur)), h('span', { class: 'small bright' }, cap ? `Delta ${money(estMid - cap, cur)}` : `Range ${money(est.totals.low, cur)}–${money(est.totals.high, cur)}`))),
      cap ? h('div', { class: 'env-bar dark' }, h('div', { class: `env-fill ${estMid > cap ? 'over' : ''}`, style: { width: `${Math.min(100, (estMid / cap) * 100).toFixed(1)}%` } })) : null,
      h('p', { class: 'label-mono flat' }, 'Non-binding estimate, not retailer prices.')));

  // =============== column 3: decisions, tasks, messages ===============
  const decList = h('div', { class: 'stack-xs' });
  async function loadDecisions() {
    const res = await api(`${base}/decisions`);
    decList.replaceChildren(...(res.decisions.length ? res.decisions.map((d) => h('div', { class: 'decision' },
      h('div', { class: 'row between gap-sm' }, h('span', { class: 'strong' }, nameOf(d.decided_by) !== '—' ? nameOf(d.decided_by) : d.decided_role), h('span', { class: 'label-mono flat' }, fmtDate(d.created_at))),
      d.note ? h('p', { class: 'quote' }, `“${d.note}”`) : null,
      h('div', { class: 'row gap-sm wrap' }, h('span', { class: `status-tag ${d.decision === 'concept_approved' ? 'status-info' : 'status-warn'}` }, d.decision === 'concept_approved' ? 'Concept approved' : 'Changes requested'),
        h('span', { class: 'status-tag' }, `Plan v${d.plan_version_no} · ${d.decided_role}`)))) : [h('p', { class: 'muted small flat' }, 'No decisions yet.')]));
  }
  const dVer = select(vOpts, vs[0].version_no);
  const dNote = h('input', { type: 'text', maxlength: 2000 });
  const decide = (decision) => async (e) => {
    const body = { plan_version_no: Number(dVer.value), decision };
    if (dNote.value.trim()) body.note = dNote.value.trim();
    try { await busy(e.currentTarget, () => api(`${base}/decisions`, { method: 'POST', body })); dNote.value = ''; await loadDecisions(); } catch (ex) { toast(errorText(ex), 'error'); }
  };

  const taskList = h('div', { class: 'stack-xs' });
  const assigneeOpts = [['', 'Unassigned'], ...people.map((p) => [p.id, `${p.display_name || p.email} (${p.role})`])];
  const STATUS = { todo: ['To do', ''], doing: ['In progress', 'secondary-text'], done: ['Done', 'muted'] };
  async function loadTasks() {
    const res = await api(`${base}/tasks`);
    taskList.replaceChildren(...(res.tasks.length ? res.tasks.map((t) => {
      const st = select([['todo', 'To do'], ['doing', 'In progress'], ['done', 'Done']], t.status, { 'aria-label': `Status of ${t.title}` });
      const as = select(assigneeOpts, t.assignee_id || '', { 'aria-label': `Assignee of ${t.title}` });
      const patch = (body) => api(`${base}/tasks/${t.id}`, { method: 'PATCH', body }).then(loadTasks).catch((ex) => toast(errorText(ex), 'error'));
      st.addEventListener('change', () => patch({ status: st.value }));
      as.addEventListener('change', () => patch({ assignee_id: as.value || null }));
      const who = t.assignee_id ? people.find((p) => p.id === t.assignee_id) : null;
      return h('div', { class: `task-card task-${t.status}` },
        h('div', { class: 'row between gap-sm' }, h('span', { class: 'label-mono flat secondary-text' }, who ? `${who.role}: ${who.display_name || who.email}` : 'Unassigned'),
          h('span', { class: 'label-mono flat' }, fmtDate(t.updated_at || t.created_at))),
        h('p', { class: 'task-name' }, t.title),
        h('div', { class: 'row between gap-sm wrap' }, h('span', { class: `label-mono flat ${STATUS[t.status][1]}` }, h('span', { class: `dot ${t.status === 'doing' ? 'tone-secondary' : ''}` }), ` ${STATUS[t.status][0]}`),
          staff ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: async (e) => {
            try { await busy(e.currentTarget, () => api(`${base}/tasks/${t.id}`, { method: 'DELETE' })); loadTasks(); } catch (ex) { toast(errorText(ex), 'error'); }
          } }, 'Delete') : null),
        h('div', { class: 'row gap-sm wrap task-controls' }, st, as));
    }) : [h('p', { class: 'muted small flat' }, 'No tasks yet.')]));
  }
  const tTitle = h('input', { type: 'text', maxlength: 200, required: true });
  const tAs = select(assigneeOpts, '');
  const tBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Add task');
  const tErr = notice();
  const tForm = h('form', { class: 'stack-sm', hidden: true }, field('New task', tTitle), field('Assign to', tAs), tBtn, tErr);
  tForm.addEventListener('submit', (e) => {
    e.preventDefault();
    tErr.clear();
    if (!tTitle.value.trim()) { tErr.show('Enter a task title.'); return; }
    const body = { title: tTitle.value.trim() };
    if (tAs.value) body.assignee_id = tAs.value;
    busy(tBtn, async () => { try { await api(`${base}/tasks`, { method: 'POST', body }); tTitle.value = ''; await loadTasks(); } catch (ex) { tErr.show(errorText(ex)); } });
  });
  const addTask = h('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Add a task', title: 'Add a task', onclick: () => { tForm.hidden = !tForm.hidden; if (!tForm.hidden) tTitle.focus(); } }, icon('add', 18));

  const msgList = h('div', { class: 'msg-thread', 'aria-live': 'polite' });
  let last = null;
  async function pollMessages() {
    try {
      const res = await api(`${base}/messages${last ? `?after=${encodeURIComponent(last)}` : ''}`);
      if (!last && !res.messages.length) msgList.replaceChildren(h('p', { class: 'muted small flat empty' }, 'No messages yet.'));
      if (res.messages.length) {
        const empty = msgList.querySelector('.empty');
        if (empty) empty.remove();
        msgList.append(...res.messages.map((m) => {
          const who = m.author_name || nameOf(m.author_id);
          return h('div', { class: 'feed-row' }, h('span', { class: 'avatar' }, initials(who)),
            h('div', { class: 'min0' }, h('p', null, h('span', { class: 'strong' }, who), ' ', h('span', { class: 'label-mono flat' }, fmtDate(m.created_at))), h('p', { class: 'pre' }, m.body)));
        }));
        last = res.messages[res.messages.length - 1].created_at;
        msgList.scrollTop = msgList.scrollHeight;
      }
    } catch { /* keep polling */ }
    if (alive) timer = setTimeout(pollMessages, 5000);
  }
  const mBody = h('textarea', { rows: 1, maxlength: 5000, required: true, 'aria-label': 'Message', placeholder: 'Write to everyone on this project…' });
  const mBtn = h('button', { type: 'submit', class: 'send-btn', title: 'Send', 'aria-label': 'Send' }, icon('send', 18));
  const mErr = notice();
  const mForm = h('form', { class: 'ask-bar' }, mBody, mBtn);
  mBody.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); mForm.requestSubmit(); } });
  mForm.addEventListener('submit', (e) => {
    e.preventDefault();
    mErr.clear();
    if (!mBody.value.trim()) { mErr.show('Write a message first.'); return; }
    busy(mBtn, async () => {
      try { await api(`${base}/messages`, { method: 'POST', body: { body: mBody.value.trim() } }); mBody.value = ''; clearTimeout(timer); await pollMessages(); } catch (ex) { mErr.show(errorText(ex)); }
    });
  });

  const col3 = h('div', { class: 'review-col', id: 'review-collab' },
    h('section', { class: 'sheet-card' }, panelHead('Decision log', 'Concept decisions only — never construction approval', h('span', { class: 'dot tone-secondary' })), decList,
      h('details', { class: 'flat' }, h('summary', null, 'Record a decision'), h('div', { class: 'stack-sm' }, field('Plan version', dVer), field('Note', dNote),
        h('div', { class: 'row gap-sm wrap' }, h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: decide('concept_approved') }, 'Approve concept'),
          h('button', { type: 'button', class: 'btn btn-small btn-soft', onclick: decide('changes_requested') }, 'Request changes'))))),
    h('section', { class: 'sheet-card' }, panelHead('Action tasks', 'Open items for the studio and client', addTask), tForm, taskList),
    h('section', { class: 'sheet-card' }, panelHead('Messages', 'Thread with everyone on this project', icon('forum', 20)), msgList, mForm, mErr));

  el.append(
    h('div', { class: 'review-head' },
      h('div', { class: 'row gap wrap baseline min0' }, h('h2', { class: 'handover-title' }, 'Review & markups'), h('span', { class: 'review-sub' }, project.name)),
      h('div', { class: 'row gap-sm wrap' }, h('a', { class: 'btn btn-small btn-soft', href: `#/p/${pid}/plan` }, icon('history', 16), 'Version history'),
        h('a', { class: 'btn btn-small btn-soft', href: `#/p/${pid}/plan` }, icon('architecture', 16), 'Open in 2D plan'))),
    h('div', { class: 'boundary' }, h('span', { class: 'secondary-text' }, icon('verified_user', 18)),
      h('p', { class: 'small flat' }, h('strong', null, 'Concept review only: '), 'comments, decisions and tasks are recorded for this project. Nothing here approves construction; walls, openings, kitchens and bathrooms need a qualified professional.'),
      h('span', { class: 'label-mono flat secondary-text' }, 'Audit trail on')),
    h('div', { class: 'review-grid' }, col1, col2, col3));
  await Promise.all([compare(), loadComments(), loadDecisions(), loadTasks()]);
  pollMessages();
  const focus = { collab: col3, compare: col1 }[tab];
  if (focus && window.matchMedia('(max-width: 1279px)').matches) focus.scrollIntoView({ block: 'start' });
  return () => { alive = false; clearTimeout(timer); editors.forEach((e) => e.destroy()); };
}
