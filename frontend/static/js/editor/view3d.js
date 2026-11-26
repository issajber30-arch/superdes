// 3D view of a plan (Three.js, self-hosted). Loaded with import() only when the user opens 3D.
// Plan mm (x, y down) -> scene metres (x, z); y is up.
import * as THREE from '../vendor/three/three.module.min.js';
import { OrbitControls } from '../vendor/three/OrbitControls.js';

const M = 0.001;
const EDGE = 0x2b2a28;

export function webglAvailable() {
  try {
    const c = document.createElement('canvas');
    return !!(window.WebGLRenderingContext && (c.getContext('webgl2') || c.getContext('webgl')));
  } catch { return false; }
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
    this.loop = () => { this.raf = requestAnimationFrame(this.loop); if (this.controls.update()) this.draw(); };
    this.loop();
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

  resetView() {
    if (!this.model) return;
    const c = this.center(); const s = this.span();
    this.controls.target.copy(c);
    this.camera.position.set(c.x - s * 0.8, s * 1.2, c.z + s * 1.35);
    this.controls.update();
    this.draw();
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
    this.ro.disconnect();
    this.controls.dispose();
    this.clear();
    this.renderer.dispose();
    this.canvas.remove();
  }
}
