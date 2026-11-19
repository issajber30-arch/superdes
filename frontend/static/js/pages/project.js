// Project shell with tabs. Each tab module exports render(el, ctx) -> optional cleanup.
import { api, errorText } from '../api.js';
import { h, toast, badge } from '../dom.js';
import { CAVEAT } from '../editor/svg-editor.js';
import { go, setProjectChrome } from '../app.js';
import { icon } from '../icons.js';
import * as plan from './plan.js';
import * as brief from './brief.js';
import * as design from './design.js';
import * as ai from './ai.js';
import * as renders from './renders.js';
import * as compare from './compare.js';
import * as budget from './budget.js';
import * as collab from './collab.js';
import * as dossier from './dossier.js';

// [route key, label, icon]; labels stay as before so links and tests keep working
const TABS = [['plan', 'Plan', plan, 'architecture'], ['brief', 'Brief', brief, 'edit_note'], ['design', 'Design', design, 'palette'],
  ['ai', 'AI consultant', ai, 'psychology'], ['renders', 'Renders', renders, 'photo_camera'], ['compare', 'Compare', compare, 'compare'],
  ['budget', 'Budget', budget, 'receipt_long'], ['collab', 'Collaboration', collab, 'forum'], ['dossier', 'Dossier', dossier, 'description']];
// Stitch step group: each step opens its first section and is current for all of its sections
const STEPS = [['1. Floor plan', ['plan']], ['2. Style & materials', ['brief', 'design']], ['3. AI visualizer', ['ai', 'renders', 'compare']], ['4. Dossier & budget', ['budget', 'dossier']]];

export async function projectPage(main, [pid, tab = 'plan'], query) {
  const entry = TABS.find(([k]) => k === tab);
  if (!entry) { go(`#/p/${pid}/plan`); return null; }
  const project = await api(`/projects/${pid}`);
  const staff = ['owner', 'designer'].includes(project.my_role);
  const ctx = { pid, project, staff, query, base: `/projects/${pid}` };

  const title = h('h1', null, project.name);
  const crumbName = h('span', { class: 'crumb-name', title: project.name }, project.name);
  const head = h('div', { class: 'page-head' },
    h('div', null, h('p', { class: 'eyebrow' }, h('a', { href: '#/dashboard' }, 'Projects'), ' / ', project.status === 'archived' ? badge('archived') : `${entry[1]}`), title));
  if (staff) {
    const rename = h('button', { type: 'button', class: 'btn btn-small btn-ghost' }, 'Rename');
    rename.addEventListener('click', async () => {
      const name = (window.prompt('New project name', project.name) || '').trim();
      if (!name || name === project.name) return;
      try { const p = await api(ctx.base, { method: 'PATCH', body: { name: name.slice(0, 200) } }); project.name = p.name; title.textContent = p.name; crumbName.textContent = p.name; toast('Project renamed'); } catch (ex) { toast(errorText(ex), 'error'); }
    });
    const archive = h('button', { type: 'button', class: 'btn btn-small btn-ghost' }, project.status === 'archived' ? 'Reactivate' : 'Archive');
    archive.addEventListener('click', async () => {
      const status = project.status === 'archived' ? 'active' : 'archived';
      try { await api(ctx.base, { method: 'PATCH', body: { status } }); toast(`Project ${status === 'archived' ? 'archived' : 'reactivated'}`); go(`#/p/${pid}/${tab}`); } catch (ex) { toast(errorText(ex), 'error'); }
    });
    head.append(h('div', { class: 'row gap' }, rename, archive));
  }
  const rail = h('nav', { class: 'rail', 'aria-label': 'Project sections' },
    TABS.map(([k, label, , ic]) => h('a', { href: `#/p/${pid}/${k}`, 'aria-current': k === tab ? 'page' : null }, icon(ic, 22), h('span', null, label))));
  const steps = h('nav', { class: 'steps', 'aria-label': 'Project steps' },
    STEPS.map(([label, keys]) => h('a', { href: `#/p/${pid}/${keys[0]}`, class: 'step', 'aria-current': keys.includes(tab) ? 'step' : null }, label)));
  setProjectChrome({
    rail,
    topbar: h('div', { class: 'topbar-project' },
      h('div', { class: 'crumb' }, crumbName, h('span', { class: 'crumb-meta' }, `${project.status} · ${project.my_role}`)), steps),
  });
  const panel = h('div', { class: 'tab-panel' });
  main.append(h('section', { class: `page wide project project-${tab}` }, head,
    h('p', { class: 'notice-footer', role: 'note' }, icon('info', 16), h('span', null, `Notice: ${CAVEAT}`)), panel));
  return entry[2].render(panel, ctx);
}
