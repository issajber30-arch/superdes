// Stitch "Style, Materials & AI Visualizer" studio: one 3-column screen for the Design, AI consultant and Renders
// sections (left palette, centre visualizer, right consultant), moodboards + catalog below. Each route keeps its own
// URL and scrolls its column into view on narrow screens, where the columns stack.
import { api } from '../api.js';
import { h } from '../dom.js';
import { icon } from '../icons.js';
import { polygonArea } from '../editor/svg-editor.js';
import { renderPalette, renderBoards } from './design.js';
import { renderVisualizer } from './renders.js';
import { renderConsultant } from './ai.js';

export async function render(el, ctx) {
  const { base, pid, tab } = ctx;
  const [styles, floors, walls, furniture, plan, sel, briefRes, uploads, versions, convs, prefs] = await Promise.all([
    api('/catalog/styles'), api('/catalog/finishes?surface=floor'), api('/catalog/finishes?surface=wall'), api('/catalog/furniture'),
    api(`${base}/plan`), api(`${base}/finishes`), api(`${base}/brief`), api(`${base}/uploads`), api(`${base}/plan/versions`),
    api(`${base}/ai/conversations`), api(`${base}/ai/preferences`)]);
  const data = { styles, floors, walls, furniture, plan, sel, brief: briefRes.brief, uploads, versions, convs, prefs };

  const rooms = plan.current_version.geometry.rooms || [];
  const area = rooms.reduce((a, r) => a + polygonArea(r.polygon), 0) / 1e6;
  const left = h('aside', { class: 'studio-col studio-left', 'aria-label': 'Style and materials' });
  const centre = h('section', { class: 'studio-col studio-centre', 'aria-label': 'AI visualizer' });
  const right = h('aside', { class: 'studio-col studio-right', 'aria-label': 'AI consultant' });
  const below = h('div', { class: 'studio-below' });
  el.append(
    h('div', { class: 'studio-sub' },
      h('div', { class: 'row gap wrap' },
        h('div', { class: 'row gap-sm' }, h('span', { class: 'chip-dark' }, 'Step 2 & 3'), h('span', { class: 'strong' }, 'Style, materials & AI visualizer studio')),
        h('span', { class: 'pill-soft' }, h('span', { class: 'dot tone-secondary' }),
          `Linked to plan v${plan.current_version.version_no} (${rooms.length} room${rooms.length === 1 ? '' : 's'} · ${area.toFixed(1)} m²)`)),
      h('a', { class: 'btn btn-small btn-soft', href: `#/p/${pid}/brief` }, icon('edit_note', 16), 'Design brief')),
    h('div', { class: 'studio' }, left, centre, right),
    below,
    h('div', { class: 'step-bar' },
      h('a', { class: 'btn btn-soft', href: `#/p/${pid}/plan` }, icon('arrow_back', 16), 'Back to floor plan'),
      h('a', { class: 'btn btn-primary', href: `#/p/${pid}/budget` }, 'Proceed to step 4: Dossier & budget', icon('arrow_forward', 16))));

  renderPalette(left, ctx, data);
  const [stopVisualizer] = await Promise.all([renderVisualizer(centre, ctx, data), renderConsultant(right, ctx, data), renderBoards(below, ctx, data)]);
  const focus = { design: left, renders: centre, ai: right }[tab];
  if (focus && window.matchMedia('(max-width: 1279px)').matches) focus.scrollIntoView({ block: 'start' });
  return stopVisualizer;
}
