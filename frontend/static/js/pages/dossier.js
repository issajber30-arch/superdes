// Dossier: generate (staff) and open the printable HTML snapshot.
import { api, apiUrl, errorText } from '../api.js';
import { h, field, notice, busy, select, fmtDate } from '../dom.js';
import { reviewBadge } from './plan.js';

export async function render(el, ctx) {
  const { base, staff } = ctx;
  const [versions, dossiers] = await Promise.all([api(`${base}/plan/versions`), api(`${base}/dossiers`)]);
  const list = h('div');
  const draw = (items) => list.replaceChildren(items.length ? h('ul', { class: 'dossiers' }, items.map((d) => h('li', { class: 'card' },
    h('div', { class: 'row gap wrap spread' },
      h('div', null, h('strong', null, `Plan v${d.plan_version_no}`), ' ', reviewBadge(d), h('div', { class: 'muted small' }, fmtDate(d.created_at))),
      h('a', { class: 'btn btn-small', href: apiUrl(d.html_url), target: '_blank', rel: 'noopener noreferrer' }, 'Open dossier (new tab)')),
    d.note ? h('p', { class: 'small' }, d.note) : null))) : h('p', { class: 'muted' }, 'No dossiers yet.'));
  draw(dossiers.dossiers);

  let form = null;
  if (staff) {
    const ver = select(versions.versions.map((v) => [v.version_no, `v${v.version_no}${v.label ? ` — ${v.label}` : ''}`]), versions.versions[0].version_no);
    const note = h('textarea', { rows: 2, maxlength: 2000 });
    const err = notice();
    const btn = h('button', { type: 'submit', class: 'btn btn-primary' }, 'Generate and submit dossier');
    form = h('form', { class: 'card form' }, h('h2', null, 'New dossier'),
      h('p', { class: 'muted small' }, 'Creates an immutable, branded snapshot: plan, brief, concepts, latest renders, non-binding estimate and review status.'),
      field('Plan version', ver), field('Note for the client', note), btn, err);
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      err.clear();
      const body = { plan_version_no: Number(ver.value) };
      if (note.value.trim()) body.note = note.value.trim();
      busy(btn, async () => {
        try {
          const d = await api(`${base}/dossiers`, { method: 'POST', body });
          note.value = '';
          draw((await api(`${base}/dossiers`)).dossiers);
          err.show(`Dossier for v${d.plan_version_no} created.`, 'info');
        } catch (ex) { err.show(errorText(ex)); }
      });
    });
  }
  el.append(form || h('p', { class: 'muted' }, 'Your designer publishes dossiers here.'),
    h('section', null, h('h2', null, 'Dossiers'), h('p', { class: 'muted small' }, 'Use your browser’s print dialog on the dossier page to save it as a PDF.'), list));
}
