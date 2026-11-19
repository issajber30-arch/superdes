// Plan tab: editor, versions, review flags (FR-02/03/19).
import { api, errorText } from '../api.js';
import { h, notice, busy, fmtDate, badge, toast } from '../dom.js';
import { PlanEditor, isEmpty } from '../editor/svg-editor.js';
import { wizardForm } from '../editor/wizard.js';
import { loadCatalog } from './guest.js';
import { go, setLeaveGuard } from '../app.js';

export function flagList(v) {
  if (!v || !v.review_flags || !v.review_flags.length) return null;
  return h('ul', { class: 'flags' }, v.review_flags.map((f) => h('li', null,
    badge(f.category, 'warn'), ` ${f.change} · ${f.element_id}${f.reason ? ` — ${f.reason}` : ''}${f.carried_from ? ` (from v${f.carried_from})` : ''}`)));
}

export function reviewBadge(v) {
  return v.review_status === 'provisional' ? badge('Provisional — needs professional review', 'warn') : badge('Conceptual', 'ok');
}

export async function render(el, ctx) {
  const { base, pid, staff, query } = ctx;
  const viewNo = query.v ? Number(query.v) : null;
  const [planRes, catalog] = await Promise.all([api(`${base}/plan`), loadCatalog()]);
  let current = planRes.current_version;
  const shown = viewNo && viewNo !== current.version_no ? await api(`${base}/plan/versions/${viewNo}`) : current;
  const readOnly = shown.version_no !== current.version_no;
  let dirty = false;
  const err = notice();
  const info = h('div', { class: 'version-info' });
  const versionsBox = h('div', { class: 'versions' });
  const host = h('div');
  const wizBox = h('div', { class: 'card', hidden: true });

  const editor = new PlanEditor(host, {
    geometry: shown.geometry, readOnly, catalog,
    onChange: () => { dirty = true; saveState.textContent = 'Unsaved changes'; },
  });
  const saveState = h('span', { class: 'muted small', 'aria-live': 'polite' }, '');

  function showInfo(v) {
    info.replaceChildren(
      h('div', { class: 'row gap wrap' }, h('strong', null, `Version ${v.version_no}`), v.label ? h('span', null, `“${v.label}”`) : null, reviewBadge(v),
        v.reviewed_at ? h('span', { class: 'muted small' }, `reviewed ${fmtDate(v.reviewed_at)}`) : null),
      flagList(v) || ''); // replaceChildren(null) would render the text "null"
  }

  async function loadVersions() {
    const res = await api(`${base}/plan/versions`);
    versionsBox.replaceChildren(h('h2', null, 'Versions'), h('ol', { class: 'version-list', reversed: true }, res.versions.map((v) => h('li', { class: v.version_no === shown.version_no ? 'active' : '' },
      h('div', { class: 'row gap wrap' }, h('strong', null, `v${v.version_no}`), h('span', null, v.label || '—')),
      h('div', { class: 'muted small' }, `${v.author_role} · ${fmtDate(v.created_at)}`),
      h('div', { class: 'row gap wrap' }, reviewBadge(v), v.review_flags && v.review_flags.length ? badge(`${v.review_flags.length} flag(s)`, 'warn') : null),
      h('div', { class: 'row gap wrap' },
        v.version_no === current.version_no ? (readOnly ? h('a', { class: 'btn btn-small', href: `#/p/${pid}/plan` }, 'Open current') : h('span', { class: 'muted small' }, 'current'))
          : h('a', { class: 'btn btn-small', href: `#/p/${pid}/plan?v=${v.version_no}` }, 'View'),
        staff && v.review_status === 'provisional' ? h('button', { type: 'button', class: 'btn btn-small', onclick: (e) => markReviewed(e.currentTarget, v.version_no) }, 'Mark reviewed') : null)))));
  }

  async function markReviewed(btn, n) {
    const note = window.prompt('Optional review note (e.g. who reviewed it):', '');
    if (note === null) return;
    try {
      const v = await busy(btn, () => api(`${base}/plan/versions/${n}/review`, { method: 'POST', body: note.trim() ? { note: note.trim().slice(0, 2000) } : {} }));
      toast(`Version ${n} marked as reviewed`);
      if (n === shown.version_no) { Object.assign(shown, v); showInfo(shown); }
      if (n === current.version_no) Object.assign(current, v);
      await loadVersions();
    } catch (ex) { toast(errorText(ex), 'error'); }
  }

  async function saveVersion(geometry, label, btn) {
    err.clear();
    try {
      const body = { geometry, base_version_no: current.version_no };
      if (label) body.label = label.slice(0, 200);
      const v = await busy(btn, () => api(`${base}/plan/versions`, { method: 'POST', body }));
      return v;
    } catch (ex) {
      err.show(errorText(ex));
      if (ex.code === 'version_conflict') {
        err.append(' ', h('button', { type: 'button', class: 'btn btn-small', onclick: () => go(`#/p/${pid}/plan?reload=${Date.now()}`) }, 'Reload latest (discards your edits)'));
      }
      return null;
    }
  }

  const actions = h('div', { class: 'plan-actions row gap wrap' });
  if (readOnly) {
    const restore = h('button', { type: 'button', class: 'btn btn-primary' }, `Restore v${shown.version_no} as new version`);
    restore.addEventListener('click', async () => {
      const v = await saveVersion(shown.geometry, `Restored from v${shown.version_no}`, restore);
      if (v) { toast(`Restored as version ${v.version_no}`); go(`#/p/${pid}/plan`); }
    });
    actions.append(h('p', { class: 'notice notice-info' }, `Viewing version ${shown.version_no} (read-only).`), restore,
      h('a', { class: 'btn', href: `#/p/${pid}/plan` }, 'Back to current version'));
  } else {
    const label = h('input', { type: 'text', maxlength: 200, placeholder: 'e.g. Moved kitchen wall', 'aria-label': 'Version label' });
    const save = h('button', { type: 'button', class: 'btn btn-primary' }, 'Save version');
    save.addEventListener('click', async () => {
      const v = await saveVersion(editor.getGeometry(), label.value.trim(), save);
      if (!v) return;
      current = v;
      Object.assign(shown, v);
      dirty = false;
      label.value = '';
      saveState.textContent = `Saved as version ${v.version_no}`;
      toast(`Saved as version ${v.version_no}${v.review_status === 'provisional' ? ' — flagged for professional review' : ''}`, v.review_status === 'provisional' ? 'warn' : 'info');
      showInfo(v);
      loadVersions();
    });
    const wizBtn = h('button', { type: 'button', class: 'btn btn-ghost' }, 'Room wizard');
    wizBtn.addEventListener('click', () => {
      wizBox.hidden = !wizBox.hidden;
      if (!wizBox.hidden) {
        wizBox.replaceChildren(h('h2', null, 'Generate rooms'),
          isEmpty(editor.getGeometry()) ? null : h('p', { class: 'notice notice-info' }, 'This replaces the current drawing in the editor (you can undo, and nothing is saved until you save a version).'),
          wizardForm((g) => { editor.setGeometry(g, true); editor.fit(); editor.render(); wizBox.hidden = true; }, { submitLabel: 'Load into editor' }));
      }
    });
    actions.append(label, save, saveState, wizBtn);
    if (isEmpty(shown.geometry)) wizBtn.click();
  }

  showInfo(shown);
  el.append(h('div', { class: 'plan-layout' },
    h('div', { class: 'plan-main' }, actions, err, info, wizBox, host),
    versionsBox));
  await loadVersions();

  const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = ''; } };
  window.addEventListener('beforeunload', warn);
  setLeaveGuard(() => !dirty || window.confirm('You have unsaved plan changes. Leave without saving?'));
  return () => { window.removeEventListener('beforeunload', warn); editor.destroy(); };
}
