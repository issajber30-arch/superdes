// Run: node --test frontend/tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import { sceneModel, WALL_H, DOOR_H, SILL_H, WIN_TOP } from '../static/js/editor/scene-model.js';

const wall = (id, a, b, t = 200) => ({ id, a, b, thickness: t, structural: false });
const room = { id: 'r1', name: 'Living', kind: 'living', polygon: [[0, 0], [5000, 0], [5000, 4000], [0, 4000]] };

test('empty plan gives an empty scene with safe bounds', () => {
  const m = sceneModel({});
  assert.deepEqual([m.walls.length, m.floors.length, m.items.length], [0, 0, 0]);
  assert.ok(Number.isFinite(m.bounds.minX) && m.bounds.maxX > m.bounds.minX);
});

test('wall without openings is one full-height piece', () => {
  const m = sceneModel({ walls: [wall('w1', [0, 0], [5000, 0])] });
  assert.equal(m.walls.length, 1);
  assert.deepEqual(m.walls[0], { wallId: 'w1', a: [0, 0], b: [5000, 0], z0: 0, z1: WALL_H, thickness: 200, color: m.walls[0].color });
});

test('door splits the wall and leaves a lintel; window leaves sill and lintel', () => {
  const g = { walls: [wall('w1', [0, 0], [5000, 0])],
    openings: [{ id: 'd', wall_id: 'w1', offset: 1000, width: 900, kind: 'door' }, { id: 'o', wall_id: 'w1', offset: 3000, width: 1200, kind: 'window' }] };
  const p = sceneModel(g).walls.map((w) => [w.a[0], w.b[0], w.z0, w.z1]);
  assert.deepEqual(p, [
    [0, 1000, 0, WALL_H], [1000, 1900, DOOR_H, WALL_H],
    [1900, 3000, 0, WALL_H], [3000, 4200, 0, SILL_H], [3000, 4200, WIN_TOP, WALL_H],
    [4200, 5000, 0, WALL_H]]);
});

test('openings on a diagonal wall follow the wall direction', () => {
  const g = { walls: [wall('w1', [0, 0], [3000, 4000])], openings: [{ id: 'd', wall_id: 'w1', offset: 0, width: 1000, kind: 'door' }] };
  const [lintel] = sceneModel(g).walls;
  assert.equal(lintel.z0, DOOR_H);
  assert.deepEqual(lintel.a, [0, 0]);
  assert.deepEqual(lintel.b.map(Math.round), [600, 800]);
});

test('opening on a missing wall is ignored', () => {
  const m = sceneModel({ walls: [wall('w1', [0, 0], [1000, 0])], openings: [{ id: 'x', wall_id: 'nope', offset: 0, width: 500, kind: 'door' }] });
  assert.equal(m.walls.length, 1);
});

test('floors and walls take finish colours; invalid colours fall back', () => {
  const g = { rooms: [room], walls: [wall('w1', [0, 0], [5000, 0])] };
  const m = sceneModel(g, { finishes: { r1: { floor: '#8a6a4a', wall: '#dde4dd' } } });
  assert.equal(m.floors[0].color, '#8a6a4a');
  assert.equal(m.walls[0].color, '#dde4dd');
  const bad = sceneModel(g, { finishes: { r1: { floor: 'red;x', wall: 'url(x)' } } });
  assert.match(bad.floors[0].color, /^#[0-9a-f]{6}$/i);
  assert.notEqual(bad.floors[0].color, 'red;x');
  assert.notEqual(bad.walls[0].color, 'url(x)');
});

test('furniture uses catalog height; fixtures use a kind default; rotation kept', () => {
  const g = { furniture: [{ id: 'f1', catalog_key: 'sofa', x: 100, y: 200, w: 2000, d: 900, rot: 90 }],
    fixtures: [{ id: 'x1', kind: 'toilet', x: 0, y: 0, w: 400, d: 700, rot: 0 }] };
  const m = sceneModel(g, { catalog: [{ key: 'sofa', name: 'Sofa', height_mm: 850 }] });
  const sofa = m.items.find((i) => i.id === 'f1');
  assert.deepEqual([sofa.type, sofa.h, sofa.rot, sofa.label], ['furniture', 850, 90, 'Sofa']);
  const wc = m.items.find((i) => i.id === 'x1');
  assert.ok(wc.h > 0 && wc.h < WALL_H && wc.type === 'fixtures');
});

test('bounds cover walls, rooms and items', () => {
  const m = sceneModel({ rooms: [room], furniture: [{ id: 'f', catalog_key: 'k', x: 6000, y: 6000, w: 500, d: 500, rot: 0 }] });
  assert.deepEqual([m.bounds.minX, m.bounds.minY, m.bounds.maxX, m.bounds.maxY], [0, 0, 6500, 6500]);
});
