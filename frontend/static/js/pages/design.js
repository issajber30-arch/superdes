// Style & materials (Stitch studio, left column): style direction from the brief, finishes schedule per room,
// inspiration pins; full-width moodboards and furniture catalog below the studio.
import { api, apiUrl, errorText } from '../api.js';
import { h, field, notice, busy, select, toast, money } from '../dom.js';
import { icon } from '../icons.js';
import { validHex } from '../state.js';

const swatch = (hex, label) => {
  const el = h('span', { class: 'swatch', title: label || hex, role: 'img', 'aria-label': label || hex });
  if (validHex(hex)) el.style.setProperty('background', hex);
  return el;
};
const sectionHead = (label, right) => h('div', { class: 'row between' }, h('span', { class: 'label-mono flat' }, label), right || null);

/** Left column. data: {styles, floors, walls, plan, sel, brief, uploads} */
export function renderPalette(el, ctx, data) {
  const { base, pid } = ctx;
  const rooms = data.plan.current_version.geometry.rooms || [];
  const allFinishes = [...data.floors.finishes, ...data.walls.finishes];
  const selections = data.sel.selections; // shared with the visualizer's finish count
  const changed = () => el.dispatchEvent(new CustomEvent('finishes-changed', { bubbles: true }));
  const chosen = new Set(data.brief.styles);
  const count = h('span', { class: 'chip-soft' });
  const setCount = () => { count.textContent = `${selections.length} specified`; };
  setCount();

  // --- style direction (the brief's styles are the active ones) ---
  const styleCards = data.styles.styles.map((st) => h('div', { class: `style-dna ${chosen.has(st.key) ? 'on' : ''}` },
    h('div', { class: 'row between' }, h('span', { class: 'strong' }, st.name),
      chosen.has(st.key) ? h('span', { class: 'secondary-soft', 'aria-label': 'In the brief' }, icon('check_circle', 16)) : h('span', { class: 'label-mono flat' }, 'Alt')),
    h('span', { class: 'label-mono flat' }, (st.materials || []).slice(0, 3).join(' • '))));
  const tags = [...data.brief.colors, ...data.brief.materials].slice(0, 12);

  // --- finishes schedule: one row per room and surface ---
  const schedule = h('div', { class: 'spec-list' });
  if (!rooms.length) schedule.append(h('p', { class: 'muted small' }, 'Add rooms to the plan first.'));
  rooms.forEach((r, ri) => {
    for (const [surface, opts, ic, code] of [['floor', data.floors.finishes, 'grid_view', 'FL'], ['wall', data.walls.finishes, 'view_week', 'WL']]) {
      const find = () => selections.find((x) => x.room_id === r.id && x.surface === surface);
      const box = h('div', { class: 'spec-icon', 'aria-hidden': 'true' }, icon(ic, 24));
      const name = h('h4', null);
      const price = h('span', { class: 'strong small' });
      const paint = () => {
        const cur = find();
        const f = cur && allFinishes.find((x) => x.key === cur.finish_key);
        name.textContent = f ? f.name : `No ${surface} finish`;
        price.textContent = f ? `${money(f.price_low_m2)}–${money(f.price_high_m2)} / m²` : '';
        box.style.removeProperty('background');
        box.classList.toggle('filled', !!(f && validHex(f.color)));
        if (f && validHex(f.color)) box.style.setProperty('background', f.color);
      };
      const s = select([['', '— none —'], ...opts.map((f) => [f.key, f.name])], find() ? find().finish_key : '');
      s.setAttribute('aria-label', `${surface === 'floor' ? 'Floor' : 'Wall'} finish — ${r.name || r.kind}`);
      s.addEventListener('change', async () => {
        s.disabled = true;
        try {
          const existing = find();
          if (!s.value) {
            if (existing) { await api(`${base}/finishes/${existing.id}`, { method: 'DELETE' }); selections.splice(selections.indexOf(existing), 1); }
          } else {
            const saved = await api(`${base}/finishes`, { method: 'PUT', body: { room_id: r.id, surface, finish_key: s.value } });
            if (existing) selections.splice(selections.indexOf(existing), 1);
            selections.push(saved);
          }
          paint(); setCount(); changed();
          toast('Finish updated');
        } catch (ex) { toast(errorText(ex), 'error'); } finally { s.disabled = false; }
      });
      paint();
      schedule.append(h('div', { class: 'spec-row' }, box,
        h('div', { class: 'min0 grow' },
          h('div', { class: 'row between gap-sm' }, name, h('span', { class: 'code-chip' }, `${code}-${String(ri + 1).padStart(2, '0')}`)),
          h('p', { class: 'muted small' }, `${r.name || r.kind} · ${surface === 'floor' ? 'Floor' : 'Walls'}`),
          h('div', { class: 'row between gap-sm spec-foot' }, s, price))));
    }
  });

  // --- inspiration pins: the project's uploaded images ---
  const pins = data.uploads.uploads.filter((u) => u.kind === 'image').slice(0, 6); // not renders or logos
  el.append(
    h('div', { class: 'row between' },
      h('div', null, h('span', { class: 'label-mono flat' }, 'Style & materials'), h('h2', { class: 'col-title' }, 'Material palette')), count),
    h('div', { class: 'stack-xs' },
      sectionHead('Style direction', h('a', { class: 'link-mono', href: `#/p/${pid}/brief` }, 'Customize')),
      h('div', { class: 'style-dna-grid' }, styleCards),
      tags.length ? h('div', { class: 'tag-row' }, tags.map((t) => h('span', { class: 'tag' }, `#${t.replace(/\s+/g, '')}`))) : null),
    h('div', { class: 'stack-sm' }, sectionHead('Specified finishes schedule', h('span', { class: 'label-mono flat' }, 'Floor / Wall')),
      h('p', { class: 'muted small flat' }, `Generic finishes with indicative prices (${data.floors.basis || 'estimate'}).`), schedule),
    h('div', { class: 'stack-xs pins' },
      sectionHead('Inspiration reference pins', h('a', { class: 'link-mono', href: `#/p/${pid}/brief` }, icon('add', 14), 'Add pin')),
      pins.length ? h('div', { class: 'pin-grid' }, pins.map((u) => h('figure', { class: 'pin' },
        h('img', { src: apiUrl(u.url), alt: u.filename || 'Inspiration image', loading: 'lazy' }), h('figcaption', null, u.filename || 'Image'))))
        : h('p', { class: 'muted small flat' }, 'Upload inspiration images in the Brief.')));
}

/** Full-width moodboards + furniture catalog under the studio. data: {floors, walls, furniture, uploads} */
export async function renderBoards(el, ctx, data) {
  const { base } = ctx;
  const allFinishes = [...data.floors.finishes, ...data.walls.finishes];
  const furniture = data.furniture;

  // --- furniture catalog ---
  const cats = [...new Set(furniture.items.map((i) => i.category))];
  const catSel = select([['', 'All categories'], ...cats.map((c) => [c, c])], '');
  const grid = h('div', { class: 'catalog-grid' });
  const boardTarget = select([], '');
  const drawCatalog = () => grid.replaceChildren(...furniture.items.filter((i) => !catSel.value || i.category === catSel.value).map((i) => h('article', { class: 'catalog-card' },
    h('h3', null, i.name), h('p', { class: 'small muted' }, `${i.width_mm}×${i.depth_mm}×${i.height_mm} mm · ${i.category}`),
    h('p', { class: 'small' }, `${money(i.price_low)}–${money(i.price_high)} (estimate)`),
    h('button', { type: 'button', class: 'btn btn-small btn-soft', onclick: (e) => addItem(e.currentTarget, { kind: 'catalog', ref: i.key }) }, icon('add', 16), 'Add to moodboard'))));
  catSel.addEventListener('change', drawCatalog);
  drawCatalog();
  const catalogSec = h('section', { class: 'dash-panel' }, h('div', { class: 'dash-panel-head' }, h('div', { class: 'row gap-sm' }, icon('chair', 22), h('h2', null, 'Furniture catalog'))),
    h('p', { class: 'muted small flat' }, 'Generic items with typical sizes. Place them on the plan from the Plan tab. Prices are non-binding estimates, not retailer prices.'),
    h('div', { class: 'row gap wrap' }, field('Category', catSel), field('Add to moodboard', boardTarget)), grid);

  // --- moodboards ---
  const boardsBox = h('div');
  const boardView = h('div');
  let boards = [];
  async function loadBoards(openId) {
    boards = (await api(`${base}/moodboards`)).moodboards;
    boardTarget.replaceChildren(...(boards.length ? boards.map((b) => h('option', { value: b.id }, b.name)) : [h('option', { value: '' }, 'Create a moodboard first')]));
    boardsBox.replaceChildren(boards.length ? h('div', { class: 'filter-bar flat-bar' }, h('span', { class: 'label-mono' }, 'Boards:'), boards.map((b) =>
      h('button', { type: 'button', class: 'filter-btn', 'aria-pressed': String(boardView.dataset.id === b.id), onclick: () => openBoard(b.id) }, b.name))) : h('p', { class: 'muted' }, 'No moodboards yet.'));
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
    boardsBox.querySelectorAll('.filter-btn').forEach((x, i) => x.setAttribute('aria-pressed', String(boards[i] && boards[i].id === mid)));
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
    const uploads = data.uploads.uploads;
    const upSel = select(uploads.map((u) => [u.id, u.filename || u.id.slice(0, 8)]), '');
    const add = (item) => (e) => addItem(e.currentTarget, item());
    boardView.replaceChildren(h('div', { class: 'board' },
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
  const createBtn = h('button', { type: 'submit', class: 'btn btn-primary btn-small' }, icon('add', 16), 'Create moodboard');
  const createForm = h('form', { class: 'row gap wrap align-end' }, field('New moodboard name', newName), createBtn, err);
  createForm.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    if (!newName.value.trim()) { err.show('Enter a name.'); return; }
    busy(createBtn, async () => {
      try { const m = await api(`${base}/moodboards`, { method: 'POST', body: { name: newName.value.trim() } }); newName.value = ''; await loadBoards(m.id); } catch (ex) { err.show(errorText(ex)); }
    });
  });
  const moodSec = h('section', { class: 'dash-panel' }, h('div', { class: 'dash-panel-head' }, h('div', { class: 'row gap-sm' }, icon('palette', 22), h('h2', null, 'Moodboards'))),
    createForm, boardsBox, boardView);
  await loadBoards();
  el.append(moodSec, catalogSec);
}
