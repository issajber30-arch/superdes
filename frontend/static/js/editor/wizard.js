// Guided wizard (FR-01): rooms with name/type/size -> walls + rooms left to right, one door per room.
import { h, field, select, notice } from '../dom.js';
import { ROOM_KINDS } from './svg-editor.js';

const T = 100; // wall thickness, mm

export function generateGeometry(rooms) {
  const g = { walls: [], openings: [], rooms: [], fixtures: [], furniture: [] };
  let x = 0;
  rooms.forEach((r, i) => {
    const w = r.width; const l = r.length; const n = i + 1;
    const next = rooms[i + 1];
    g.rooms.push({ id: `r${n}`, name: r.name, kind: r.kind, polygon: [[x, 0], [x + w, 0], [x + w, l], [x, l]] });
    g.walls.push({ id: `w${n}t`, a: [x, 0], b: [x + w, 0], thickness: T, structural: false });
    g.walls.push({ id: `w${n}b`, a: [x, l], b: [x + w, l], thickness: T, structural: false });
    if (i === 0) g.walls.push({ id: `w${n}l`, a: [x, 0], b: [x, l], thickness: T, structural: false });
    // the right wall is shared with the next room, so it spans the taller of the two
    g.walls.push({ id: `w${n}r`, a: [x + w, 0], b: [x + w, next ? Math.max(l, next.length) : l], thickness: T, structural: false });
    const dw = Math.min(800, w - 200);
    g.openings.push({ id: `d${n}`, wall_id: `w${n}b`, offset: Math.round((w - dw) / 200) * 100, width: dw, kind: 'door' });
    x += w;
  });
  return g;
}

/** Renders the wizard form; onDone(geometry) is called with the generated plan. */
export function wizardForm(onDone, { submitLabel = 'Create plan' } = {}) {
  const err = notice();
  const list = h('div', { class: 'wizard-rows' });
  const defaults = [['Living room', 'living', 5, 4], ['Kitchen', 'kitchen', 3, 4], ['Bedroom', 'bedroom', 3.5, 4]];
  let n = 0;
  const addRow = ([name, kind, w, l] = ['', 'bedroom', 3, 3]) => {
    n += 1;
    const row = h('fieldset', { class: 'wizard-row' },
      h('legend', { class: 'sr-only' }, `Room ${n}`),
      field('Room name', h('input', { type: 'text', name: 'name', value: name, maxlength: 100, required: true })),
      field('Type', select(ROOM_KINDS.map((k) => [k, k]), kind, { name: 'kind' })),
      field('Width (m)', h('input', { type: 'number', name: 'width', value: w, min: 1, max: 30, step: 0.1, required: true, inputmode: 'decimal' })),
      field('Length (m)', h('input', { type: 'number', name: 'length', value: l, min: 1, max: 30, step: 0.1, required: true, inputmode: 'decimal' })),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', 'aria-label': 'Remove this room', onclick: () => { row.remove(); } }, 'Remove'));
    list.append(row);
  };
  defaults.forEach(addRow);
  const form = h('form', { class: 'wizard', novalidate: true },
    h('p', { class: 'muted' }, 'List the rooms with their inside dimensions. We lay them out side by side with a door in each — you can then adjust everything in the editor.'),
    list,
    h('div', { class: 'row gap' },
      h('button', { type: 'button', class: 'btn', onclick: () => addRow() }, 'Add room'),
      h('button', { type: 'submit', class: 'btn btn-primary' }, submitLabel)),
    err);
  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    const rooms = [...list.querySelectorAll('.wizard-row')].map((row) => ({
      name: row.querySelector('[name=name]').value.trim(),
      kind: row.querySelector('[name=kind]').value,
      width: Math.round(Number(row.querySelector('[name=width]').value) * 10) * 100,
      length: Math.round(Number(row.querySelector('[name=length]').value) * 10) * 100,
    }));
    if (!rooms.length) return err.show('Add at least one room.');
    if (rooms.length > 30) return err.show('The wizard supports up to 30 rooms.');
    const bad = rooms.find((r) => !r.name || r.name.length > 100 || !ROOM_KINDS.includes(r.kind) || !(r.width >= 1000 && r.width <= 30000) || !(r.length >= 1000 && r.length <= 30000));
    if (bad) return err.show('Each room needs a name and a width and length between 1 and 30 m.');
    onDone(generateGeometry(rooms));
  });
  return form;
}
