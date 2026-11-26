// SVG floor-plan editor. Geometry follows the API contract: mm, origin top-left, y down.
import { h, s, select, field, toast } from '../dom.js';
import { icon } from '../icons.js';

export const CAVEAT = 'Conceptual plan — changes to walls, openings, kitchens or bathrooms require review by a qualified professional before any construction.';
export const ROOM_KINDS = ['living', 'bedroom', 'kitchen', 'bathroom', 'dining', 'office', 'hallway', 'other'];
export const FIXTURE_KINDS = ['sink', 'toilet', 'shower', 'bathtub', 'stove', 'fridge', 'counter', 'dishwasher', 'other'];
const CATALOG_FIXTURE = {
  'kitchen-base-60': 'counter', 'kitchen-island': 'counter', fridge: 'fridge', stove: 'stove', 'kitchen-sink': 'sink',
  dishwasher: 'dishwasher', toilet: 'toilet', 'bath-sink': 'sink', shower: 'shower', bathtub: 'bathtub',
};
const LAYERS = ['walls', 'openings', 'rooms', 'fixtures', 'furniture'];
const SNAP = 100;
const LIMIT = 100000;
const snap = (v, step = SNAP) => Math.round(v / step) * step;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
const NEAR = 5; // mm: a room corner this close to a wall endpoint is treated as attached to it
const same = (p, q) => p[0] === q[0] && p[1] === q[1];
export const polygonArea = (pts) => Math.abs(pts.reduce((acc, p, i) => {
  const q = pts[(i + 1) % pts.length];
  return acc + p[0] * q[1] - q[0] * p[1];
}, 0)) / 2;

export function normalize(g) {
  const out = {};
  for (const k of LAYERS) out[k] = Array.isArray(g && g[k]) ? JSON.parse(JSON.stringify(g[k])) : [];
  return out;
}
export const isEmpty = (g) => LAYERS.every((k) => !(g && g[k] && g[k].length));

let seq = 0;
function newId(g, prefix) {
  const used = new Set(LAYERS.flatMap((k) => g[k].map((e) => e.id)));
  let id;
  do { id = `${prefix}${Date.now().toString(36)}${(++seq).toString(36)}`; } while (used.has(id));
  return id;
}

let instance = 0;

export class PlanEditor {
  /**
   * opts: geometry, readOnly, catalog (furniture items), highlight (Set of ids), onChange(geometry), panel (bool),
   *   title / sheet (sheet header text), wizard (() => Node, adds a "Room wizard" tab), versions (Node, adds a "Versions" tab),
   *   initialTab ('wizard' | 'library' | 'stats' | 'versions')
   */
  constructor(host, opts = {}) {
    this.uid = `pe${++instance}`;
    this.opts = opts;
    this.readOnly = !!opts.readOnly;
    this.g = normalize(opts.geometry);
    this.catalog = opts.catalog || [];
    this.highlight = opts.highlight || new Set();
    this.sel = null;
    this.tool = 'select';
    this.draft = null;
    this.cursor = null;
    this.drag = null;
    this.undoStack = [];
    this.redoStack = [];
    this.buildDom(host);
    this.fit();
    this.render();
    this.ro = new ResizeObserver(() => this.render());
    this.ro.observe(this.svg);
  }

  destroy() { this.ro.disconnect(); this.close3D(); }

  // ---------- 3D (view3d.js, loaded on first use) ----------
  /** finishes: {roomId: {floor: '#hex', wall: '#hex'}} shown on the 3D surfaces. */
  setFinishes(finishes) { this.opts.finishes = finishes; this.update3D(); }

  sceneOpts() { return { finishes: this.opts.finishes, catalog: this.catalog }; }

  update3D(keepView = true) {
    if (this.v3d && this.sceneModel) this.v3d.update(this.sceneModel(this.g, this.sceneOpts()), keepView);
  }

  /** Move furniture or a fixture to (x, y) mm through the normal edit path (undo, unsaved state); snaps like a 2D drag. */
  moveItem(type, id, x, y) {
    if (this.readOnly || !['furniture', 'fixtures'].includes(type)) return;
    const it = this.find(type, id);
    if (!it || !Number.isFinite(x) || !Number.isFinite(y)) return;
    const nx = it.x + snap(x - it.x); const ny = it.y + snap(y - it.y);
    if (nx === it.x && ny === it.y) { this.update3D(); return; } // put the 3D box back on its grid position
    this.pushUndo();
    it.x = nx; it.y = ny;
    this.sel = { type, id };
    this.changed();
  }

  async toggle3D() {
    if (this.v3d || this.loading3d) { this.close3D(); return; }
    this.loading3d = true;
    this.btn3d.setAttribute('aria-pressed', 'true');
    this.canvasWrap.hidden = true;
    if (this.zoomGroup) this.zoomGroup.hidden = true;
    this.view3dHost.hidden = false;
    this.view3dHost.replaceChildren(h('p', { class: 'muted small view3d-msg' }, 'Loading 3D view…'));
    try {
      const [{ View3D, webglAvailable }, { sceneModel }] = await Promise.all([import('./view3d.js'), import('./scene-model.js')]);
      if (!this.loading3d) return; // closed while loading
      if (!webglAvailable()) {
        this.view3dHost.replaceChildren(h('p', { class: 'notice notice-info view3d-msg' }, 'Your browser cannot show 3D (WebGL is off or unsupported). The 2D plan still works.'));
        return;
      }
      this.sceneModel = sceneModel;
      const stage = h('div', { class: 'view3d-stage' });
      const hint = h('span', { class: 'muted small' }, this.readOnly ? 'Drag to orbit · scroll or pinch to zoom · right-drag to pan. Conceptual, not to construction accuracy.' : 'Drag furniture to move it (undo works) · drag elsewhere to orbit · scroll or pinch to zoom. Conceptual, not to construction accuracy.');
      const hold = (label, title, action, ic) => {
        const b = this.btn(label, title, null, ic);
        const on = (e) => { e.preventDefault(); this.v3d && this.v3d.press(action, true); };
        const off = () => this.v3d && this.v3d.press(action, false);
        b.addEventListener('pointerdown', on);
        for (const ev of ['pointerup', 'pointerleave', 'pointercancel']) b.addEventListener(ev, off);
        return b;
      };
      const pad = h('div', { class: 'view3d-pad', role: 'group', 'aria-label': 'Walk controls (hold)', hidden: true },
        hold(null, 'Turn left', 'turnl', 'undo'), hold('Forward', 'Walk forward', 'fwd', null),
        hold('Back', 'Walk back', 'back', null), hold(null, 'Turn right', 'turnr', 'redo'));
      const walkBtn = this.btn('Walk', 'Walk through at eye height', () => {
        if (!this.v3d) return;
        const walking = this.v3d.mode !== 'walk';
        this.v3d.setMode(walking ? 'walk' : 'orbit');
        walkBtn.setAttribute('aria-pressed', String(walking));
        pad.hidden = !walking;
        if (walking) stage.scrollIntoView({ block: 'nearest' }); // the hold buttons sit at the bottom of the view
        hint.textContent = walking ? 'Drag to look · W/S or ↑/↓ to walk · A/D to step aside · Q/E or ←/→ to turn. Doors are open; walls stop you.'
          : this.readOnly ? 'Drag to orbit · scroll or pinch to zoom · right-drag to pan. Conceptual, not to construction accuracy.' : 'Drag furniture to move it (undo works) · drag elsewhere to orbit · scroll or pinch to zoom. Conceptual, not to construction accuracy.';
      }, 'directions_walk');
      walkBtn.setAttribute('aria-pressed', 'false');
      const orbitFirst = (fn) => () => {
        if (!this.v3d) return;
        if (this.v3d.mode === 'walk') walkBtn.click();
        fn();
      };
      const bar = h('div', { class: 'view3d-bar', role: 'toolbar', 'aria-label': '3D view controls' },
        this.btn('Reset', 'Reset the 3D camera', orbitFirst(() => this.v3d.resetView()), 'restart_alt'),
        this.btn('Top', 'View from above', orbitFirst(() => this.v3d.topView()), 'map'),
        walkBtn,
        this.opts.onRenderView ? this.btn('Render this view', 'Make a concept render from this camera (1 credit)',
          (e) => this.v3d && this.opts.onRenderView(this.v3d.cameraPose(), this.getGeometry(), e.currentTarget), 'videocam') : null,
        hint);
      stage.append(pad); // overlaid on the view so it is always reachable
      this.view3dHost.replaceChildren(bar, stage);
      this.v3d = new View3D(stage);
      if (!this.readOnly) this.v3d.onDragItem = (type, id, x, y) => this.moveItem(type, id, x, y);
      this.update3D(false);
    } catch (ex) {
      this.view3dHost.replaceChildren(h('p', { class: 'notice notice-error view3d-msg' }, `The 3D view could not load: ${ex.message}`));
    } finally {
      this.loading3d = false;
    }
  }

  close3D() {
    this.loading3d = false;
    if (this.v3d) { this.v3d.dispose(); this.v3d = null; }
    if (!this.view3dHost) return;
    this.view3dHost.hidden = true;
    this.view3dHost.replaceChildren();
    this.canvasWrap.hidden = false;
    if (this.zoomGroup) this.zoomGroup.hidden = false;
    this.btn3d.setAttribute('aria-pressed', 'false');
    this.render();
  }

  getGeometry() { return JSON.parse(JSON.stringify(this.g)); }

  setGeometry(g, keepHistory = false) {
    if (keepHistory) this.pushUndo();
    else { this.undoStack = []; this.redoStack = []; }
    this.g = normalize(g);
    this.sel = null;
    this.changed();
  }

  // ---------- DOM ----------
  buildDom(host) {
    this.status = h('p', { class: 'editor-status', 'aria-live': 'polite' });
    this.svg = s('svg', { class: 'plan-svg', tabindex: '0', role: 'application', 'aria-label': 'Floor plan canvas. Arrow keys move the selection, Delete removes it, R rotates furniture.' });
    this.svg.addEventListener('pointerdown', (e) => this.onDown(e));
    this.svg.addEventListener('pointermove', (e) => this.onMove(e));
    this.svg.addEventListener('pointerup', (e) => this.onUp(e));
    this.svg.addEventListener('pointercancel', (e) => this.onUp(e));
    this.svg.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    this.svg.addEventListener('keydown', (e) => this.onKey(e));

    this.btn3d = this.btn('3D', 'Show the plan in 3D', () => this.toggle3D(), 'view_in_ar');
    this.btn3d.setAttribute('aria-pressed', 'false');
    const viewGroup = h('div', { class: 'btn-group' }, this.btn3d);
    const zoomBtns = [
      this.btn(null, 'Zoom out', () => this.zoom(1.25), 'remove'),
      this.btn(null, 'Zoom in', () => this.zoom(1 / 1.25), 'add'),
      this.btn('Fit', 'Fit plan to view', () => { this.fit(); this.render(); }, 'fit_screen'),
    ];
    let toolbar = null;
    if (!this.readOnly) {
      this.toolBtns = {};
      const tools = [['select', 'Select / move', 'V', 'near_me', 'Select'], ['wall', 'Draw wall', 'W', 'draw', 'Wall'], ['door', 'Add door', 'D', 'sensor_door', 'Door'],
        ['window', 'Add window', 'O', 'window', 'Window'], ['room', 'Add room', 'P', 'meeting_room', 'Room']];
      toolbar = h('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': 'Plan tools' },
        h('div', { class: 'btn-group tool-group' }, tools.map(([t, label, key, ic, short]) => {
          const b = this.btn([h('span', null, short), h('kbd', null, key)], `${label} (${key})`, () => this.setTool(t), ic);
          b.setAttribute('aria-pressed', String(t === this.tool));
          this.toolBtns[t] = b;
          return b;
        })),
        h('div', { class: 'btn-group' },
          (this.undoBtn = this.btn(null, 'Undo (Ctrl+Z)', () => this.undo(), 'undo')),
          (this.redoBtn = this.btn(null, 'Redo (Ctrl+Shift+Z)', () => this.redo(), 'redo'))),
        (this.zoomGroup = h('div', { class: 'btn-group' }, zoomBtns)),
        viewGroup,
        h('span', { class: 'tool-chip' }, icon('straighten', 16), `Snap ${SNAP} mm`));
    } else {
      toolbar = h('div', { class: 'editor-toolbar', role: 'toolbar', 'aria-label': 'View controls' }, (this.zoomGroup = h('div', { class: 'btn-group' }, zoomBtns)), viewGroup);
    }
    this.view3dHost = h('div', { class: 'view3d', hidden: true });
    const showPanel = this.opts.panel !== false;
    this.selBar = h('div', { class: 'sel-bar', role: 'group', 'aria-label': 'Selection', hidden: true });
    this.scaleLine = h('p', { class: 'sheet-scale' });
    const sheet = showPanel ? h('div', { class: 'sheet-head' },
      h('div', { class: 'row gap wrap' }, h('span', { class: 'sheet-chip' }, this.opts.sheet || 'Plan'), h('h2', { class: 'sheet-title' }, this.opts.title || 'Floor plan')),
      this.scaleLine) : null;
    this.panel = h('aside', { class: 'editor-panel', 'aria-label': 'Selection and catalog' });
    if (showPanel) this.buildTabs();
    this.root = h('div', { class: `editor ${showPanel ? '' : 'editor-nopanel'}` },
      h('div', { class: 'editor-main' },
        toolbar,
        h('p', { class: 'small-screen-hint' }, 'The plan editor works best on a larger screen; drag the empty canvas to pan.'),
        h('div', { class: 'editor-canvas' }, sheet, (this.canvasWrap = h('div', { class: 'canvas-wrap' }, this.svg, this.selBar)), this.view3dHost, this.status)),
      showPanel ? this.panel : null);
    host.append(this.root);
    this.renderPanel();
    this.updateStatus();
  }

  buildTabs() {
    const ro = this.readOnly;
    const defs = [this.opts.wizard && !ro ? ['wizard', 'Room wizard'] : null, !ro && this.catalog.length ? ['library', 'Library'] : null,
      ['stats', 'Space stats'], this.opts.versions ? ['versions', 'Versions'] : null].filter(Boolean);
    this.selBox = h('section', { class: 'panel-sel' });
    this.tabs = {};
    const list = h('div', { class: 'panel-tabs', role: 'tablist', 'aria-label': 'Editor panel' });
    const bodies = defs.map(([k, label]) => {
      const tab = h('button', { type: 'button', role: 'tab', id: `${this.uid}-tab-${k}`, 'aria-controls': `${this.uid}-tp-${k}`, class: 'panel-tab', onclick: () => this.showTab(k) }, label);
      const body = h('div', { role: 'tabpanel', id: `${this.uid}-tp-${k}`, 'aria-labelledby': tab.id, class: 'tab-body', tabindex: '0' });
      if (k === 'versions') body.append(this.opts.versions);
      this.tabs[k] = { tab, body };
      list.append(tab);
      return body;
    });
    list.addEventListener('keydown', (e) => {
      const keys = Object.keys(this.tabs);
      const i = keys.indexOf(this.activeTab);
      const j = { ArrowRight: i + 1, ArrowLeft: i - 1, Home: 0, End: keys.length - 1 }[e.key];
      if (j === undefined) return;
      e.preventDefault();
      const k = keys[(j + keys.length) % keys.length];
      this.showTab(k);
      this.tabs[k].tab.focus();
    });
    this.panel.append(this.selBox, list, ...bodies);
    const want = this.opts.initialTab;
    this.showTab(this.tabs[want] ? want : this.tabs.library ? 'library' : 'stats');
  }

  showTab(k) {
    if (!this.tabs || !this.tabs[k]) return;
    this.activeTab = k;
    for (const [key, { tab, body }] of Object.entries(this.tabs)) {
      const on = key === k;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
      body.hidden = !on;
    }
    // the wizard is rebuilt on every visit so its "replaces the drawing" notice matches the current plan
    if (k === 'wizard') this.tabs.wizard.body.replaceChildren(this.opts.wizard(this));
  }

  btn(label, title, onClick, ic) {
    return h('button', { type: 'button', class: 'btn btn-small', title, 'aria-label': title, onclick: onClick }, ic ? icon(ic, 18) : null, label);
  }

  setTool(t) {
    this.tool = t;
    this.draft = null;
    for (const [k, b] of Object.entries(this.toolBtns || {})) b.setAttribute('aria-pressed', String(k === t));
    this.updateStatus();
    this.render();
    this.svg.focus({ preventScroll: true });
  }

  updateStatus() {
    const msg = this.readOnly ? 'Read-only view. Drag to pan, scroll or use the buttons to zoom.' : {
      select: 'Select: click an item to edit it, drag to move. Drag empty space to pan.',
      wall: this.draft ? 'Wall: click the end point. Keep clicking to chain walls; press Esc to stop.' : 'Wall: click the start point (snaps to a 100 mm grid).',
      door: 'Door: click on a wall to place a door, then drag it along the wall.',
      window: 'Window: click on a wall to place a window, then drag it along the wall.',
      room: this.draft ? `Room: ${this.draft.points.length} corner(s). Click the first corner or press Enter to close; Esc cancels.` : 'Room: click each corner of the room.',
    }[this.tool];
    this.status.textContent = msg;
    if (this.undoBtn) {
      this.undoBtn.disabled = !this.undoStack.length;
      this.redoBtn.disabled = !this.redoStack.length;
    }
  }

  // ---------- history ----------
  pushUndo() {
    this.undoStack.push(JSON.stringify(this.g));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  undo() {
    if (!this.undoStack.length) return;
    this.redoStack.push(JSON.stringify(this.g));
    this.g = JSON.parse(this.undoStack.pop());
    this.sel = null;
    this.changed();
  }
  redo() {
    if (!this.redoStack.length) return;
    this.undoStack.push(JSON.stringify(this.g));
    this.g = JSON.parse(this.redoStack.pop());
    this.sel = null;
    this.changed();
  }
  changed() {
    if (this.sel && !this.find(this.sel.type, this.sel.id)) this.sel = null;
    this.render();
    this.renderPanel();
    this.updateStatus();
    this.update3D();
    if (this.opts.onChange) this.opts.onChange(this.getGeometry());
  }

  find(type, id) { return (this.g[type] || []).find((e) => e.id === id); }

  // ---------- view ----------
  fit() {
    const xs = []; const ys = [];
    for (const w of this.g.walls) { xs.push(w.a[0], w.b[0]); ys.push(w.a[1], w.b[1]); }
    for (const r of this.g.rooms) for (const p of r.polygon) { xs.push(p[0]); ys.push(p[1]); }
    for (const f of [...this.g.furniture, ...this.g.fixtures]) { xs.push(f.x, f.x + f.w); ys.push(f.y, f.y + f.d); }
    if (!xs.length) { this.vb = { x: -1000, y: -1000, w: 12000, h: 9000 }; return; }
    const minX = Math.min(...xs); const maxX = Math.max(...xs); const minY = Math.min(...ys); const maxY = Math.max(...ys);
    const pad = Math.max(maxX - minX, maxY - minY, 2000) * 0.12;
    this.vb = { x: minX - pad, y: minY - pad, w: maxX - minX + 2 * pad, h: maxY - minY + 2 * pad };
  }
  zoom(f, about) {
    const c = about || [this.vb.x + this.vb.w / 2, this.vb.y + this.vb.h / 2];
    const nf = clamp(this.vb.w * f, 500, 250000) / this.vb.w;
    this.vb = { x: c[0] - (c[0] - this.vb.x) * nf, y: c[1] - (c[1] - this.vb.y) * nf, w: this.vb.w * nf, h: this.vb.h * nf };
    this.render();
  }
  toPlan(e) {
    const m = this.svg.getScreenCTM();
    if (!m) return [0, 0];
    const p = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [p.x, p.y];
  }
  mmPerPx() {
    const m = this.svg.getScreenCTM();
    return m && m.a ? 1 / m.a : this.vb.w / 800;
  }
  center() { return [snap(this.vb.x + this.vb.w / 2), snap(this.vb.y + this.vb.h / 2)]; }

  // ---------- rendering ----------
  render() {
    const px = this.mmPerPx();
    const fs = 12 * px;
    const { x, y, w, h: hh } = this.vb;
    this.svg.setAttribute('viewBox', `${x} ${y} ${w} ${hh}`);
    const id = (n) => `${this.uid}-${n}`;
    const defs = s('defs', null,
      s('pattern', { id: id('g1'), width: 100, height: 100, patternUnits: 'userSpaceOnUse' },
        s('path', { d: 'M 100 0 L 0 0 0 100', class: 'grid-minor' })),
      s('pattern', { id: id('g2'), width: 1000, height: 1000, patternUnits: 'userSpaceOnUse' },
        s('rect', { width: 1000, height: 1000, fill: `url(#${id('g1')})` }),
        s('path', { d: 'M 1000 0 L 0 0 0 1000', class: 'grid-major' })),
      s('pattern', { id: id('g3'), width: 1000, height: 1000, patternUnits: 'userSpaceOnUse' },
        s('path', { d: 'M 1000 0 L 0 0 0 1000', class: 'grid-major' })));
    // the 100 mm grid is only drawn when zoomed in enough to be readable
    const bg = s('rect', { x: -LIMIT, y: -LIMIT, width: 2 * LIMIT, height: 2 * LIMIT, fill: `url(#${id(px < 25 ? 'g2' : 'g3')})` });
    const isSel = (type, eid) => this.sel && this.sel.type === type && this.sel.id === eid;
    const cls = (base, type, eid) => `${base}${isSel(type, eid) ? ' sel' : ''}${this.highlight.has(eid) ? ' hl' : ''}`;

    const rooms = s('g', null, this.g.rooms.map((r) => {
      const pts = r.polygon;
      const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
      return s('g', { 'data-kind': 'rooms', 'data-id': r.id, class: cls(`room room-${r.kind}`, 'rooms', r.id) },
        s('polygon', { points: pts.map((p) => p.join(',')).join(' ') }),
        s('text', { x: cx, y: cy, 'font-size': fs * 1.1, 'text-anchor': 'middle', class: 'room-label' }, r.name || r.kind),
        s('text', { x: cx, y: cy + fs * 1.4, 'font-size': fs * 0.9, 'text-anchor': 'middle', class: 'room-area' }, `${(polygonArea(pts) / 1e6).toFixed(1)} m²`));
    }));

    const hitW = 14 * px;
    const walls = s('g', null, this.g.walls.map((wl) => s('g', { 'data-kind': 'walls', 'data-id': wl.id, class: cls(`wall${wl.structural ? ' structural' : ''}`, 'walls', wl.id) },
      s('line', { x1: wl.a[0], y1: wl.a[1], x2: wl.b[0], y2: wl.b[1], 'stroke-width': wl.thickness, class: 'wall-line' }),
      s('line', { x1: wl.a[0], y1: wl.a[1], x2: wl.b[0], y2: wl.b[1], 'stroke-width': Math.max(wl.thickness, hitW), class: 'hit' }))));

    const openings = s('g', null, this.g.openings.map((o) => {
      const wl = this.find('walls', o.wall_id);
      if (!wl) return null;
      const L = len(wl.a, wl.b);
      const d = [(wl.b[0] - wl.a[0]) / L, (wl.b[1] - wl.a[1]) / L];
      const n = [-d[1], d[0]];
      const p1 = [wl.a[0] + d[0] * o.offset, wl.a[1] + d[1] * o.offset];
      const p2 = [p1[0] + d[0] * o.width, p1[1] + d[1] * o.width];
      const t = wl.thickness;
      const parts = [s('line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], 'stroke-width': t + 2 * px, class: 'opening-gap' })];
      if (o.kind === 'door') {
        const leaf = [p1[0] + n[0] * o.width, p1[1] + n[1] * o.width];
        parts.push(s('line', { x1: p1[0], y1: p1[1], x2: leaf[0], y2: leaf[1], class: 'door-leaf' }));
        parts.push(s('path', { d: `M ${leaf[0]} ${leaf[1]} A ${o.width} ${o.width} 0 0 0 ${p2[0]} ${p2[1]}`, class: 'door-swing' }));
      } else {
        for (const k of [-0.25, 0.25]) {
          parts.push(s('line', { x1: p1[0] + n[0] * t * k, y1: p1[1] + n[1] * t * k, x2: p2[0] + n[0] * t * k, y2: p2[1] + n[1] * t * k, class: 'window-pane' }));
        }
      }
      parts.push(s('line', { x1: p1[0], y1: p1[1], x2: p2[0], y2: p2[1], 'stroke-width': Math.max(t, hitW), class: 'hit' }));
      return s('g', { 'data-kind': 'openings', 'data-id': o.id, class: cls(`opening opening-${o.kind}`, 'openings', o.id) }, parts);
    }));

    const item = (type, it, label) => {
      const cx = it.x + it.w / 2; const cy = it.y + it.d / 2;
      return s('g', { 'data-kind': type, 'data-id': it.id, class: cls(type === 'fixtures' ? 'fixture' : 'furn', type, it.id), transform: `rotate(${it.rot || 0} ${cx} ${cy})` },
        s('rect', { x: it.x, y: it.y, width: it.w, height: it.d, rx: Math.min(it.w, it.d) * 0.06 }),
        s('text', { x: cx, y: cy, 'font-size': Math.min(fs, it.w / 6), 'text-anchor': 'middle', 'dominant-baseline': 'middle', class: 'item-label' }, label));
    };
    const fixtures = s('g', null, this.g.fixtures.map((f) => item('fixtures', f, f.kind)));
    const furniture = s('g', null, this.g.furniture.map((f) => item('furniture', f, f.label || this.catalogName(f.catalog_key))));

    const overlay = s('g', { class: 'overlay' });
    const selWall = this.sel && this.sel.type === 'walls' && this.find('walls', this.sel.id);
    if (selWall) {
      overlay.append(this.dimension(selWall.a, selWall.b, fs, selWall.thickness));
      if (!this.readOnly) {
        for (const end of ['a', 'b']) overlay.append(s('circle', { cx: selWall[end][0], cy: selWall[end][1], r: 7 * px, class: 'handle', 'data-kind': 'handle', 'data-end': end }));
      }
    }
    if (this.draft && this.cursor) {
      if (this.tool === 'wall') {
        overlay.append(s('line', { x1: this.draft.a[0], y1: this.draft.a[1], x2: this.cursor[0], y2: this.cursor[1], class: 'draft-line', 'stroke-width': 100 }));
        if (!same(this.draft.a, this.cursor)) overlay.append(this.dimension(this.draft.a, this.cursor, fs, 100));
      } else if (this.tool === 'room') {
        const pts = [...this.draft.points, this.cursor];
        overlay.append(s('polyline', { points: pts.map((p) => p.join(',')).join(' '), class: 'draft-room' }));
        for (const p of this.draft.points) overlay.append(s('circle', { cx: p[0], cy: p[1], r: 4 * px, class: 'draft-pt' }));
      }
    }
    if (this.cursor && !this.readOnly && this.tool !== 'select') overlay.append(s('circle', { cx: this.cursor[0], cy: this.cursor[1], r: 4 * px, class: 'cursor-pt' }));

    this.svg.replaceChildren(defs, bg, rooms, walls, openings, fixtures, furniture, overlay);
  }

  dimension(a, b, fs, offset) {
    const L = len(a, b);
    const n = [-(b[1] - a[1]) / L, (b[0] - a[0]) / L];
    const off = offset / 2 + fs * 1.2;
    const mx = (a[0] + b[0]) / 2 + n[0] * off; const my = (a[1] + b[1]) / 2 + n[1] * off;
    return s('g', { class: 'dim' },
      s('line', { x1: a[0] + n[0] * off, y1: a[1] + n[1] * off, x2: b[0] + n[0] * off, y2: b[1] + n[1] * off }),
      s('text', { x: mx, y: my, 'font-size': fs, 'text-anchor': 'middle', 'dominant-baseline': 'middle' }, `${Math.round(L)} mm`));
  }

  catalogName(key) {
    const c = this.catalog.find((i) => i.key === key);
    return c ? c.name : key;
  }

  // ---------- pointer ----------
  onDown(e) {
    if (e.button !== 0) return;
    this.svg.focus({ preventScroll: true });
    const p = this.toPlan(e);
    const sp = [clamp(snap(p[0]), -LIMIT, LIMIT), clamp(snap(p[1]), -LIMIT, LIMIT)];
    const target = e.target.closest('[data-kind]');
    const kind = target && target.dataset.kind;
    this.svg.setPointerCapture(e.pointerId);

    if (this.readOnly || this.tool === 'select') {
      if (!this.readOnly && kind === 'handle') {
        this.startEndpointDrag(this.sel.id, [target.dataset.end], p);
      } else if (target && kind !== 'handle') {
        this.select(kind, target.dataset.id);
        if (!this.readOnly) {
          if (kind === 'walls') this.startEndpointDrag(target.dataset.id, ['a', 'b'], p);
          else if (kind === 'openings') this.drag = { type: 'opening', id: target.dataset.id, start: p, moved: false };
          else this.drag = { type: 'move', kind, id: target.dataset.id, start: p, orig: JSON.stringify(this.find(kind, target.dataset.id)), moved: false };
        }
      } else {
        if (this.sel) this.select(null);
        const m = this.svg.getScreenCTM();
        this.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vb: { ...this.vb }, scale: m ? m.a : 1 };
      }
      return;
    }
    if (this.tool === 'wall') {
      if (!this.draft) this.draft = { a: sp };
      else if (!same(sp, this.draft.a)) {
        this.pushUndo();
        const wl = { id: newId(this.g, 'w'), a: this.draft.a, b: sp, thickness: 100, structural: false };
        this.g.walls.push(wl);
        this.draft = { a: sp };
        this.changed();
      }
      this.updateStatus();
      this.render();
    } else if (this.tool === 'door' || this.tool === 'window') {
      const wallId = kind === 'walls' ? target.dataset.id : kind === 'openings' ? this.find('openings', target.dataset.id).wall_id : null;
      if (!wallId) { toast('Click directly on a wall to place it.'); return; }
      const wl = this.find('walls', wallId);
      const L = len(wl.a, wl.b);
      const width = Math.min(this.tool === 'door' ? 900 : 1200, Math.floor(L));
      this.pushUndo();
      const o = { id: newId(this.g, 'o'), wall_id: wallId, offset: 0, width, kind: this.tool };
      this.g.openings.push(o);
      this.placeOpening(o, p);
      this.sel = { type: 'openings', id: o.id };
      this.drag = { type: 'opening', id: o.id, moved: true };
      this.changed();
    } else if (this.tool === 'room') {
      const pts = this.draft ? this.draft.points : [];
      if (pts.length >= 3 && len(sp, pts[0]) < 1) { this.finishRoom(); return; }
      if (pts.length && same(sp, pts[pts.length - 1])) return;
      this.draft = { points: [...pts, sp] };
      this.updateStatus();
      this.render();
    }
  }

  startEndpointDrag(wallId, ends, p) {
    const wl = this.find('walls', wallId);
    const moving = [];
    for (const end of ends) {
      const pt = wl[end];
      for (const other of this.g.walls) for (const e2 of ['a', 'b']) if (same(other[e2], pt)) moving.push({ id: other.id, end: e2, orig: [...other[e2]] });
    }
    // room corners sitting on a moved wall endpoint (within NEAR mm) move with it, so fill + area follow the wall
    const rooms = [];
    for (const r of this.g.rooms) r.polygon.forEach((q, i) => { if (moving.some((m) => len(m.orig, q) <= NEAR)) rooms.push({ id: r.id, i, orig: [...q] }); });
    this.drag = { type: 'endpoints', start: p, moving, rooms, moved: false };
  }

  onMove(e) {
    const p = this.toPlan(e);
    if (!this.drag) {
      if (!this.readOnly && this.tool !== 'select') { this.cursor = [snap(p[0]), snap(p[1])]; this.render(); }
      return;
    }
    const d = this.drag;
    if (d.type === 'pan') {
      this.vb = { ...d.vb, x: d.vb.x - (e.clientX - d.sx) / d.scale, y: d.vb.y - (e.clientY - d.sy) / d.scale };
      this.render();
      return;
    }
    if (!d.moved) {
      if (len(p, d.start) < 50) return;
      this.pushUndo();
      d.moved = true;
    }
    if (d.type === 'opening') {
      this.placeOpening(this.find('openings', d.id), p);
    } else if (d.type === 'move') {
      const dx = snap(p[0] - d.start[0]); const dy = snap(p[1] - d.start[1]);
      const orig = JSON.parse(d.orig);
      const it = this.find(d.kind, d.id);
      if (d.kind === 'rooms') it.polygon = orig.polygon.map((q) => [clamp(q[0] + dx, -LIMIT, LIMIT), clamp(q[1] + dy, -LIMIT, LIMIT)]);
      else { it.x = clamp(orig.x + dx, -LIMIT, LIMIT - it.w); it.y = clamp(orig.y + dy, -LIMIT, LIMIT - it.d); }
    } else if (d.type === 'endpoints') {
      const dx = snap(p[0] - d.start[0]); const dy = snap(p[1] - d.start[1]);
      const prev = d.moving.map((m) => [...this.find('walls', m.id)[m.end]]);
      const prevRooms = d.rooms.map((c) => this.find('rooms', c.id).polygon[c.i]);
      const shift = (q) => [clamp(q[0] + dx, -LIMIT, LIMIT), clamp(q[1] + dy, -LIMIT, LIMIT)];
      for (const m of d.moving) this.find('walls', m.id)[m.end] = shift(m.orig);
      for (const c of d.rooms) this.find('rooms', c.id).polygon[c.i] = shift(c.orig);
      const touched = new Set(d.moving.map((m) => m.id));
      if ([...touched].some((id) => { const wl = this.find('walls', id); return len(wl.a, wl.b) < 1; })) {
        d.moving.forEach((m, i) => { this.find('walls', m.id)[m.end] = prev[i]; });
        d.rooms.forEach((c, i) => { this.find('rooms', c.id).polygon[c.i] = prevRooms[i]; });
      }
      this.fitOpenings(touched);
    }
    this.render();
  }

  onUp(e) {
    if (this.svg.hasPointerCapture(e.pointerId)) this.svg.releasePointerCapture(e.pointerId);
    const d = this.drag;
    this.drag = null;
    if (d && d.moved) this.changed();
  }

  onWheel(e) {
    e.preventDefault();
    this.zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, this.toPlan(e));
  }

  onKey(e) {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (!this.readOnly) (e.shiftKey ? this.redo() : this.undo()); return; }
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); if (!this.readOnly) this.redo(); return; }
    if (mod || e.altKey) return;
    if (e.key === '+' || e.key === '=') { this.zoom(1 / 1.25); return; }
    if (e.key === '-') { this.zoom(1.25); return; }
    if (this.readOnly) return;
    const keys = { v: 'select', w: 'wall', d: 'door', o: 'window', p: 'room' };
    if (keys[e.key.toLowerCase()]) { this.setTool(keys[e.key.toLowerCase()]); return; }
    if (e.key === 'Escape') { this.draft = null; this.updateStatus(); this.render(); return; }
    if (e.key === 'Enter' && this.tool === 'room' && this.draft) { e.preventDefault(); this.finishRoom(); return; }
    if (!this.sel) return;
    if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); this.deleteSelected(); return; }
    if (e.key.toLowerCase() === 'r') { this.rotateSelected(); return; }
    const arrows = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (arrows[e.key]) { e.preventDefault(); this.nudge(arrows[e.key][0] * SNAP, arrows[e.key][1] * SNAP); }
  }

  // ---------- mutations ----------
  placeOpening(o, p) {
    const wl = this.find('walls', o.wall_id);
    const L = len(wl.a, wl.b);
    const t = ((p[0] - wl.a[0]) * (wl.b[0] - wl.a[0]) + (p[1] - wl.a[1]) * (wl.b[1] - wl.a[1])) / L;
    o.offset = clamp(snap(t - o.width / 2, 50), 0, Math.max(0, L - o.width));
  }

  fitOpenings(wallIds) {
    for (const o of this.g.openings) {
      if (!wallIds.has(o.wall_id)) continue;
      const wl = this.find('walls', o.wall_id);
      const L = Math.floor(len(wl.a, wl.b));
      o.width = Math.max(1, Math.min(o.width, L));
      o.offset = clamp(o.offset, 0, Math.max(0, L - o.width));
    }
  }

  finishRoom() {
    const pts = this.draft ? this.draft.points : [];
    if (pts.length < 3 || polygonArea(pts) < 1) { toast('A room needs at least three corners that enclose an area.', 'error'); return; }
    this.pushUndo();
    const r = { id: newId(this.g, 'r'), name: `Room ${this.g.rooms.length + 1}`, kind: 'other', polygon: pts };
    this.g.rooms.push(r);
    this.draft = null;
    this.sel = { type: 'rooms', id: r.id };
    this.changed();
  }

  select(type, id) {
    this.sel = type ? { type, id } : null;
    this.render();
    this.renderPanel();
  }

  deleteSelected() {
    if (!this.sel) return;
    const { type, id } = this.sel;
    this.pushUndo();
    this.g[type] = this.g[type].filter((e) => e.id !== id);
    if (type === 'walls') this.g.openings = this.g.openings.filter((o) => o.wall_id !== id);
    this.sel = null;
    this.changed();
  }

  rotateSelected() {
    const it = this.sel && ['furniture', 'fixtures'].includes(this.sel.type) && this.find(this.sel.type, this.sel.id);
    if (!it) return;
    this.pushUndo();
    it.rot = ((it.rot || 0) + 90) % 360;
    this.changed();
  }

  nudge(dx, dy) {
    const { type, id } = this.sel;
    const it = this.find(type, id);
    this.pushUndo();
    if (type === 'walls') { it.a = [it.a[0] + dx, it.a[1] + dy]; it.b = [it.b[0] + dx, it.b[1] + dy]; }
    else if (type === 'rooms') it.polygon = it.polygon.map((q) => [q[0] + dx, q[1] + dy]);
    else if (type === 'openings') { const L = this.wallLen(it.wall_id); it.offset = clamp(it.offset + (dx || dy), 0, L - it.width); }
    else { it.x += dx; it.y += dy; }
    this.changed();
  }

  wallLen(id) { const wl = this.find('walls', id); return wl ? Math.floor(len(wl.a, wl.b)) : 0; }

  placeCatalog(item) {
    this.pushUndo();
    const [cx, cy] = this.center();
    const base = { x: snap(cx - item.width_mm / 2), y: snap(cy - item.depth_mm / 2), w: item.width_mm, d: item.depth_mm, rot: 0 };
    let added;
    if (item.category === 'kitchen' || item.category === 'bathroom') {
      added = { type: 'fixtures', it: { id: newId(this.g, 'x'), kind: CATALOG_FIXTURE[item.key] || 'other', ...base } };
    } else {
      added = { type: 'furniture', it: { id: newId(this.g, 'f'), catalog_key: item.key, label: item.name.slice(0, 100), ...base } };
    }
    this.g[added.type].push(added.it);
    this.sel = { type: added.type, id: added.it.id };
    this.setTool('select');
    this.changed();
    toast(`${item.name} placed in the centre of the view — drag it into position.`);
  }

  // edit a field of the selection from the side panel
  edit(fn) {
    const it = this.find(this.sel.type, this.sel.id);
    this.pushUndo();
    fn(it);
    if (this.sel.type === 'walls') this.fitOpenings(new Set([it.id]));
    this.changed();
  }

  // ---------- side panel ----------
  renderPanel() {
    this.renderSheet();
    this.renderSelBar();
    if (this.opts.panel === false) return;
    const parts = [];
    const all = [];
    for (const k of LAYERS) for (const e of this.g[k]) all.push([`${k}:${e.id}`, `${this.typeTitle(k, e)} · ${this.itemName(k, e)}`]);
    if (all.length) {
      const jump = select([['', 'Choose an element…'], ...all], this.sel ? `${this.sel.type}:${this.sel.id}` : '');
      jump.addEventListener('change', () => {
        const [t, ...rest] = jump.value.split(':');
        this.select(t || null, rest.join(':'));
        this.svg.focus({ preventScroll: true });
      });
      parts.push(field('Select element', jump, 'Then use arrow keys on the canvas to move it.'));
    }
    const it = this.sel && this.find(this.sel.type, this.sel.id);
    if (it) parts.push(this.selectionForm(this.sel.type, it));
    else parts.push(h('p', { class: 'muted small' }, this.readOnly ? 'Select an element to see its details.' : 'Select an element to edit it, or place furniture and fixtures from the Library tab.'));
    this.selBox.replaceChildren(...parts);
    if (this.tabs.library) this.tabs.library.body.replaceChildren(this.catalogList());
    this.tabs.stats.body.replaceChildren(this.statsView());
  }

  itemName(type, e) { return e.name || e.label || (type === 'furniture' ? this.catalogName(e.catalog_key) : '') || e.kind || e.id; }

  typeTitle(type, it) { return { walls: 'Wall', openings: it.kind === 'door' ? 'Door' : 'Window', rooms: 'Room', furniture: 'Furniture', fixtures: 'Fixture' }[type]; }

  totalArea() { return this.g.rooms.reduce((a, r) => a + polygonArea(r.polygon), 0) / 1e6; }

  renderSheet() {
    const n = this.g.rooms.length;
    this.scaleLine.textContent = `Grid ${SNAP} mm · major grid 1 m · ${n} room${n === 1 ? '' : 's'} · ${this.totalArea().toFixed(1)} m² · ${this.g.walls.length} walls`;
  }

  // floating bar over the canvas (Stitch): what is selected plus its quick actions
  renderSelBar() {
    const it = this.sel && this.find(this.sel.type, this.sel.id);
    this.selBar.hidden = !it;
    if (!it) { this.selBar.replaceChildren(); return; }
    const { type } = this.sel;
    const title = this.typeTitle(type, it);
    const actions = [];
    if (!this.readOnly && ['furniture', 'fixtures'].includes(type)) {
      actions.push(h('button', { type: 'button', class: 'btn btn-small btn-ghost', onclick: () => this.rotateSelected() }, icon('rotate_right', 18), 'Rotate 90°'));
    }
    if (!this.readOnly) actions.push(h('button', { type: 'button', class: 'btn btn-small btn-ghost btn-danger', onclick: () => this.deleteSelected() }, icon('delete', 18), `Delete ${title.toLowerCase()}`));
    this.selBar.replaceChildren(h('span', { class: 'sel-dot', 'aria-hidden': 'true' }),
      h('strong', { class: 'sel-name' }, `${title}: ${this.itemName(type, it)}`), h('span', { class: 'sel-tag' }, '(Selected)'), ...actions);
  }

  statsView() {
    const g = this.g;
    const count = (kind) => g.openings.filter((o) => o.kind === kind).length;
    const tile = (label, value) => h('div', { class: 'mini-stat' }, h('span', { class: 'label-mono' }, label), h('strong', null, value));
    return h('section', { class: 'space-stats' },
      h('div', { class: 'mini-stats' }, tile('Room area', `${this.totalArea().toFixed(2)} m²`), tile('Rooms', String(g.rooms.length))),
      h('dl', { class: 'facts' },
        h('dt', null, 'Walls'), h('dd', null, `${g.walls.length} (${g.walls.filter((w) => w.structural).length} structural)`),
        h('dt', null, 'Doors'), h('dd', null, String(count('door'))),
        h('dt', null, 'Windows'), h('dd', null, String(count('window'))),
        h('dt', null, 'Furniture'), h('dd', null, String(g.furniture.length)),
        h('dt', null, 'Fixtures'), h('dd', null, String(g.fixtures.length))),
      g.rooms.length ? h('div', { class: 'table-wrap' }, h('table', null,
        h('thead', null, h('tr', null, ['Room', 'Type', 'Area'].map((x) => h('th', { scope: 'col' }, x)))),
        h('tbody', null, g.rooms.map((r) => h('tr', null, h('td', null, r.name || r.kind), h('td', null, r.kind), h('td', { class: 'mono' }, `${(polygonArea(r.polygon) / 1e6).toFixed(2)} m²`)))))) : h('p', { class: 'muted small' }, 'No rooms yet.'),
      h('p', { class: 'hint' }, 'Areas are computed from the room outlines you drew — conceptual, not surveyed.'));
  }

  numInput(value, onSet, { min = 1, max = 20000, step = 10 } = {}) {
    const inp = h('input', { type: 'number', value: String(Math.round(value)), min, max, step, disabled: this.readOnly, inputmode: 'numeric' });
    inp.addEventListener('change', () => {
      const v = Number(inp.value);
      if (!Number.isFinite(v) || v < min || v > max) { toast(`Enter a value between ${min} and ${max}.`, 'error'); inp.value = String(Math.round(value)); return; }
      this.edit((x) => onSet(x, v));
    });
    return inp;
  }

  selectionForm(type, it) {
    const ro = this.readOnly;
    const rows = [];
    const title = this.typeTitle(type, it);
    if (type === 'walls') {
      const L = len(it.a, it.b);
      rows.push(h('p', { class: 'dim-readout' }, `Length ${Math.round(L)} mm (${(L / 1000).toFixed(2)} m)`));
      rows.push(field('Thickness (mm)', this.numInput(it.thickness, (x, v) => { x.thickness = v; }, { min: 10, max: 1000 })));
      const cb = h('input', { type: 'checkbox', checked: !!it.structural, disabled: ro });
      cb.addEventListener('change', () => this.edit((x) => { x.structural = cb.checked; }));
      rows.push(h('label', { class: 'check' }, cb, ' Structural (load-bearing) wall'));
    } else if (type === 'openings') {
      const kind = select([['door', 'Door'], ['window', 'Window']], it.kind, { disabled: ro });
      kind.addEventListener('change', () => this.edit((x) => { x.kind = kind.value; }));
      rows.push(field('Type', kind));
      const L = this.wallLen(it.wall_id);
      rows.push(field('Width (mm)', this.numInput(it.width, (x, v) => { x.width = Math.min(v, L); x.offset = clamp(x.offset, 0, L - x.width); }, { min: 100, max: Math.max(100, L) })));
      rows.push(field('Distance from wall start (mm)', this.numInput(it.offset, (x, v) => { x.offset = clamp(v, 0, L - x.width); }, { min: 0, max: Math.max(0, L) })));
    } else if (type === 'rooms') {
      const name = h('input', { type: 'text', value: it.name, maxlength: 100, disabled: ro });
      name.addEventListener('change', () => this.edit((x) => { x.name = name.value.trim().slice(0, 100) || 'Room'; }));
      rows.push(field('Name', name));
      const kind = select(ROOM_KINDS.map((k) => [k, k]), it.kind, { disabled: ro });
      kind.addEventListener('change', () => this.edit((x) => { x.kind = kind.value; }));
      rows.push(field('Type', kind));
      rows.push(h('p', { class: 'dim-readout' }, `Area ${(polygonArea(it.polygon) / 1e6).toFixed(2)} m²`));
    } else {
      if (type === 'fixtures') {
        const kind = select(FIXTURE_KINDS.map((k) => [k, k]), it.kind, { disabled: ro });
        kind.addEventListener('change', () => this.edit((x) => { x.kind = kind.value; }));
        rows.push(field('Fixture type', kind));
      } else {
        rows.push(h('p', { class: 'dim-readout' }, this.catalogName(it.catalog_key)));
      }
      rows.push(field('Width (mm)', this.numInput(it.w, (x, v) => { x.w = v; }, { min: 10, max: 10000 })));
      rows.push(field('Depth (mm)', this.numInput(it.d, (x, v) => { x.d = v; }, { min: 10, max: 10000 })));
    }
    // Rotate / Delete live in the floating selection bar over the canvas
    return h('section', { class: 'sel-form' }, h('h3', null, title), rows);
  }

  catalogList() {
    const cats = [...new Set(this.catalog.map((i) => i.category))];
    if (!this.catFilter) this.catFilter = cats[0];
    const filter = select(cats.map((c) => [c, c]), this.catFilter);
    filter.addEventListener('change', () => { this.catFilter = filter.value; this.renderPanel(); });
    const isFixture = ['kitchen', 'bathroom'].includes(this.catFilter);
    return h('section', { class: 'catalog' },
      h('h3', { class: 'sr-only' }, 'Catalog'),
      field('Category', filter, isFixture ? 'Kitchen and bathroom items are placed as fixtures and flag the plan for professional review.' : null),
      h('ul', { class: 'catalog-list' }, this.catalog.filter((i) => i.category === this.catFilter).map((i) => h('li', null,
        h('button', { type: 'button', class: 'catalog-item', onclick: () => this.placeCatalog(i), 'aria-label': `Place ${i.name}` },
          h('span', null, i.name), h('small', null, `${i.width_mm}×${i.depth_mm} mm`))))));
  }
}
