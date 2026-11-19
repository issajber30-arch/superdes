// Compare: plan versions side by side with diff, renders side by side, design alternatives.
import { api, errorText } from '../api.js';
import { h, field, notice, busy, select, fmtDate, toast } from '../dom.js';
import { PlanEditor } from '../editor/svg-editor.js';
import { renderCard } from './renders.js';
import { flagList } from './plan.js';
import { table } from './dashboard.js';

export async function render(el, ctx) {
  const { base, pid } = ctx;
  const [versions, renders, alts, styles] = await Promise.all([api(`${base}/plan/versions`), api(`${base}/renders`), api(`${base}/alternatives`), api('/catalog/styles')]);
  const vs = versions.versions;
  const editors = [];
  const vOpts = vs.map((v) => [v.version_no, `v${v.version_no}${v.label ? ` — ${v.label}` : ''}`]);
  const fromSel = select(vOpts, vs.length > 1 ? vs[1].version_no : vs[0].version_no);
  const toSel = select(vOpts, vs[0].version_no);
  const panes = h('div', { class: 'compare-panes' });
  const diffBox = h('div');
  const err = notice();

  async function compare() {
    err.clear();
    editors.splice(0).forEach((e) => e.destroy());
    const a = Number(fromSel.value); const b = Number(toSel.value);
    try {
      const [va, vb, cmp] = await Promise.all([api(`${base}/plan/versions/${a}`), api(`${base}/plan/versions/${b}`), api(`${base}/plan/compare?from=${a}&to=${b}`)]);
      const changed = new Set(Object.values(cmp.diff).flatMap((d) => [...d.added, ...d.removed, ...d.changed]));
      panes.replaceChildren();
      for (const v of [va, vb]) {
        const host = h('div', { class: 'compare-pane' }, h('h3', null, `Version ${v.version_no}${v.label ? ` — ${v.label}` : ''}`));
        panes.append(host);
        editors.push(new PlanEditor(host, { geometry: v.geometry, readOnly: true, panel: false, highlight: changed }));
      }
      const rows = [];
      for (const [layer, d] of Object.entries(cmp.diff)) for (const kind of ['added', 'removed', 'changed']) for (const id of d[kind]) rows.push([layer, kind, id]);
      diffBox.replaceChildren(h('h3', null, `Changes from v${a} to v${b}`),
        rows.length ? table(['Layer', 'Change', 'Element'], rows) : h('p', { class: 'muted' }, 'No differences.'),
        cmp.flags && cmp.flags.length ? [h('h4', null, 'Professional review flags'), flagList({ review_flags: cmp.flags })] : null,
        h('p', { class: 'muted small' }, 'Changed elements are highlighted in both plans.'));
    } catch (ex) { err.show(errorText(ex)); }
  }
  fromSel.addEventListener('change', compare);
  toSel.addEventListener('change', compare);

  // renders side by side
  const done = renders.renders.filter((r) => r.status === 'succeeded');
  const rOpts = done.map((r) => [r.id, `Plan v${r.plan_version_no} · ${r.view.angle}${r.view.style ? ` · ${r.view.style}` : ''} · ${fmtDate(r.created_at)}`]);
  const renderPanes = h('div', { class: 'compare-panes' });
  const rA = select(rOpts, done[1] ? done[1].id : done[0] && done[0].id);
  const rB = select(rOpts, done[0] && done[0].id);
  const showRenders = () => renderPanes.replaceChildren(...[rA, rB].map((s) => { const r = done.find((x) => x.id === s.value); return r ? renderCard(r) : h('p', { class: 'muted' }, '—'); }));
  rA.addEventListener('change', showRenders);
  rB.addEventListener('change', showRenders);
  showRenders();

  // alternatives
  const altList = h('div');
  const drawAlts = (items) => altList.replaceChildren(items.length ? h('ul', { class: 'alt-list' }, items.map((a) => h('li', { class: 'card' },
    h('div', { class: 'row gap wrap spread' }, h('strong', null, a.name),
      h('div', { class: 'row gap' }, h('a', { class: 'btn btn-small', href: `#/p/${pid}/plan?v=${a.plan_version_no}` }, `Open plan v${a.plan_version_no}`),
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: async (e) => {
          if (!window.confirm(`Delete alternative “${a.name}”?`)) return;
          try { await busy(e.currentTarget, () => api(`${base}/alternatives/${a.id}`, { method: 'DELETE' })); drawAlts((await api(`${base}/alternatives`)).alternatives); } catch (ex) { toast(errorText(ex), 'error'); }
        } }, 'Delete'))),
    a.description ? h('p', { class: 'small' }, a.description) : null,
    h('p', { class: 'muted small' }, `${a.style_key ? `Style ${a.style_key} · ` : ''}${fmtDate(a.created_at)}`)))) : h('p', { class: 'muted' }, 'No alternatives yet.'));
  drawAlts(alts.alternatives);
  const aName = h('input', { type: 'text', maxlength: 100, required: true, placeholder: 'e.g. Option B — open kitchen' });
  const aDesc = h('textarea', { rows: 2, maxlength: 2000 });
  const aStyle = select([['', '—'], ...styles.styles.map((st) => [st.key, st.name])], '');
  const aVer = select(vOpts, vs[0].version_no);
  const aErr = notice();
  const aBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Create alternative');
  const aForm = h('form', { class: 'form' }, h('div', { class: 'row gap wrap' }, field('Name', aName), field('From plan version', aVer), field('Style', aStyle)), field('Description', aDesc), aBtn, aErr);
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

  el.append(
    h('section', { class: 'card' }, h('h2', null, 'Plan versions'), h('div', { class: 'row gap wrap' }, field('From', fromSel), field('To', toSel)), err, panes, diffBox),
    h('section', { class: 'card' }, h('h2', null, 'Renders'), done.length ? [h('div', { class: 'row gap wrap' }, field('Left', rA), field('Right', rB)), renderPanes] : h('p', { class: 'muted' }, 'No finished renders yet — request some in the Renders tab.')),
    h('section', { class: 'card' }, h('h2', null, 'Design alternatives'), h('p', { class: 'muted small' }, 'Name a plan version as an alternative concept to present side by side.'), aForm, altList));
  await compare();
  return () => editors.forEach((e) => e.destroy());
}
