// Renders: request concept visualizations pinned to a plan version, poll status, gallery.
import { api, apiUrl, errorText, newKey } from '../api.js';
import { h, field, notice, busy, select, badge, fmtDate } from '../dom.js';

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

export async function render(el, ctx) {
  const { base } = ctx;
  const [versions, styles, plan] = await Promise.all([api(`${base}/plan/versions`), api('/catalog/styles'), api(`${base}/plan`)]);
  let timer = null;
  let alive = true;
  const err = notice();
  const gallery = h('div', { class: 'gallery' });
  const versionSel = select(versions.versions.map((v) => [v.version_no, `v${v.version_no}${v.label ? ` — ${v.label}` : ''}`]), plan.current_version.version_no);
  const roomSel = select([], '');
  const angleSel = select(ANGLES.map((a) => [a, a]), 'front');
  const styleSel = select([['', 'From brief / default'], ...styles.styles.map((st) => [st.key, st.name])], '');
  const geoCache = new Map([[plan.current_version.version_no, plan.current_version.geometry]]);
  async function loadRooms() {
    const n = Number(versionSel.value);
    if (!geoCache.has(n)) geoCache.set(n, (await api(`${base}/plan/versions/${n}`)).geometry);
    const rooms = geoCache.get(n).rooms || [];
    roomSel.replaceChildren(h('option', { value: '' }, 'Whole plan'), ...rooms.map((r) => h('option', { value: r.id }, r.name || r.kind)));
  }
  versionSel.addEventListener('change', () => loadRooms().catch((ex) => err.show(errorText(ex))));
  await loadRooms();

  async function refresh() {
    const res = await api(`${base}/renders`);
    gallery.replaceChildren(...(res.renders.length ? res.renders.map(renderCard) : [h('p', { class: 'muted' }, 'No renders yet.')]));
    clearTimeout(timer);
    if (alive && res.renders.some((r) => r.status === 'queued' || r.status === 'running')) timer = setTimeout(() => refresh().catch(() => {}), 2000);
  }

  let pendingKey = null; // reused if the same request is retried after a network error
  const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Request render (1 credit)');
  const form = h('form', { class: 'card form' },
    h('h2', null, 'New concept render'),
    h('div', { class: 'row gap wrap' }, field('Plan version', versionSel), field('Room', roomSel), field('View angle', angleSel), field('Style', styleSel)),
    btn, err);
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

  el.append(form,
    h('p', { class: 'muted small' }, 'Renders are conceptual visualizations, pinned to the plan version they were made from. Older renders remain available after the plan changes.'),
    gallery);
  await refresh();
  return () => { alive = false; clearTimeout(timer); };
}
