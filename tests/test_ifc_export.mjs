import assert from 'node:assert/strict';
import { buildIfcModel } from '../product/backend/frontend/js/view3d/ifc-export.js';

const model = buildIfcModel({
  walls: [{
    id: 'wall_1',
    start: { x: 10, y: 20 },
    end: { x: 210, y: 20 },
    thickness: 10,
    doors: [{ detection_id: 1, center: { x: 90, y: 20 }, width: 40, height: 10 }],
    windows: [{ detection_id: 2, center: { x: 160, y: 20 }, width: 50, height: 10 }],
  }],
  furniture: [{ class: 'Bett', center: { x: 120, y: 100 }, width: 60, height: 90 }],
}, { scale: 0.02, fileName: 'test.ifc' });

assert.match(model, /^ISO-10303-21;/);
assert.match(model, /FILE_SCHEMA\(\('IFC4'\)\)/);
assert.match(model, /IFCWALL\(/);
assert.match(model, /IFCDOOR\(/);
assert.match(model, /IFCWINDOW\(/);
assert.match(model, /IFCBUILDINGELEMENTPROXY\(/);
assert.match(model, /END-ISO-10303-21;/);
assert.ok(!model.includes('NaN'));

const connectedModel = buildIfcModel({
  walls: [
    {
      id: 'wall_a',
      start: { x: 10, y: 20 },
      end: { x: 210, y: 20 },
      thickness: 10,
      doors: [],
      windows: [],
    },
    {
      id: 'wall_b',
      start: { x: 210, y: 25 },
      end: { x: 210, y: 180 },
      thickness: 10,
      doors: [],
      windows: [],
    },
  ],
  furniture: [],
}, { scale: 0.02, fileName: 'connected.ifc' });

assert.equal((connectedModel.match(/IFCWALL\(/g) || []).length, 1, 'wall geometry exports as one IFC wall system');
assert.match(connectedModel, /'Wall Structure'/);
assert.ok(
  (connectedModel.match(/IFCEXTRUDEDAREASOLID\(/g) || []).length >= 2,
  'wall system contains the real wall solids without junction filler patches',
);

console.log('IFC export tests passed.');
