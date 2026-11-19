// Design tab: styles, finishes per room, furniture catalog and moodboards.
import { api, apiUrl, errorText } from '../api.js';
import { h, field, notice, busy, select, toast, money } from '../dom.js';
import { validHex } from '../state.js';

const swatch = (hex, label) => {
  const el = h('span', { class: 'swatch', title: label || hex, role: 'img', 'aria-label': label || hex });
  if (validHex(hex)) el.style.setProperty('background', hex);
  return el;
};

export async function render(el, ctx) {
  const { base } = ctx;
  const [styles, floors, wallsF, furniture, plan, sel] = await Promise.all([
    api('/catalog/styles'), api('/catalog/finishes?surface=floor'), api('/catalog/finishes?surface=wall'),
    api('/catalog/furniture'), api(`${base}/plan`), api(`${base}/finishes`)]);
  const rooms = (plan.current_version.geometry.rooms || []);
  const allFinishes = [...floors.finishes, ...wallsF.finishes];

  // --- styles ---
  const stylesSec = h('section', { class: 'card' }, h('h2', null, 'Styles'),
    h('div', { class: 'grid cards' }, styles.styles.map((st) => h('article', { class: 'style-card' },
      h('h3', null, st.name), h('div', { class: 'swatches' }, Object.entries(st.palette || {}).map(([k, v]) => swatch(v, `${k} ${v}`))),
      h('p', { class: 'small' }, st.description), h('p', { class: 'muted small' }, (st.materials || []).join(' · '))))));

  // --- finishes per room ---
  const selections = [...sel.selections];
  const finishSec = h('section', { class: 'card' }, h('h2', null, 'Finishes per room'),
    h('p', { class: 'muted small' }, `Generic finishes with indicative prices per m² (${floors.basis || 'estimate'}).`));
  if (!rooms.length) finishSec.append(h('p', { class: 'muted' }, 'Add rooms to the plan first.'));
  for (const r of rooms) {
    const row = h('div', { class: 'row gap wrap finish-row' }, h('strong', { class: 'finish-room' }, r.name || r.kind));
    for (const [surface, opts] of [['floor', floors.finishes], ['wall', wallsF.finishes]]) {
      const cur = selections.find((x) => x.room_id === r.id && x.surface === surface);
      const sw = swatch(cur ? cur.color : '', '');
      const s = select([['', '— none —'], ...opts.map((f) => [f.key, `${f.name} (${money(f.price_low_m2)}–${money(f.price_high_m2)}/m²)`])], cur ? cur.finish_key : '');
      s.addEventListener('change', async () => {
        s.disabled = true;
        try {
          const existing = selections.find((x) => x.room_id === r.id && x.surface === surface);
          if (!s.value) {
            if (existing) {
              await api(`${base}/finishes/${existing.id}`, { method: 'DELETE' });
              selections.splice(selections.indexOf(existing), 1);
            }
          } else {
            const saved = await api(`${base}/finishes`, { method: 'PUT', body: { room_id: r.id, surface, finish_key: s.value } });
            const f = allFinishes.find((x) => x.key === s.value);
            if (existing) selections.splice(selections.indexOf(existing), 1);
            selections.push({ ...saved, color: f && f.color });
          }
          const now = selections.find((x) => x.room_id === r.id && x.surface === surface);
          sw.style.removeProperty('background');
          if (now && validHex(now.color)) sw.style.setProperty('background', now.color);
          toast('Finish updated');
        } catch (ex) { toast(errorText(ex), 'error'); } finally { s.disabled = false; }
      });
      row.append(field(`${surface === 'floor' ? 'Floor' : 'Walls'} — ${r.name || r.kind}`, s), sw);
    }
    finishSec.append(row);
  }

  // --- furniture catalog ---
  const cats = [...new Set(furniture.items.map((i) => i.category))];
  const catSel = select([['', 'All categories'], ...cats.map((c) => [c, c])], '');
  const grid = h('div', { class: 'catalog-grid' });
  const boardTarget = select([], '');
  const drawCatalog = () => grid.replaceChildren(...furniture.items.filter((i) => !catSel.value || i.category === catSel.value).map((i) => h('article', { class: 'catalog-card' },
    h('h3', null, i.name), h('p', { class: 'small muted' }, `${i.width_mm}×${i.depth_mm}×${i.height_mm} mm · ${i.category}`),
    h('p', { class: 'small' }, `${money(i.price_low)}–${money(i.price_high)} (estimate)`),
    h('button', { type: 'button', class: 'btn btn-small', onclick: (e) => addItem(e.currentTarget, { kind: 'catalog', ref: i.key }) }, 'Add to moodboard'))));
  catSel.addEventListener('change', drawCatalog);
  drawCatalog();
  const catalogSec = h('section', { class: 'card' }, h('h2', null, 'Furniture catalog'),
    h('p', { class: 'muted small' }, 'Generic items with typical sizes. Place them on the plan from the Plan tab. Prices are non-binding estimates, not retailer prices.'),
    h('div', { class: 'row gap wrap' }, field('Category', catSel), field('Add to moodboard', boardTarget)), grid);

  // --- moodboards ---
  const boardsBox = h('div');
  const boardView = h('div');
  let boards = [];
  async function loadBoards(openId) {
    boards = (await api(`${base}/moodboards`)).moodboards;
    boardTarget.replaceChildren(...(boards.length ? boards.map((b) => h('option', { value: b.id }, b.name)) : [h('option', { value: '' }, 'Create a moodboard first')]));
    boardsBox.replaceChildren(boards.length ? h('ul', { class: 'pill-list' }, boards.map((b) => h('li', null,
      h('button', { type: 'button', class: 'btn btn-small', onclick: () => openBoard(b.id) }, b.name)))) : h('p', { class: 'muted' }, 'No moodboards yet.'));
    if (openId) await openBoard(openId);
  }
  async function addItem(btn, item) {
    const mid = boardTarget.value;
    if (!mid) { toast('Create a moodboard first.', 'error'); return; }
    try { await busy(btn, () => api(`${base}/moodboards/${mid}/items`, { method: 'POST', body: item })); toast('Added to moodboard'); if (boardView.dataset.id === mid) openBoard(mid); } catch (ex) { toast(errorText(ex), 'error'); }
  }
  async function openBoard(mid) {
    const b = await api(`${base}/moodboards/${mid}`);
    boardView.dataset.id = mid;
    boardTarget.value = mid;
    const items = h('div', { class: 'mood-items' }, b.items.length ? b.items.map((it) => {
      let body;
      if (it.kind === 'upload' && it.image_url) body = h('img', { src: apiUrl(it.image_url), alt: it.note || 'Moodboard image' });
      else if (it.kind === 'color') body = h('div', null, swatch(it.ref, it.ref), ` ${it.ref}`);
      else if (it.kind === 'finish') body = h('div', null, swatch(it.finish_color, it.finish_name), ` ${it.finish_name || it.ref}`);
      else if (it.kind === 'catalog') body = h('div', null, it.catalog_name || it.ref);
      else body = h('div', null, it.note);
      return h('figure', { class: 'mood-item' }, body, it.kind !== 'note' && it.note ? h('figcaption', null, it.note) : null,
        h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'aria-label': 'Remove item', onclick: async (e) => {
          try { await busy(e.currentTarget, () => api(`${base}/moodboards/${mid}/items/${it.id}`, { method: 'DELETE' })); openBoard(mid); } catch (ex) { toast(errorText(ex), 'error'); }
        } }, 'Remove'));
    }) : h('p', { class: 'muted' }, 'Empty — add colours, notes, finishes, images or catalog items.'));
    const color = h('input', { type: 'color', value: '#c8b8a6' });
    const note = h('input', { type: 'text', maxlength: 1000 });
    const finish = select(allFinishes.map((f) => [f.key, `${f.name} (${f.surface})`]), '');
    const uploads = (await api(`${base}/uploads`)).uploads;
    const upSel = select(uploads.map((u) => [u.id, u.filename || u.id.slice(0, 8)]), '');
    const add = (item) => (e) => addItem(e.currentTarget, item());
    boardView.replaceChildren(h('div', { class: 'card' },
      h('div', { class: 'row gap wrap spread' }, h('h3', null, b.name),
        h('button', { type: 'button', class: 'btn btn-small btn-danger', onclick: async () => {
          if (!window.confirm(`Delete moodboard “${b.name}”?`)) return;
          try { await api(`${base}/moodboards/${mid}`, { method: 'DELETE' }); boardView.replaceChildren(); delete boardView.dataset.id; loadBoards(); } catch (ex) { toast(errorText(ex), 'error'); }
        } }, 'Delete moodboard')),
      items,
      h('div', { class: 'row gap wrap align-end' },
        field('Colour', color), h('button', { type: 'button', class: 'btn btn-small', onclick: add(() => ({ kind: 'color', ref: color.value })) }, 'Add colour'),
        field('Note', note), h('button', { type: 'button', class: 'btn btn-small', onclick: add(() => ({ kind: 'note', ref: '', note: note.value.trim() || 'Note' })) }, 'Add note'),
        field('Finish', finish), h('button', { type: 'button', class: 'btn btn-small', onclick: add(() => ({ kind: 'finish', ref: finish.value })) }, 'Add finish'),
        uploads.length ? [field('Uploaded image', upSel), h('button', { type: 'button', class: 'btn btn-small', onclick: add(() => ({ kind: 'upload', ref: upSel.value })) }, 'Add image')]
          : h('p', { class: 'muted small' }, 'Upload inspiration images in the Brief tab to add them here.'))));
  }
  const newName = h('input', { type: 'text', maxlength: 100, placeholder: 'e.g. Living room — warm minimal' });
  const err = notice();
  const createBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, 'Create moodboard');
  const createForm = h('form', { class: 'row gap wrap align-end' }, field('New moodboard name', newName), createBtn, err);
  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    if (!newName.value.trim()) { err.show('Enter a name.'); return; }
    busy(createBtn, async () => {
      try { const m = await api(`${base}/moodboards`, { method: 'POST', body: { name: newName.value.trim() } }); newName.value = ''; await loadBoards(m.id); } catch (ex) { err.show(errorText(ex)); }
    });
  });
  const moodSec = h('section', { class: 'card' }, h('h2', null, 'Moodboards'), createForm, boardsBox, boardView);
  await loadBoards();
  el.append(stylesSec, finishSec, moodSec, catalogSec);
}
