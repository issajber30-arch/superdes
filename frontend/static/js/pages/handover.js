// Stitch "Design Dossier & Budget Estimation" for the Budget and Dossier sections: brief summary with concepts,
// procurement schedule (the editable non-binding estimate, or the shopping list), budget model, collaboration brief,
// version audit and dossiers. Each route scrolls to its own part on small screens.
import { api, apiUrl, errorText } from '../api.js';
import { h, field, notice, busy, money, toast, select, fmtDate } from '../dom.js';
import { icon } from '../icons.js';
import { polygonArea, CAVEAT } from '../editor/svg-editor.js';
import { reviewBadge } from './plan.js';
import { loadCatalog } from './guest.js';

/** 3D snapshots of a plan version with its chosen finishes; null when the browser has no WebGL. */
async function threeDViews(base, versionNo) {
  const [{ captureViews, webglAvailable }, { sceneModel }] = await Promise.all([import('../editor/view3d.js'), import('../editor/scene-model.js')]);
  if (!webglAvailable()) return null;
  const [v, fin, catalog] = await Promise.all([api(`${base}/plan/versions/${versionNo}`), api(`${base}/finishes`), loadCatalog()]);
  const finishes = {};
  for (const sel of fin.selections) (finishes[sel.room_id] ||= {})[sel.surface] = sel.color;
  return captureViews(sceneModel(v.geometry, { finishes, catalog }));
}

// estimate categories -> Stitch schedule groups
const GROUPS = [
  ['finishes', '01. Finishes & surfaces', 'carpenter', (c) => c.startsWith('finish_'), 'FN'],
  ['furniture', '02. Furniture & fixtures', 'chair', (c) => !['lighting', 'textiles', 'manual'].includes(c) && !c.startsWith('finish_'), 'FF'],
  ['soft', '03. Lighting & soft furnishings', 'layers', (c) => ['lighting', 'textiles'].includes(c), 'SF'],
  ['manual', '04. Added items', 'edit_note', (c) => c === 'manual', 'MI']];
const groupOf = (it) => GROUPS.find((g) => g[3](it.category));
const mid = (lo, hi) => (lo + hi) / 2;

export async function render(el, ctx) {
  const { base, pid, project, staff, tab } = ctx;
  const [plan, briefRes, renders, versions, dossiers, prefs, styles] = await Promise.all([
    api(`${base}/plan`), api(`${base}/brief`), api(`${base}/renders`), api(`${base}/plan/versions`), api(`${base}/dossiers`),
    api(`${base}/ai/preferences`), api('/catalog/styles')]);
  const brief = briefRes.brief;
  const geo = plan.current_version.geometry;
  const rooms = geo.rooms || [];
  const area = rooms.reduce((a, r) => a + polygonArea(r.polygon), 0) / 1e6;
  const done = renders.renders.filter((r) => r.status === 'succeeded' && r.result_url);
  const styleName = (k) => (styles.styles.find((st) => st.key === k) || {}).name || k;
  const cardHead = (ic, title, chip) => h('div', { class: 'row between gap-sm' }, h('div', { class: 'row gap-sm' }, icon(ic, 20), h('h2', null, title)), chip ? h('span', { class: 'code-chip' }, chip) : null);
  const fact = (label, value, tone) => h('div', { class: 'fact' }, h('span', { class: 'label-mono flat' }, label), h('strong', { class: tone || '' }, value));

  // ---------- left: executive brief ----------
  const budgetText = brief.budget && (brief.budget.min || brief.budget.max)
    ? [brief.budget.min, brief.budget.max].filter((x) => x != null).map((x) => money(x, brief.budget.currency)).join(' – ') : 'Not set';
  const conceptTile = (r, i) => h('figure', { class: 'concept-tile' }, h('img', { src: apiUrl(r.result_url), alt: `Concept ${'AB'[i]} render`, loading: 'lazy' }),
    h('figcaption', null, h('strong', null, `Concept ${'AB'[i]}: ${styleName(r.view && r.view.style) || 'Default style'}`), h('span', { class: 'label-mono flat' }, `Plan v${r.plan_version_no} · ${(r.view && r.view.angle) || 'front'}`)));
  const execBrief = h('section', { class: 'sheet-card' }, cardHead('architecture', `${project.name} — brief`, `Plan v${plan.current_version.version_no}`),
    h('div', { class: 'fact-grid' }, fact('Client budget', budgetText), fact('Total room area', `${area.toFixed(1)} m²`),
      fact('Rooms', rooms.length ? rooms.map((r) => r.name || r.kind).join(', ') : 'None yet'),
      fact('Primary style', brief.styles.length ? styleName(brief.styles[0]) : 'Not chosen', 'secondary-text')),
    h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Concept imagery'),
      done.length ? h('div', { class: 'concept-pair' }, done.slice(0, 2).map(conceptTile)) : h('p', { class: 'muted small flat' }, 'No concept renders yet — request one in the AI visualizer.'),
      h('div', { class: 'plan-line' }, h('span', { class: 'row gap-sm' }, icon('architecture', 16), h('span', { class: 'mono small' }, `Floor plan v${plan.current_version.version_no}: `), reviewBadge(plan.current_version)),
        h('span', { class: 'label-mono flat' }, `${area.toFixed(1)} m² / 100 mm grid`))));

  // ---------- left: procurement schedule ----------
  let mode = 'estimate';
  const err = notice();
  const scheduleBody = h('div', { class: 'stack-sm' });
  const lineCount = h('span', { class: 'label-mono flat' });
  const modeBtn = (m, label) => h('button', { type: 'button', class: 'filter-btn', 'aria-pressed': String(mode === m), onclick: (e) => {
    mode = m; e.currentTarget.parentElement.querySelectorAll('.filter-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); load();
  } }, label);
  const schedule = h('section', { class: 'sheet-card', id: 'handover-budget' },
    h('div', { class: 'row between wrap gap-sm' }, h('div', null, h('h2', null, 'Procurement & FF&E schedule'), h('span', { class: 'label-mono flat' }, 'Estimate — non-binding, not retailer prices')),
      h('div', { class: 'row gap-sm' }, lineCount, h('div', { class: 'seg', role: 'group', 'aria-label': 'Budget view' }, modeBtn('estimate', 'Estimate'), modeBtn('shopping', 'Shopping list')))),
    err, scheduleBody);

  // ---------- right: budget model (redrawn with the estimate) ----------
  const model = h('section', { class: 'sheet-card', id: 'handover-model' });
  let contingency = false;
  function drawModel(est) {
    const cur = est.currency;
    const total = mid(est.totals.low, est.totals.high);
    const shown = contingency ? total * 1.1 : total;
    const cap = brief.budget && brief.budget.max;
    const sums = GROUPS.map((g) => [g, est.items.filter((it) => !it.excluded && groupOf(it) === g).reduce((a, it) => a + mid(it.total_low, it.total_high), 0)]).filter(([, v]) => v > 0);
    const sumAll = sums.reduce((a, [, v]) => a + v, 0) || 1;
    const tones = ['seg-primary', 'seg-secondary', 'seg-warm', 'seg-muted'];
    const toggle = h('input', { type: 'checkbox', class: 'switch', checked: contingency, 'aria-label': 'Show a 10% contingency' });
    toggle.addEventListener('change', () => { contingency = toggle.checked; drawModel(est); });
    model.replaceChildren(cardHead('payments', 'Budget feasibility model', 'Live from the estimate'),
      h('div', { class: 'model-hero' },
        h('div', { class: 'row between' }, h('span', { class: 'label-mono flat' }, 'Estimated total (midpoint)'), h('span', { class: 'label-mono flat secondary-text strong' }, 'Preliminary non-binding')),
        h('div', { class: 'row gap-sm wrap baseline' }, h('span', { class: 'model-total' }, money(shown, cur)), h('span', { class: 'label-mono flat' }, `range ${money(est.totals.low, cur)} – ${money(est.totals.high, cur)}`)),
        cap ? h('div', { class: 'stack-xs' },
          h('div', { class: 'row between wrap small' }, h('span', { class: 'muted' }, `Client budget: ${money(cap, cur)}`),
            h('span', { class: `mono strong ${shown <= cap ? 'secondary-text' : 'warn-text'}` }, shown <= cap ? `${money(cap - shown, cur)} under budget (${Math.round(((cap - shown) / cap) * 100)}%)` : `${money(shown - cap, cur)} over budget`)),
          h('div', { class: 'env-bar' }, h('div', { class: `env-fill ${shown > cap ? 'over' : ''}`, style: { width: `${Math.min(100, (shown / cap) * 100).toFixed(1)}%` } })))
          : h('p', { class: 'muted small flat' }, h('a', { href: `#/p/${pid}/brief` }, 'Set a budget in the brief'), ' to compare the estimate with it.')),
      h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Cost distribution'),
        sums.length ? [h('div', { class: 'dist-bar' }, sums.map(([g, v], i) => h('div', { class: tones[GROUPS.indexOf(g)] || tones[i], style: { width: `${((v / sumAll) * 100).toFixed(1)}%` }, title: `${g[1]}: ${Math.round((v / sumAll) * 100)}%` }))),
          h('div', { class: 'dist-legend' }, sums.map(([g, v]) => h('span', null, h('span', { class: `legend-dot ${tones[GROUPS.indexOf(g)]}` }), `${g[1].slice(4)} (${Math.round((v / sumAll) * 100)}%)`)))]
          : h('p', { class: 'muted small flat' }, 'No priced items yet.')),
      h('label', { class: 'contingency' }, h('span', { class: 'stack-xs' }, h('span', { class: 'strong' }, 'Show a 10% contingency'),
        h('span', { class: 'muted small' }, `Display only, not saved: a buffer for site surprises (+${money(total * 0.1, cur)})`)), toggle));
  }

  function drawEstimate(est) {
    const cur = est.currency;
    lineCount.textContent = `${est.items.filter((it) => !it.excluded).length} line items`;
    const groups = GROUPS.map((g) => [g, est.items.filter((it) => groupOf(it) === g)]).filter(([, items]) => items.length);
    const row = (it, code) => {
      const qty = h('input', { type: 'number', min: 0, step: 'any', value: it.qty, 'aria-label': `Quantity for ${it.label}`, class: 'num' });
      const lo = h('input', { type: 'number', min: 0, step: 'any', value: it.unit_low, 'aria-label': `Unit low for ${it.label}`, class: 'num' });
      const hi = h('input', { type: 'number', min: 0, step: 'any', value: it.unit_high, 'aria-label': `Unit high for ${it.label}`, class: 'num' });
      const ex = h('input', { type: 'checkbox', checked: it.excluded, 'aria-label': `Exclude ${it.label}` });
      const save = h('button', { type: 'button', class: 'btn btn-small btn-soft' }, 'Apply');
      const run = (fn) => busy(save, async () => { try { const e2 = await fn(); drawEstimate(e2); drawModel(e2); } catch (e2) { toast(errorText(e2), 'error'); } });
      save.addEventListener('click', () => {
        const body = { qty: Number(qty.value), unit_low: Number(lo.value), unit_high: Number(hi.value), excluded: ex.checked };
        if (Object.values(body).some((v) => typeof v === 'number' && (!Number.isFinite(v) || v < 0))) { toast('Enter non-negative numbers.', 'error'); return; }
        if (body.unit_low > body.unit_high) { toast('Low price must not exceed high price.', 'error'); return; }
        run(() => api(`${base}/estimates/overrides/${encodeURIComponent(it.item_key)}`, { method: 'PUT', body }));
      });
      const manual = it.source === 'manual';
      const extra = manual
        ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => run(() => api(`${base}/estimates/items/${it.id}`, { method: 'DELETE' })) }, 'Delete')
        : it.overridden ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => run(() => api(`${base}/estimates/overrides/${encodeURIComponent(it.item_key)}`, { method: 'DELETE' })) }, 'Reset') : null;
      const status = it.excluded ? ['Excluded', 'status-off'] : manual ? ['Added', 'status-info'] : it.overridden ? ['Edited', 'status-info'] : ['Estimated', ''];
      return h('tr', { class: it.excluded ? 'excluded' : '' },
        h('td', { class: 'mono secondary-text' }, code),
        h('td', null, h('span', { class: 'strong block' }, it.label), h('span', { class: 'label-mono flat' }, [it.category.replace('_', ' '), (it.rooms || []).join(', ')].filter(Boolean).join(' · '))),
        h('td', { class: 'mono' }, manual ? String(it.qty) : qty, ` ${it.unit}`),
        h('td', { class: 'mono muted' }, manual ? `${money(it.unit_low, cur)}–${money(it.unit_high, cur)}` : h('span', { class: 'rate' }, lo, '–', hi)),
        h('td', { class: 'mono strong' }, `${money(it.total_low, cur)} – ${money(it.total_high, cur)}`),
        h('td', { class: 'right' }, h('div', { class: 'row gap-sm wrap end' }, h('span', { class: `status-tag ${status[1]}` }, status[0]),
          manual ? null : h('label', { class: 'check small' }, ex, ' Exclude'), manual ? null : save, extra)));
    };
    const tables = groups.map(([g, items]) => {
      const sub = items.filter((it) => !it.excluded);
      return h('div', { class: 'stack-xs' },
        h('div', { class: 'group-head' }, h('span', { class: 'row gap-sm' }, icon(g[2], 16), h('span', null, g[1])),
          h('span', { class: 'mono strong' }, `${money(sub.reduce((a, it) => a + it.total_low, 0), cur)} – ${money(sub.reduce((a, it) => a + it.total_high, 0), cur)}`)),
        h('div', { class: 'table-wrap' }, h('table', { class: 'spec-table' },
          h('thead', null, h('tr', null, ['Code', 'Specification', 'Qty / unit', 'Rate', 'Amount', 'Status'].map((x, i) => h('th', { scope: 'col', class: i === 5 ? 'right' : '' }, x)))),
          h('tbody', null, items.map((it, i) => row(it, `${g[4]}-${String(i + 1).padStart(2, '0')}`))))));
    });
    const mLabel = h('input', { type: 'text', maxlength: 200, required: true });
    const mQty = h('input', { type: 'number', min: 0, step: 'any', value: 1, class: 'num' });
    const mUnit = h('input', { type: 'text', value: 'pcs', maxlength: 10, class: 'num' });
    const mLo = h('input', { type: 'number', min: 0, step: 'any', value: 0, class: 'num' });
    const mHi = h('input', { type: 'number', min: 0, step: 'any', value: 0, class: 'num' });
    const mBtn = h('button', { type: 'submit', class: 'btn btn-small btn-primary' }, icon('add', 16), 'Add item');
    const mForm = h('form', { class: 'row gap wrap align-end' }, field('Item', mLabel), field('Qty', mQty), field('Unit', mUnit), field('Unit low', mLo), field('Unit high', mHi), mBtn);
    mForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!mLabel.value.trim()) { toast('Enter a label.', 'error'); return; }
      const body = { label: mLabel.value.trim(), qty: Number(mQty.value), unit: mUnit.value.trim() || 'pcs', unit_low: Number(mLo.value), unit_high: Number(mHi.value) };
      if (body.unit_low > body.unit_high) { toast('Low price must not exceed high price.', 'error'); return; }
      busy(mBtn, async () => { try { const e2 = await api(`${base}/estimates/items`, { method: 'POST', body }); drawEstimate(e2); drawModel(e2); } catch (e2) { toast(errorText(e2), 'error'); } });
    });
    scheduleBody.replaceChildren(
      h('p', { class: 'muted small flat' }, `Based on plan version ${est.plan_version_no} · ${est.basis}. ${est.disclaimer || ''}`),
      ...(tables.length ? tables : [h('p', { class: 'muted' }, 'No items yet — place furniture on the plan or choose finishes in Style & materials.')]),
      h('div', { class: 'group-head total-row' }, h('span', null, `Total (${est.label})`), h('span', { class: 'mono strong' }, `${money(est.totals.low, cur)} – ${money(est.totals.high, cur)}`)),
      h('details', { class: 'flat' }, h('summary', null, 'Add a manual item'), mForm));
  }
  function drawShopping(list) {
    const cur = list.currency;
    lineCount.textContent = `${list.items.length} items`;
    scheduleBody.replaceChildren(
      h('p', { class: 'muted small flat' }, `Plan version ${list.plan_version_no} · no retailer is linked; prices are generic ranges.`),
      h('ul', { class: 'shopping' }, list.items.map((it) => h('li', null,
        h('label', { class: 'check' }, h('input', { type: 'checkbox' }), ` ${it.qty} ${it.unit} × ${it.label}`),
        h('span', { class: 'muted small' }, ` ${it.category}${it.rooms && it.rooms.length ? ` · ${it.rooms.join(', ')}` : ''} · ${money(it.total_low, cur)} – ${money(it.total_high, cur)}`)))),
      h('div', { class: 'group-head total-row' }, h('span', null, `Total (${list.label})`), h('span', { class: 'mono strong' }, `${money(list.totals.low, cur)} – ${money(list.totals.high, cur)}`)));
  }
  async function load() {
    err.clear();
    try {
      const est = await api(`${base}/estimates`);
      drawModel(est);
      if (mode === 'estimate') drawEstimate(est); else drawShopping(await api(`${base}/shopping-list`));
    } catch (ex) { err.show(errorText(ex)); }
  }

  // ---------- right: collaboration brief ----------
  const hh = brief.household || {};
  const persona = [`${hh.adults ?? 1} adult${(hh.adults ?? 1) === 1 ? '' : 's'}`, hh.children ? `${hh.children} child${hh.children === 1 ? '' : 'ren'}` : null,
    (hh.pets || []).length ? `pets: ${hh.pets.join(', ')}` : null, hh.works_from_home ? 'works from home' : null].filter(Boolean).join(' · ');
  const listBox = (items, ic, tone) => items.length ? h('div', { class: 'stack-xs' }, items.map((t) => h('div', { class: 'note-row' }, h('span', { class: tone }, icon(ic, 16)), h('span', null, t))))
    : h('p', { class: 'muted small flat' }, 'None noted.');
  const collab = h('section', { class: 'sheet-card' }, cardHead('assignment_ind', 'Designer collaboration brief'),
    h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Household & needs'),
      h('div', { class: 'soft-box' }, h('div', { class: 'row between gap-sm' }, h('span', { class: 'strong' }, persona), h('a', { class: 'link-mono', href: `#/p/${pid}/brief` }, 'Edit brief')),
        h('p', { class: 'muted small flat' }, [...(brief.functional_needs || []), ...(brief.lifestyle || [])].join(' · ') || 'No needs listed yet.'),
        hh.accessibility_needs ? h('p', { class: 'small flat' }, `Accessibility: ${hh.accessibility_needs}`) : null)),
    h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Constraints'), listBox(brief.constraints || [], 'warning', 'err-text')),
    h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Client notes for the studio'),
      brief.notes ? h('p', { class: 'soft-box small flat pre' }, brief.notes) : h('p', { class: 'muted small flat' }, 'No notes yet.')));

  // ---------- right: version audit + dossiers ----------
  const latestDossier = dossiers.dossiers[0];
  const audit = h('section', { class: 'sheet-card', id: 'handover-dossier' }, h('span', { class: 'label-mono flat' }, 'Provenance & version audit'),
    h('div', { class: 'audit-grid' },
      fact('Floor plan', `v${plan.current_version.version_no} · ${plan.current_version.review_status === 'provisional' ? 'needs review' : 'conceptual'}`),
      fact('Visualizer renders', `${done.length} concept render${done.length === 1 ? '' : 's'}`),
      fact('AI consultant', `${prefs.preferences.length} decision${prefs.preferences.length === 1 ? '' : 's'} logged`),
      fact('Dossier', '', 'secondary-text dossier-state')));
  const dossierList = h('div', { class: 'stack-xs' });
  const drawDossiers = (items) => (audit.querySelector('.dossier-state').textContent = items[0] ? `v${items[0].plan_version_no} · ${fmtDate(items[0].created_at)}` : 'Not generated yet',
    dossierList.replaceChildren(...(items.length ? items.map((d) => h('div', { class: 'tl-row' },
    h('div', { class: 'min0' }, h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'strong' }, `Dossier · plan v${d.plan_version_no}`), reviewBadge(d)),
      h('p', { class: 'muted small flat' }, `${fmtDate(d.created_at)}${d.note ? ` · ${d.note}` : ''}`)),
    h('a', { class: 'btn btn-small btn-soft', href: apiUrl(d.html_url), target: '_blank', rel: 'noopener noreferrer' }, icon('picture_as_pdf', 16), 'Open')))
    : [h('p', { class: 'muted small flat' }, staff ? 'No dossiers yet.' : 'Your designer publishes dossiers here.')])));
  drawDossiers(dossiers.dossiers);
  audit.append(h('div', { class: 'stack-xs' }, h('span', { class: 'label-mono flat' }, 'Dossiers'), dossierList,
    h('p', { class: 'muted small flat' }, 'Open a dossier and use your browser’s print dialog to save it as a PDF.')));
  let dossierForm = null;
  if (staff) {
    const ver = select(versions.versions.map((v) => [v.version_no, `v${v.version_no}${v.label ? ` — ${v.label}` : ''}`]), versions.versions[0].version_no);
    const note = h('textarea', { rows: 2, maxlength: 2000 });
    const derr = notice();
    const with3d = h('input', { type: 'checkbox', checked: true });
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('send', 16), 'Generate and submit dossier');
    dossierForm = h('form', { class: 'stack-sm' }, h('span', { class: 'label-mono flat' }, 'New dossier'),
      h('p', { class: 'muted small flat' }, 'Creates an immutable, branded snapshot: plan, brief, concepts, latest renders, non-binding estimate and review status.'),
      field('Plan version', ver), field('Note for the client', note),
      h('label', { class: 'row gap-sm' }, with3d, h('span', null, 'Include 3D views (two corners and a top view)')), btn, derr);
    dossierForm.addEventListener('submit', (e) => {
      e.preventDefault();
      derr.clear();
      const body = { plan_version_no: Number(ver.value) };
      if (note.value.trim()) body.note = note.value.trim();
      busy(btn, async () => {
        try {
          let skipped3d = false;
          if (with3d.checked) {
            try { body.views = await threeDViews(base, Number(ver.value)); } catch { skipped3d = true; }
            if (!body.views) skipped3d = true;
          }
          const d = await api(`${base}/dossiers`, { method: 'POST', body });
          if (skipped3d) toast('The dossier was made without 3D views: this browser cannot show 3D.', 'error');
          note.value = '';
          drawDossiers((await api(`${base}/dossiers`)).dossiers);
          derr.show(`Dossier for v${d.plan_version_no} created.`, 'info');
        } catch (ex) { derr.show(errorText(ex)); }
      });
    });
    audit.append(dossierForm);
  }

  // ---------- page ----------
  const openLatest = latestDossier ? h('a', { class: 'btn btn-small btn-soft', href: apiUrl(latestDossier.html_url), target: '_blank', rel: 'noopener noreferrer' }, icon('picture_as_pdf', 16), 'Open latest dossier (PDF)') : null;
  const toForm = staff ? h('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => { audit.scrollIntoView({ behavior: 'smooth', block: 'start' }); dossierForm.querySelector('textarea').focus({ preventScroll: true }); } },
    icon('send', 16), 'Generate dossier') : null;
  el.append(
    h('div', { class: 'handover-head' },
      h('div', { class: 'min0' }, h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'chip-dark' }, 'Step 4'), h('span', { class: 'label-mono flat secondary-text' }, 'Non-binding estimate')),
        h('h2', { class: 'handover-title' }, 'Design dossier & budget feasibility'),
        h('p', { class: 'muted flat' }, 'Plan, material selections and a generic furniture and finishes schedule, ready for the dossier.')),
      h('div', { class: 'row gap-sm wrap' }, openLatest, toForm)),
    h('div', { class: 'handover-grid' },
      h('div', { class: 'stack-lg' }, execBrief, schedule),
      h('div', { class: 'stack-lg' }, model, collab, audit)),
    h('div', { class: 'disclaimer-bar' }, h('span', { class: 'warm-text' }, icon('gavel', 20)),
      h('div', null, h('span', { class: 'strong' }, 'Professional boundary notice'), h('p', { class: 'muted small flat' }, `${CAVEAT} Estimates are non-binding and exclude delivery, installation and local conditions.`))));
  await load();
  const focus = { budget: schedule, dossier: audit }[tab];
  if (focus && window.matchMedia('(max-width: 1279px)').matches) focus.scrollIntoView({ block: 'start' });
}
