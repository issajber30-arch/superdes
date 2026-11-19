// Project shell with tabs. Each tab module exports render(el, ctx) -> optional cleanup.
import { api, errorText } from '../api.js';
import { h, toast, badge } from '../dom.js';
import { CAVEAT } from '../editor/svg-editor.js';
import { go } from '../app.js';
import * as plan from './plan.js';
import * as brief from './brief.js';
import * as design from './design.js';
import * as ai from './ai.js';
import * as renders from './renders.js';
import * as compare from './compare.js';
import * as budget from './budget.js';
import * as collab from './collab.js';
import * as dossier from './dossier.js';

const TABS = [['plan', 'Plan', plan], ['brief', 'Brief', brief], ['design', 'Design', design], ['ai', 'AI consultant', ai],
  ['renders', 'Renders', renders], ['compare', 'Compare', compare], ['budget', 'Budget', budget],
  ['collab', 'Collaboration', collab], ['dossier', 'Dossier', dossier]];

export async function projectPage(main, [pid, tab = 'plan'], query) {
  const entry = TABS.find(([k]) => k === tab);
  if (!entry) { go(`#/p/${pid}/plan`); return null; }
  const project = await api(`/projects/${pid}`);
  const staff = ['owner', 'designer'].includes(project.my_role);
  const ctx = { pid, project, staff, query, base: `/projects/${pid}` };

  const title = h('h1', null, project.name);
  const head = h('div', { class: 'page-head' },
    h('div', null, h('p', { class: 'eyebrow' }, h('a', { href: '#/dashboard' }, 'Projects'), ' / ', project.status === 'archived' ? badge('archived') : null), title));
  if (staff) {
    const rename = h('button', { type: 'button', class: 'btn btn-small btn-ghost' }, 'Rename');
    rename.addEventListener('click', async () => {
      const name = (window.prompt('New project name', project.name) || '').trim();
      if (!name || name === project.name) return;
      try { const p = await api(ctx.base, { method: 'PATCH', body: { name: name.slice(0, 200) } }); project.name = p.name; title.textContent = p.name; toast('Project renamed'); } catch (ex) { toast(errorText(ex), 'error'); }
    });
    const archive = h('button', { type: 'button', class: 'btn btn-small btn-ghost' }, project.status === 'archived' ? 'Reactivate' : 'Archive');
    archive.addEventListener('click', async () => {
      const status = project.status === 'archived' ? 'active' : 'archived';
      try { await api(ctx.base, { method: 'PATCH', body: { status } }); toast(`Project ${status === 'archived' ? 'archived' : 'reactivated'}`); go(`#/p/${pid}/${tab}`); } catch (ex) { toast(errorText(ex), 'error'); }
    });
    head.append(h('div', { class: 'row gap' }, rename, archive));
  }
  const nav = h('nav', { class: 'tabs', 'aria-label': 'Project sections' },
    TABS.map(([k, label]) => h('a', { href: `#/p/${pid}/${k}`, class: 'tab', 'aria-current': k === tab ? 'page' : null }, label)));
  const panel = h('div', { class: 'tab-panel' });
  main.append(h('section', { class: 'page wide project' }, head,
    h('p', { class: 'caveat', role: 'note' }, CAVEAT), nav, panel));
  return entry[2].render(panel, ctx);
}
