// Brief tab: every category of the Brief object.
import { api, apiUrl, errorText } from '../api.js';
import { h, field, notice, busy, select, fmtDate, toast } from '../dom.js';

const list = (v) => v.split(/[\n,]/).map((x) => x.trim()).filter(Boolean);
const lines = (v) => v.split('\n').map((x) => x.trim()).filter(Boolean);
const num = (v) => (v === '' ? null : Number(v));

export async function render(el, ctx) {
  const { base } = ctx;
  const [res, stylesRes, uploadsRes] = await Promise.all([api(`${base}/brief`), api('/catalog/styles'), api(`${base}/uploads`)]);
  const b = res.brief;
  const err = notice();

  const styleBoxes = stylesRes.styles.map((st) => {
    const cb = h('input', { type: 'checkbox', value: st.key, checked: b.styles.includes(st.key) });
    return h('label', { class: 'check chip' }, cb, ` ${st.name}`);
  });
  const extraStyles = h('input', { type: 'text', value: b.styles.filter((x) => !stylesRes.styles.some((st) => st.key === x)).join(', ') });
  const colors = h('input', { type: 'text', value: b.colors.join(', ') });
  const materials = h('input', { type: 'text', value: b.materials.join(', ') });
  const bmin = h('input', { type: 'number', min: 0, step: 100, value: b.budget.min ?? '', inputmode: 'numeric' });
  const bmax = h('input', { type: 'number', min: 0, step: 100, value: b.budget.max ?? '', inputmode: 'numeric' });
  const currency = h('input', { type: 'text', value: b.budget.currency, maxlength: 3, pattern: '[A-Z]{3}', autocapitalize: 'characters' });
  const priority = select([['low_cost', 'Keep costs low'], ['balanced', 'Balanced'], ['premium', 'Premium']], b.budget.priority);
  const functional = h('textarea', { rows: 4 }, b.functional_needs.join('\n'));
  const lifestyle = h('textarea', { rows: 3 }, b.lifestyle.join('\n'));
  const constraints = h('textarea', { rows: 3 }, b.constraints.join('\n'));
  const adults = h('input', { type: 'number', min: 0, max: 20, value: b.household.adults });
  const children = h('input', { type: 'number', min: 0, max: 20, value: b.household.children });
  const pets = h('input', { type: 'text', value: b.household.pets.join(', ') });
  const wfh = h('input', { type: 'checkbox', checked: b.household.works_from_home });
  const access = h('textarea', { rows: 2, maxlength: 1000 }, b.household.accessibility_needs);
  const urls = h('textarea', { rows: 3 }, b.inspiration_urls.join('\n'));
  const notes = h('textarea', { rows: 5, maxlength: 5000 }, b.notes);
  const uploadBoxes = h('div', { class: 'thumbs' });
  const renderUploads = (uploads, chosen) => uploadBoxes.replaceChildren(...(uploads.length ? uploads.map((u) => {
    const cb = h('input', { type: 'checkbox', value: u.id, checked: chosen.includes(u.id) });
    return h('label', { class: 'thumb' }, h('img', { src: apiUrl(u.url), alt: u.filename || 'Inspiration image', loading: 'lazy' }), h('span', null, cb, ' Use'));
  }) : [h('p', { class: 'muted small' }, 'No images uploaded yet.')]));
  renderUploads(uploadsRes.uploads, b.inspiration_upload_ids);
  const file = h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif' });
  const upBtn = h('button', { type: 'button', class: 'btn btn-small' }, 'Upload image');
  upBtn.addEventListener('click', () => {
    const f = file.files[0];
    if (!f) { toast('Choose an image first.', 'error'); return; }
    if (f.size > 10 * 1024 * 1024) { toast('Images must be 10 MB or smaller.', 'error'); return; }
    const fd = new FormData();
    fd.append('file', f);
    busy(upBtn, async () => {
      try {
        const up = await api(`${base}/uploads`, { method: 'POST', form: fd });
        const chosen = [...uploadBoxes.querySelectorAll('input:checked')].map((c) => c.value).concat(up.id);
        renderUploads((await api(`${base}/uploads`)).uploads, chosen);
        file.value = '';
      } catch (ex) { toast(errorText(ex), 'error'); }
    });
  });

  const itemsBox = h('div', { class: 'items' });
  const addItem = (it = { name: '', keep: true, width_mm: null, depth_mm: null, notes: '' }) => {
    const row = h('fieldset', { class: 'item-row' }, h('legend', { class: 'sr-only' }, 'Existing item'),
      field('Item', h('input', { type: 'text', name: 'name', value: it.name, maxlength: 100 })),
      field('Width (mm)', h('input', { type: 'number', name: 'w', min: 1, max: 20000, value: it.width_mm ?? '' })),
      field('Depth (mm)', h('input', { type: 'number', name: 'd', min: 1, max: 20000, value: it.depth_mm ?? '' })),
      field('Notes', h('input', { type: 'text', name: 'notes', value: it.notes || '', maxlength: 500 })),
      h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'keep', checked: it.keep }), ' Keep'),
      h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => row.remove() }, 'Remove'));
    itemsBox.append(row);
  };
  b.existing_items.forEach(addItem);

  const saveBtn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Save brief');
  const meta = h('p', { class: 'muted small' }, res.updated_at ? `Last saved ${fmtDate(res.updated_at)}` : 'Not saved yet.');
  const sec = (title, ...kids) => h('fieldset', { class: 'card' }, h('legend', null, title), kids);
  const form = h('form', { class: 'brief form', novalidate: true },
    sec('Style', h('div', { class: 'chips', role: 'group', 'aria-label': 'Preferred styles' }, styleBoxes), field('Other styles', extraStyles, 'Comma separated.'),
      field('Colours you like', colors, 'Comma separated, e.g. warm white, sage, oak.'), field('Materials', materials, 'Comma separated.')),
    sec('Budget', h('div', { class: 'row gap wrap' }, field('Minimum', bmin), field('Maximum', bmax), field('Currency', currency)), field('Priority', priority)),
    sec('Needs and lifestyle', field('Functional needs', functional, 'One per line, e.g. storage for 200 books.'),
      field('Lifestyle', lifestyle, 'One per line.'), field('Constraints', constraints, 'One per line, e.g. rented flat, no drilling.')),
    sec('Household', h('div', { class: 'row gap wrap' }, field('Adults', adults), field('Children', children)), field('Pets', pets, 'Comma separated.'),
      h('label', { class: 'check' }, wfh, ' Someone works from home'), field('Accessibility needs', access)),
    sec('Inspiration', uploadBoxes, h('div', { class: 'row gap wrap' }, field('Add an image', file), upBtn), field('Links', urls, 'One http(s) link per line.')),
    sec('Existing furniture', itemsBox, h('button', { type: 'button', class: 'btn btn-small', onclick: () => addItem() }, 'Add item')),
    sec('Notes', field('Anything else', notes)),
    h('div', { class: 'row gap' }, saveBtn, meta), err);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    err.clear();
    const styles = [...new Set([...styleBoxes.map((l) => l.querySelector('input')).filter((c) => c.checked).map((c) => c.value), ...list(extraStyles.value)])];
    const brief = {
      styles, colors: list(colors.value), materials: list(materials.value),
      budget: { min: num(bmin.value), max: num(bmax.value), currency: currency.value.trim().toUpperCase() || 'EUR', priority: priority.value },
      functional_needs: lines(functional.value), lifestyle: lines(lifestyle.value), constraints: lines(constraints.value),
      household: { adults: Number(adults.value || 0), children: Number(children.value || 0), pets: list(pets.value), works_from_home: wfh.checked, accessibility_needs: access.value.trim() },
      inspiration_upload_ids: [...uploadBoxes.querySelectorAll('input:checked')].map((c) => c.value),
      inspiration_urls: lines(urls.value),
      existing_items: [...itemsBox.querySelectorAll('.item-row')].map((r) => ({
        name: r.querySelector('[name=name]').value.trim(), keep: r.querySelector('[name=keep]').checked,
        width_mm: num(r.querySelector('[name=w]').value), depth_mm: num(r.querySelector('[name=d]').value), notes: r.querySelector('[name=notes]').value.trim(),
      })).filter((i) => i.name),
      notes: notes.value,
    };
    const problems = [];
    if (brief.styles.length > 10) problems.push('Choose at most 10 styles.');
    if (brief.budget.min != null && brief.budget.max != null && brief.budget.min > brief.budget.max) problems.push('Budget minimum must not exceed the maximum.');
    if (!/^[A-Z]{3}$/.test(brief.budget.currency)) problems.push('Currency must be a 3-letter code such as EUR.');
    if (brief.inspiration_urls.some((u) => !/^https?:\/\/\S+$/.test(u))) problems.push('Each link must start with http:// or https://.');
    if ([...brief.styles, ...brief.colors, ...brief.materials, ...brief.household.pets].some((x) => x.length > 60)) problems.push('Style, colour, material and pet entries are limited to 60 characters each.');
    if (problems.length) { err.show(problems.join('\n')); return; }
    busy(saveBtn, async () => {
      try {
        const saved = await api(`${base}/brief`, { method: 'PUT', body: brief });
        meta.textContent = `Last saved ${fmtDate(saved.updated_at)}`;
        toast('Brief saved');
      } catch (ex) { err.show(errorText(ex)); }
    });
  });
  el.append(h('p', { class: 'muted' }, 'The brief guides the AI consultant, estimates and the dossier.'), form);
}
