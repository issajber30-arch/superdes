// Budget: non-binding estimate with overrides, manual items and a shopping list.
import { api, errorText } from '../api.js';
import { h, field, notice, busy, money, toast } from '../dom.js';

export async function render(el, ctx) {
  const { base } = ctx;
  const box = h('div');
  let mode = 'estimate';
  const err = notice();

  const label = (est) => h('p', { class: 'estimate-label' }, h('strong', null, 'Estimates — non-binding, not retailer prices.'), ` ${est.disclaimer || ''}`);

  function drawEstimate(est) {
    const cur = est.currency;
    const rows = est.items.map((it) => {
      const qty = h('input', { type: 'number', min: 0, step: 'any', value: it.qty, 'aria-label': `Quantity for ${it.label}`, class: 'num' });
      const lo = h('input', { type: 'number', min: 0, step: 'any', value: it.unit_low, 'aria-label': `Unit low for ${it.label}`, class: 'num' });
      const hi = h('input', { type: 'number', min: 0, step: 'any', value: it.unit_high, 'aria-label': `Unit high for ${it.label}`, class: 'num' });
      const ex = h('input', { type: 'checkbox', checked: it.excluded, 'aria-label': `Exclude ${it.label}` });
      const save = h('button', { type: 'button', class: 'btn btn-small' }, 'Apply');
      const run = (fn) => busy(save, async () => { try { drawEstimate(await fn()); } catch (e2) { toast(errorText(e2), 'error'); } });
      save.addEventListener('click', () => {
        if (it.source === 'manual') { toast('Manual items cannot be edited — delete and re-add them.', 'error'); return; }
        const body = { qty: Number(qty.value), unit_low: Number(lo.value), unit_high: Number(hi.value), excluded: ex.checked };
        if (Object.values(body).some((v) => typeof v === 'number' && (!Number.isFinite(v) || v < 0))) { toast('Enter non-negative numbers.', 'error'); return; }
        if (body.unit_low > body.unit_high) { toast('Low price must not exceed high price.', 'error'); return; }
        run(() => api(`${base}/estimates/overrides/${encodeURIComponent(it.item_key)}`, { method: 'PUT', body }));
      });
      const extra = it.source === 'manual'
        ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => run(() => api(`${base}/estimates/items/${it.id}`, { method: 'DELETE' })) }, 'Delete')
        : it.overridden ? h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => run(() => api(`${base}/estimates/overrides/${encodeURIComponent(it.item_key)}`, { method: 'DELETE' })) }, 'Reset') : null;
      return h('tr', { class: it.excluded ? 'excluded' : '' },
        h('td', null, it.label, h('div', { class: 'muted small' }, [it.category, it.source, it.overridden ? 'edited' : '', (it.rooms || []).join(', ')].filter(Boolean).join(' · '))),
        h('td', null, it.source === 'manual' ? String(it.qty) : qty, ` ${it.unit}`),
        h('td', null, it.source === 'manual' ? money(it.unit_low, cur) : lo),
        h('td', null, it.source === 'manual' ? money(it.unit_high, cur) : hi),
        h('td', null, `${money(it.total_low, cur)} – ${money(it.total_high, cur)}`),
        h('td', null, it.source === 'manual' ? '' : h('label', { class: 'check' }, ex, ' Exclude')),
        h('td', null, h('div', { class: 'row gap' }, it.source === 'manual' ? null : save, extra)));
    });
    const mLabel = h('input', { type: 'text', maxlength: 200, required: true });
    const mQty = h('input', { type: 'number', min: 0, step: 'any', value: 1, class: 'num' });
    const mUnit = h('input', { type: 'text', value: 'pcs', maxlength: 10, class: 'num' });
    const mLo = h('input', { type: 'number', min: 0, step: 'any', value: 0, class: 'num' });
    const mHi = h('input', { type: 'number', min: 0, step: 'any', value: 0, class: 'num' });
    const mBtn = h('button', { type: 'submit', class: 'btn btn-small btn-primary' }, 'Add item');
    const mForm = h('form', { class: 'row gap wrap align-end' }, field('Item', mLabel), field('Qty', mQty), field('Unit', mUnit), field('Unit low', mLo), field('Unit high', mHi), mBtn);
    mForm.addEventListener('submit', (e) => {
      e.preventDefault();
      if (!mLabel.value.trim()) { toast('Enter a label.', 'error'); return; }
      const body = { label: mLabel.value.trim(), qty: Number(mQty.value), unit: mUnit.value.trim() || 'pcs', unit_low: Number(mLo.value), unit_high: Number(mHi.value) };
      if (body.unit_low > body.unit_high) { toast('Low price must not exceed high price.', 'error'); return; }
      busy(mBtn, async () => { try { drawEstimate(await api(`${base}/estimates/items`, { method: 'POST', body })); } catch (e2) { toast(errorText(e2), 'error'); } });
    });
    box.replaceChildren(label(est),
      h('p', { class: 'muted small' }, `Based on plan version ${est.plan_version_no} · ${est.basis}`),
      h('div', { class: 'table-wrap' }, h('table', { class: 'budget' },
        h('thead', null, h('tr', null, ['Item', 'Qty', 'Unit low', 'Unit high', 'Total range', '', ''].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, rows.length ? rows : h('tr', null, h('td', { colspan: 7, class: 'muted' }, 'No items yet — place furniture on the plan or choose finishes in the Design tab.'))),
        h('tfoot', null, h('tr', null, h('th', { scope: 'row', colspan: 4 }, `Total (${est.label})`), h('td', { colspan: 3 }, h('strong', null, `${money(est.totals.low, cur)} – ${money(est.totals.high, cur)}`)))))),
      h('h3', null, 'Add a manual item'), mForm);
  }

  function drawShopping(list) {
    const cur = list.currency;
    box.replaceChildren(label(list),
      h('p', { class: 'muted small' }, `Plan version ${list.plan_version_no} · no retailer is linked; prices are generic ranges.`),
      h('ul', { class: 'shopping' }, list.items.map((it) => h('li', null,
        h('label', { class: 'check' }, h('input', { type: 'checkbox' }), ` ${it.qty} ${it.unit} × ${it.label}`),
        h('span', { class: 'muted small' }, ` ${it.category}${it.rooms && it.rooms.length ? ` · ${it.rooms.join(', ')}` : ''} · ${money(it.total_low, cur)} – ${money(it.total_high, cur)}`)))),
      h('p', null, h('strong', null, `Total ${money(list.totals.low, cur)} – ${money(list.totals.high, cur)}`), ` (${list.label})`));
  }

  async function load() {
    err.clear();
    try {
      if (mode === 'estimate') drawEstimate(await api(`${base}/estimates`));
      else drawShopping(await api(`${base}/shopping-list`));
    } catch (ex) { err.show(errorText(ex)); }
  }
  const tabBtn = (m, text) => {
    const b = h('button', { type: 'button', class: 'btn btn-small', 'aria-pressed': String(mode === m) }, text);
    b.addEventListener('click', () => { mode = m; toggles.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); load(); });
    return b;
  };
  const toggles = h('div', { class: 'btn-group', role: 'group', 'aria-label': 'Budget view' }, tabBtn('estimate', 'Estimate'), tabBtn('shopping', 'Shopping list'));
  el.append(h('section', { class: 'card' }, h('div', { class: 'row gap wrap spread' }, h('h2', null, 'Budget'), toggles), err, box));
  await load();
}
