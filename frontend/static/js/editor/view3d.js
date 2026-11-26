// 3D view of a plan (Three.js, self-hosted). Loaded with import() only when the user opens 3D.
// Plan mm (x, y down) -> scene metres (x, z); y is up.
import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';
import { blocksAt, EYE_H } from './scene-model.js';

const M = 0.001;
const EDGE = 0x2b2a28;

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
}

/** Off-screen snapshots for the dossier: two corner views and a top view, as JPEG data URLs. */
export function captureViews(model, { width = 1200, height = 750 } = {}) {
  const host = document.createElement('div');
  host.style.cssText = `position:fixed;left:-20000px;top:0;width:${width}px;height:${height}px;`;
  document.body.append(host);
  const v = new View3D(host);
  try {
    v.resize();
    v.update(model, false);
    const shots = [];
    v.resetView(); shots.push(v.snapshot());
    v.resetView(true); shots.push(v.snapshot());
    v.topView(); shots.push(v.snapshot());
    return shots;
  } finally {
    v.dispose();
    host.remove();
  }
}

export class View3D {
  /** host: element to fill. */
  constructor(host) {
    this.host = host;
    this.renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setClearColor(0xf4f2ee);
    this.canvas = this.renderer.domElement;
    this.canvas.className = 'view3d-canvas';
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', '3D view of the plan. Drag to orbit, scroll or pinch to zoom, right-drag to pan.');
    host.append(this.canvas);

    this.scene = new THREE.Scene();
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xb9b2a6, 2.2));
    const sun = new THREE.DirectionalLight(0xffffff, 1.6);
    sun.position.set(-6, 12, 8);
    this.scene.add(sun);
    this.camera = new THREE.PerspectiveCamera(50, 1, 0.05, 500);
    this.controls = new OrbitControls(this.camera, this.canvas);
    this.controls.enableDamping = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.02; // never below the floor
    this.controls.addEventListener('change', () => this.draw());
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.model = null;

    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(host);
    this.resize();

    // walk-through state: yaw/pitch in radians (yaw 0 = +x, plan convention), held movement keys
    this.mode = 'orbit';
    this.walk = { yaw: 0, pitch: 0, dirty: false };
    this.held = new Set();
    this.canvas.tabIndex = 0;
    const KEYS = { KeyW: 'fwd', ArrowUp: 'fwd', KeyS: 'back', ArrowDown: 'back', KeyA: 'left', KeyD: 'right', ArrowLeft: 'turnl', ArrowRight: 'turnr', KeyQ: 'turnl', KeyE: 'turnr' };
    this.onKey = (e) => {
      const k = this.mode === 'walk' && KEYS[e.code];
      if (!k) return;
      e.preventDefault();
      if (e.type === 'keydown') this.held.add(k); else this.held.delete(k);
    };
    this.onBlur = () => this.held.clear();
    // keys work anywhere in the 3D area (canvas or its buttons), not only on the focused canvas
    this.keyTarget = host.parentElement || host;
    this.keyTarget.addEventListener('keydown', this.onKey);
    // releases are heard everywhere: focus can leave the 3D area while a key is down (e.g. a button disables itself)
    window.addEventListener('keyup', this.onKey);
    window.addEventListener('blur', this.onBlur);
    this.canvas.addEventListener('blur', this.onBlur);
    let drag = null;
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'walk') return;
      drag = { x: e.clientX, y: e.clientY, id: e.pointerId };
      this.canvas.setPointerCapture(e.pointerId);
      this.canvas.focus({ preventScroll: true });
    });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      this.walk.yaw -= (e.clientX - drag.x) * 0.005;
      this.walk.pitch = Math.max(-1.2, Math.min(1.2, this.walk.pitch + (e.clientY - drag.y) * 0.004));
      drag.x = e.clientX; drag.y = e.clientY;
      this.walk.dirty = true;
    });
    const end = () => { drag = null; };
    this.canvas.addEventListener('pointerup', end);
    this.canvas.addEventListener('pointercancel', end);

    // furniture drag (orbit mode): set onDragItem(type, id, x, y) to enable; x/y = new top-left corner in plan mm
    this.onDragItem = null;
    this.ray = new THREE.Raycaster();
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const aim = (e) => {
      const r = this.canvas.getBoundingClientRect();
      this.ray.setFromCamera(new THREE.Vector2((e.clientX - r.left) / r.width * 2 - 1, -(e.clientY - r.top) / r.height * 2 + 1), this.camera);
    };
    const hitFloor = (e) => { aim(e); return this.ray.ray.intersectPlane(floor, new THREE.Vector3()); };
    const pickItem = (e) => {
      aim(e);
      const items = this.group.children.filter((o) => o.userData.kind === 'furniture' || o.userData.kind === 'fixtures');
      const hit = this.ray.intersectObjects(items, false)[0];
      return hit ? hit.object : null;
    };
    let move = null;
    // capture phase: runs before OrbitControls' own pointerdown on the canvas, so a press on furniture never orbits
    this.canvas.addEventListener('pointerdown', (e) => {
      if (this.mode !== 'orbit' || !this.onDragItem || e.button !== 0) return;
      const obj = pickItem(e); const at = obj && hitFloor(e);
      if (!obj || !at) return;
      this.controls.enabled = false;
      move = { obj, id: e.pointerId, dx: obj.position.x - at.x, dz: obj.position.z - at.z, moved: false };
      this.canvas.setPointerCapture(e.pointerId);
    }, { capture: true });
    this.canvas.addEventListener('pointermove', (e) => {
      if (!move) {
        if (this.mode === 'orbit' && this.onDragItem && e.pointerType === 'mouse') this.canvas.style.cursor = pickItem(e) ? 'move' : '';
        return;
      }
      if (e.pointerId !== move.id) return;
      const at = hitFloor(e);
      if (!at) return;
      const b = this.model.bounds; const pad = 2000 * M; // keep it near the plan even at grazing angles
      move.obj.position.x = Math.min(Math.max(at.x + move.dx, b.minX * M - pad), b.maxX * M + pad);
      move.obj.position.z = Math.min(Math.max(at.z + move.dz, b.minY * M - pad), b.maxY * M + pad);
      move.moved = true;
      this.draw();
    });
    this.canvas.addEventListener('pointerup', (e) => {
      if (!move || e.pointerId !== move.id) return;
      const { obj, moved } = move;
      move = null;
      this.controls.enabled = true;
      if (!moved) return;
      const it = this.model.items.find((i) => i.id === obj.userData.id && i.type === obj.userData.kind);
      if (it) this.onDragItem(it.type, it.id, Math.round(obj.position.x / M - it.w / 2), Math.round(obj.position.z / M - it.d / 2));
    });
    this.canvas.addEventListener('pointercancel', (e) => {
      if (!move || e.pointerId !== move.id) return;
      move = null;
      this.controls.enabled = true;
      this.update(this.model); // put the box back
    });

    let last = performance.now();
    this.loop = () => {
      this.raf = requestAnimationFrame(this.loop);
      const now = performance.now(); const dt = Math.min(0.1, (now - last) / 1000); last = now;
      if (this.mode === 'walk') this.stepWalk(dt);
      else if (this.controls.update()) this.draw();
    };
    this.loop();
  }

  /** 'orbit' (model view) or 'walk' (eye height, cannot pass through walls). */
  setMode(mode) {
    if (!this.model || mode === this.mode) return;
    this.mode = mode;
    this.held.clear();
    this.controls.enabled = mode === 'orbit';
    this.camera.fov = mode === 'walk' ? 70 : 50;
    this.camera.updateProjectionMatrix();
    this.canvas.setAttribute('aria-label', mode === 'walk'
      ? 'Walk-through. Drag to look around; W/S or arrow keys to walk, A/D to step sideways, Q/E or left/right arrows to turn.'
      : '3D view of the plan. Drag to orbit, scroll or pinch to zoom, right-drag to pan.');
    if (mode === 'orbit') { this.resetView(); return; }
    const start = this.walkStart();
    this.camera.position.set(start[0] * M, EYE_H * M, start[1] * M);
    this.walk.yaw = start[2];
    this.walk.pitch = 0;
    this.walk.dirty = true;
    this.canvas.focus({ preventScroll: true });
  }

  /** Start in the room the orbit view looks at (its centre), facing its longer side; [x, y, yaw] in mm/radians. */
  walkStart() {
    const t = [this.controls.target.x / M, this.controls.target.z / M];
    const inside = (poly, p) => {
      let hit = false;
      for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const [xi, yi] = poly[i]; const [xj, yj] = poly[j];
        if ((yi > p[1]) !== (yj > p[1]) && p[0] < (xj - xi) * (p[1] - yi) / (yj - yi) + xi) hit = !hit;
      }
      return hit;
    };
    const floor = this.model.floors.find((f) => f.polygon && inside(f.polygon, t)) || this.model.floors[0];
    if (!floor) return [t[0], t[1], 0];
    const xs = floor.polygon.map((p) => p[0]); const ys = floor.polygon.map((p) => p[1]);
    const w = Math.max(...xs) - Math.min(...xs); const d = Math.max(...ys) - Math.min(...ys);
    return [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2, w >= d ? 0 : Math.PI / 2];
  }

  /** Hold-to-move for on-screen buttons: action is fwd | back | left | right | turnl | turnr. */
  press(action, on) { if (on) this.held.add(action); else this.held.delete(action); }

  stepWalk(dt) {
    const w = this.walk; const h = this.held;
    if (h.has('turnl')) { w.yaw -= 1.6 * dt; w.dirty = true; }
    if (h.has('turnr')) { w.yaw += 1.6 * dt; w.dirty = true; }
    const f = (h.has('fwd') ? 1 : 0) - (h.has('back') ? 1 : 0);
    const s = (h.has('right') ? 1 : 0) - (h.has('left') ? 1 : 0);
    if (f || s) {
      const step = 1400 * dt; // mm per frame at 1.4 m/s
      const cx = Math.cos(w.yaw); const cz = Math.sin(w.yaw);
      const dx = (f * cx - s * cz) * step; const dz = (f * cz + s * cx) * step;
      const x = this.camera.position.x / M; const z = this.camera.position.z / M;
      const free = (nx, nz) => !blocksAt(this.model.walls, nx, nz, 250);
      // slide along walls: try the full step, then each axis alone
      const [nx, nz] = free(x + dx, z + dz) ? [x + dx, z + dz] : free(x + dx, z) ? [x + dx, z] : free(x, z + dz) ? [x, z + dz] : [x, z];
      if (nx !== x || nz !== z) { this.camera.position.x = nx * M; this.camera.position.z = nz * M; w.dirty = true; }
    }
    if (!w.dirty) return;
    w.dirty = false;
    const p = this.camera.position;
    this.camera.lookAt(p.x + Math.cos(w.yaw) * Math.cos(w.pitch), p.y - Math.sin(w.pitch), p.z + Math.sin(w.yaw) * Math.cos(w.pitch));
    this.draw();
  }

  resize() {
    const w = Math.max(1, this.host.clientWidth); const h = Math.max(1, this.host.clientHeight);
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.draw();
  }

  draw() { this.renderer.render(this.scene, this.camera); }

  clear() {
    this.group.traverse((o) => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
    this.group.clear();
  }

  box(w, h, d, color) {
    const geo = new THREE.BoxGeometry(Math.max(w, 0.001), Math.max(h, 0.001), Math.max(d, 0.001));
    const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color, roughness: 0.9 }));
    mesh.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: EDGE, transparent: true, opacity: 0.35 })));
    return mesh;
  }

  /** model: output of sceneModel(). Keeps the camera unless keepView is false. */
  update(model, keepView = true) {
    const first = !this.model;
    this.model = model;
    this.clear();
    for (const f of model.floors) {
      if (!f.polygon || f.polygon.length < 3) continue;
      const shape = new THREE.Shape(f.polygon.map(([x, y]) => new THREE.Vector2(x * M, y * M)));
      const geo = new THREE.ShapeGeometry(shape);
      geo.rotateX(Math.PI / 2); // shape (x, y) -> floor (x, 0, z=y)
      const mesh = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: f.color, roughness: 1, side: THREE.DoubleSide }));
      mesh.position.y = 0.001;
      mesh.userData = { kind: 'floor', id: f.id };
      this.group.add(mesh);
    }
    for (const p of model.walls) {
      const dx = (p.b[0] - p.a[0]) * M; const dz = (p.b[1] - p.a[1]) * M;
      const len = Math.hypot(dx, dz);
      if (!len) continue;
      const mesh = this.box(len, (p.z1 - p.z0) * M, p.thickness * M, p.color);
      mesh.position.set((p.a[0] + p.b[0]) / 2 * M, (p.z0 + p.z1) / 2 * M, (p.a[1] + p.b[1]) / 2 * M);
      mesh.rotation.y = -Math.atan2(dz, dx);
      mesh.userData = { kind: 'wall', id: p.wallId };
      this.group.add(mesh);
    }
    for (const it of model.items) {
      const mesh = this.box(it.w * M, it.h * M, it.d * M, it.color);
      mesh.position.set((it.x + it.w / 2) * M, it.h / 2 * M, (it.y + it.d / 2) * M);
      mesh.rotation.y = -(it.rot || 0) * Math.PI / 180; // plan rotation is clockwise with y down
      mesh.userData = { kind: it.type, id: it.id, label: it.label };
      this.group.add(mesh);
    }
    // ground plane slightly below the floors so the plan reads as a model
    const b = model.bounds;
    const gw = (b.maxX - b.minX) * M + 4; const gd = (b.maxY - b.minY) * M + 4;
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(gw, gd), new THREE.MeshStandardMaterial({ color: 0xe9e5de, roughness: 1 }));
    ground.rotation.x = -Math.PI / 2;
    ground.position.set((b.minX + b.maxX) / 2 * M, -0.002, (b.minY + b.maxY) / 2 * M);
    this.group.add(ground);
    if (first || !keepView) this.resetView();
    this.draw();
  }

  center() {
    const b = this.model.bounds;
    return new THREE.Vector3((b.minX + b.maxX) / 2 * M, 0, (b.minY + b.maxY) / 2 * M);
  }

  span() { const b = this.model.bounds; return Math.max((b.maxX - b.minX) * M, (b.maxY - b.minY) * M, 3); }

  /** Three-quarter view from the south-west corner (or south-east when flip). */
  resetView(flip = false) {
    if (!this.model) return;
    const c = this.center(); const s = this.span();
    this.controls.target.copy(c);
    this.camera.position.set(c.x + (flip ? 1 : -1) * s * 0.8, s * 1.2, c.z + s * 1.35);
    this.controls.update();
    this.draw();
  }

  /** Camera on the plan: x/y in mm, yaw in degrees (0 = +x, 90 = +y), plus the orbit target in mm. */
  cameraPose() {
    const dir = new THREE.Vector3();
    this.camera.getWorldDirection(dir);
    return { x: Math.round(this.camera.position.x / M), y: Math.round(this.camera.position.z / M),
      yaw: Math.round(Math.atan2(dir.z, dir.x) * 180 / Math.PI), target: { x: this.controls.target.x / M, y: this.controls.target.z / M } };
  }

  snapshot(type = 'image/jpeg', quality = 0.85) {
    this.draw();
    return this.canvas.toDataURL(type, quality);
  }

  topView() {
    if (!this.model) return;
    const c = this.center(); const s = this.span();
    this.controls.target.copy(c);
    this.camera.position.set(c.x, s * 1.5, c.z + 0.001);
    this.controls.update();
    this.draw();
  }

  dispose() {
    cancelAnimationFrame(this.raf);
    this.keyTarget.removeEventListener('keydown', this.onKey);
    window.removeEventListener('keyup', this.onKey);
    window.removeEventListener('blur', this.onBlur);
    this.ro.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
