// Plan geometry (mm, y down) -> plain 3D scene data for view3d.js. No Three.js here, so it is unit-testable in node.
export const WALL_H = 2600;
export const DOOR_H = 2100;
export const SILL_H = 900;
export const WIN_TOP = 2100;
const COLORS = { floor: '#d9d2c5', wall: '#f2f0ea', furniture: '#8c8378', fixtures: '#e6ebee' };
const FIXTURE_H = { sink: 900, toilet: 750, shower: 2000, bathtub: 600, stove: 900, fridge: 1800, counter: 900, dishwasher: 850, other: 900 };
const NEAR_ROOM_MM = 1000; // a wall takes the wall finish of a room at most this far from its midpoint

const hex = (c, fallback) => (typeof c === 'string' && /^#[0-9a-f]{6}$/i.test(c) ? c : fallback);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];

function segDist(p, a, b) {
  const dx = b[0] - a[0]; const dy = b[1] - a[1];
  const L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / L2)) : 0;
  return Math.hypot(p[0] - (a[0] + dx * t), p[1] - (a[1] + dy * t));
}

function nearestRoom(rooms, p) {
  let best = null; let bestD = NEAR_ROOM_MM;
  for (const r of rooms) {
    const poly = r.polygon || [];
    for (let i = 0; i < poly.length; i++) {
      const d = segDist(p, poly[i], poly[(i + 1) % poly.length]);
      if (d < bestD) { bestD = d; best = r; }
    }
  }
  return best;
}

/** Wall pieces: solid spans between openings at full height, a lintel over doors, sill + lintel around windows. */
function wallPieces(w, openings, color) {
  const L = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]);
  if (!L) return [];
  const piece = (s, e, z0, z1) => ({ wallId: w.id, a: lerp(w.a, w.b, s / L), b: lerp(w.a, w.b, e / L), z0, z1, thickness: w.thickness || 100, color });
  const out = [];
  let at = 0;
  for (const o of openings.slice().sort((x, y) => x.offset - y.offset)) {
    const s = Math.max(at, Math.min(o.offset, L)); const e = Math.min(L, s + o.width);
    if (e <= s) continue;
    if (s > at) out.push(piece(at, s, 0, WALL_H));
    if (o.kind === 'window') out.push(piece(s, e, 0, SILL_H));
    out.push(piece(s, e, o.kind === 'window' ? WIN_TOP : DOOR_H, WALL_H));
    at = e;
  }
  if (at < L) out.push(piece(at, L, 0, WALL_H));
  return out;
}

/**
 * geometry: plan geometry. opts.finishes: {roomId: {floor: '#hex', wall: '#hex'}}; opts.catalog: [{key, name, height_mm}].
 * Returns {bounds, walls: [{wallId, a, b, z0, z1, thickness, color}], floors: [{id, name, polygon, color}],
 *          items: [{id, type, label, x, y, w, d, h, rot, color}]} in mm.
 */
export function sceneModel(geometry, opts = {}) {
  const g = geometry || {};
  const rooms = g.rooms || []; const walls = g.walls || [];
  const fin = opts.finishes || {};
  const cat = new Map((opts.catalog || []).map((c) => [c.key, c]));
  const byWall = new Map();
  for (const o of g.openings || []) (byWall.get(o.wall_id) || byWall.set(o.wall_id, []).get(o.wall_id)).push(o);

  const wallOut = [];
  for (const w of walls) {
    const room = nearestRoom(rooms, lerp(w.a, w.b, 0.5));
    const color = hex(room && fin[room.id] && fin[room.id].wall, COLORS.wall);
    wallOut.push(...wallPieces(w, byWall.get(w.id) || [], color));
  }
  const floors = rooms.map((r) => ({ id: r.id, name: r.name || r.kind || '', polygon: r.polygon, color: hex(fin[r.id] && fin[r.id].floor, COLORS.floor) }));
  const items = [
    ...(g.furniture || []).map((f) => {
      const c = cat.get(f.catalog_key);
      return { id: f.id, type: 'furniture', label: f.label || (c && c.name) || f.catalog_key, x: f.x, y: f.y, w: f.w, d: f.d, h: (c && c.height_mm) || 750, rot: f.rot || 0, color: COLORS.furniture };
    }),
    ...(g.fixtures || []).map((f) => ({ id: f.id, type: 'fixtures', label: f.kind, x: f.x, y: f.y, w: f.w, d: f.d, h: FIXTURE_H[f.kind] || 900, rot: f.rot || 0, color: COLORS.fixtures })),
  ];

  const xs = []; const ys = [];
  for (const w of walls) { xs.push(w.a[0], w.b[0]); ys.push(w.a[1], w.b[1]); }
  for (const r of rooms) for (const p of r.polygon) { xs.push(p[0]); ys.push(p[1]); }
  for (const i of items) { xs.push(i.x, i.x + i.w); ys.push(i.y, i.y + i.d); }
  const bounds = xs.length ? { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) } : { minX: 0, minY: 0, maxX: 5000, maxY: 4000 };
  return { bounds, walls: wallOut, floors, items };
}
