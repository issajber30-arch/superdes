// AI visualizer (Stitch studio, centre column): viewport + render controls, the two latest concepts side by side,
// job status line, plan stats and the full render history. Renders stay pinned to the plan version they came from.
import { api, apiUrl, errorText, newKey } from '../api.js';
import { h, field, notice, busy, select, badge, fmtDate } from '../dom.js';
import { icon } from '../icons.js';
import { polygonArea } from '../editor/svg-editor.js';

export const ANGLES = ['front', 'back', 'left', 'right', 'corner-ne', 'corner-nw', 'corner-se', 'corner-sw'];

export function renderCard(r) {
  return h('figure', { class: 'render-card' },
    r.status === 'succeeded' && r.result_url ? h('img', { src: apiUrl(r.result_url), alt: `Concept render of plan version ${r.plan_version_no}`, loading: 'lazy' })
      : h('div', { class: 'render-placeholder' }, r.status === 'failed' ? 'Render failed' : 'Rendering…'),
    h('figcaption', null,
      h('div', { class: 'row gap wrap' }, badge(`Plan v${r.plan_version_no}`), badge(r.status, r.status === 'failed' ? 'warn' : r.status === 'succeeded' ? 'ok' : '')),
      h('div', { class: 'small' }, [r.view && r.view.angle, r.view && r.view.style].filter(Boolean).join(' · ')),
      h('div', { class: 'muted small' }, `${r.label || 'Conceptual visualization'} · ${fmtDate(r.created_at)}`),
      r.error ? h('div', { class: 'small notice-error' }, `${r.error} (credit refunded)`) : null));
}

/** Centre column. data: {versions, styles, plan, sel} */
export async function renderVisualizer(el, ctx, data) {
  const { base } = ctx;
  const { versions, styles, plan } = data;
  let timer = null;
  let alive = true;
  const err = notice();
  const styleName = (k) => (styles.styles.find((st) => st.key === k) || {}).name || k || 'Default style';
  const versionSel = select(versions.versions.map((v) => [v.version_no, `Plan v${v.version_no}${v.label ? ` — ${v.label}` : ''}`]), plan.current_version.version_no);
  const roomSel = select([], '');
  const angleSel = select(ANGLES.map((a) => [a, a]), 'front');
  const styleSel = select([['', 'From brief / default'], ...styles.styles.map((st) => [st.key, st.name])], '');
  const geoCache = new Map([[plan.current_version.version_no, plan.current_version.geometry]]);
  const stats = h('div', { class: 'stat-grid' });
  let roomCount = 0;
  let latest = [];
  async function loadRooms() {
    const n = Number(versionSel.value);
    if (!geoCache.has(n)) geoCache.set(n, (await api(`${base}/plan/versions/${n}`)).geometry);
    const rooms = geoCache.get(n).rooms || [];
    roomCount = rooms.length;
    roomSel.replaceChildren(h('option', { value: '' }, 'Whole plan'), ...rooms.map((r) => h('option', { value: r.id }, `${r.name || r.kind} · ${(polygonArea(r.polygon) / 1e6).toFixed(1)} m²`)));
    drawStats();
  }
  function drawStats() {
    const rooms = geoCache.get(Number(versionSel.value)).rooms || [];
    const area = rooms.reduce((a, r) => a + polygonArea(r.polygon), 0) / 1e6;
    const specified = data.sel.selections.length;
    const tile = (label, value, note, tone) => h('div', { class: 'stat' }, h('span', { class: 'label-mono flat' }, label), h('p', null, value), h('span', { class: `label-mono flat ${tone || ''}` }, note));
    stats.replaceChildren(
      tile('Plan room area', `${area.toFixed(1)} m²`, `${rooms.length} room${rooms.length === 1 ? '' : 's'} · plan v${versionSel.value}`),
      tile('Material finishes', `${specified} item${specified === 1 ? '' : 's'}`, roomCount ? `${Math.round((specified / (roomCount * 2)) * 100)}% specified` : 'No rooms yet', 'secondary-text'),
      tile('Concept renders', String(latest.filter((r) => r.status === 'succeeded').length), 'Pinned to plan versions'),
      tile('Visual fidelity', 'Conceptual', 'Not a construction drawing'));
  }
  versionSel.addEventListener('change', () => loadRooms().catch((ex) => err.show(errorText(ex))));
  document.addEventListener('finishes-changed', drawStats);

  // --- concept stage: the two latest successful renders ---
  let mode = 'side';
  const stage = h('div', { class: 'concept-stage' });
  const statusLine = h('div', { class: 'job-line' });
  const history = h('div', { class: 'gallery' });
  const modeBtn = (k, ic, label) => h('button', { type: 'button', class: 'seg-btn', 'aria-pressed': String(k === mode), onclick: (e) => {
    mode = k; e.currentTarget.parentElement.querySelectorAll('.seg-btn').forEach((b) => b.setAttribute('aria-pressed', String(b === e.currentTarget))); drawStage();
  } }, icon(ic, 16), label);
  const concept = (r, i) => h('div', { class: `concept ${i ? 'alt' : ''}` },
    h('div', { class: 'concept-badge' }, h('span', { class: `dot ${i ? 'tone-warm' : 'tone-secondary'}` }),
      h('span', { class: 'strong' }, `Concept ${'AB'[i]}: ${styleName(r.view && r.view.style)}`), h('span', { class: 'label-mono flat' }, `(Plan v${r.plan_version_no})`)),
    h('div', { class: 'concept-img' }, h('img', { src: apiUrl(r.result_url), alt: `Concept ${'AB'[i]} render of plan version ${r.plan_version_no}` })),
    h('div', { class: 'concept-foot' },
      h('span', { class: 'label-mono flat' }, [r.view && r.view.angle, fmtDate(r.created_at)].filter(Boolean).join(' • ')),
      h('a', { class: `btn btn-small ${i ? 'btn-soft' : 'btn-primary'}`, href: apiUrl(r.result_url), target: '_blank', rel: 'noopener' }, i ? 'Open image' : 'Open full size')));
  function drawStage() {
    const done = latest.filter((r) => r.status === 'succeeded' && r.result_url).slice(0, mode === 'side' ? 2 : 1);
    stage.classList.toggle('single', mode !== 'side' || done.length < 2);
    stage.replaceChildren(...(done.length ? done.map(concept) : [h('div', { class: 'concept empty' }, icon('photo_camera', 32), h('p', null, 'No concept renders yet. Request one below.'))]));
  }

  async function refresh() {
    const res = await api(`${base}/renders`);
    latest = res.renders;
    drawStage();
    drawStats();
    const job = latest[0];
    statusLine.replaceChildren(...(job ? [h('span', { class: `job-icon ${job.status === 'failed' ? 'warn-text' : 'secondary-text'}` }, icon(job.status === 'failed' ? 'info' : 'check_circle', 14)),
      h('span', { class: 'label-mono flat' }, `Latest render job • plan v${job.plan_version_no} • ${job.status}${job.status === 'failed' ? ' — credit refunded' : ''} • ${fmtDate(job.created_at)}`)]
      : [h('span', { class: 'label-mono flat' }, 'No render jobs yet • each render uses 1 studio credit')]));
    history.replaceChildren(...(latest.length ? latest.map(renderCard) : [h('p', { class: 'muted' }, 'No renders yet.')]));
    clearTimeout(timer);
    if (alive && latest.some((r) => r.status === 'queued' || r.status === 'running')) timer = setTimeout(() => refresh().catch(() => {}), 2000);
  }

  let pendingKey = null; // reused if the same request is retried after a network error
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('wand_stars', 18), 'Render from 2D plan (1 credit)');
  const pill = (label, control) => { const l = h('label', { class: 'param' }, h('span', { class: 'label-mono flat' }, label), control); return l; };
  const form = h('form', { class: 'render-bar' },
    h('div', { class: 'render-controls' }, pill('Plan', versionSel), pill('Angle', angleSel), pill('Style', styleSel), btn),
    statusLine, err);
  [versionSel, roomSel, angleSel, styleSel].forEach((x) => x.addEventListener('change', () => { pendingKey = null; }));
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    pendingKey = pendingKey || newKey();
    const view = { angle: angleSel.value };
    if (roomSel.value) view.room_id = roomSel.value;
    if (styleSel.value) view.style = styleSel.value;
    busy(btn, async () => {
      try {
        const job = await api(`${base}/renders`, { method: 'POST', body: { view, plan_version_no: Number(versionSel.value), idempotency_key: pendingKey } });
        pendingKey = null;
        if (job.replayed) err.show('This request was already submitted; showing the existing render.', 'info');
        await refresh();
      } catch (ex) {
        if (ex.code === 'insufficient_credits') {
          pendingKey = null;
          err.show('Your studio has no render credits left. Credits come with the studio subscription — the studio owner can check the balance on the dashboard.', 'warn');
        } else {
          if (ex.status && ex.status !== 0) pendingKey = null; // only network failures are retried with the same key
          err.show(errorText(ex));
        }
      }
    });
  });

  roomSel.classList.add('viewport-select');
  roomSel.setAttribute('aria-label', 'Room to render');
  el.append(
    h('div', { class: 'viewport-bar' },
      h('div', { class: 'row gap-sm min0' }, icon('photo_camera', 18), h('div', { class: 'min0' }, h('span', { class: 'label-mono flat' }, 'Active viewport'), roomSel)),
      h('div', { class: 'row gap-sm wrap' }, h('span', { class: 'pill-plain' }, 'Conceptual visualization'),
        h('span', { class: 'pill-soft' }, h('span', { class: 'dot tone-secondary' }), 'Pinned to plan version'))),
    h('div', { class: 'row between wrap gap-sm' },
      h('div', { class: 'seg', role: 'group', 'aria-label': 'Concept view' }, modeBtn('side', 'view_column', 'Side-by-side'), modeBtn('single', 'fit_screen', 'Single concept')),
      h('span', { class: 'label-mono flat' }, 'Latest two concepts')),
    stage, form, stats,
    h('details', { class: 'history' }, h('summary', null, 'Render history'),
      h('p', { class: 'muted small' }, 'Renders are conceptual visualizations, pinned to the plan version they were made from. Older renders remain available after the plan changes.'), history));
  await loadRooms();
  await refresh();
  return () => { alive = false; clearTimeout(timer); document.removeEventListener('finishes-changed', drawStats); };
}
