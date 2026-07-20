const assert = require('node:assert/strict');
const {
  calculateRooms,
  normalizeFloorplanTopology,
  setScaleFromReferenceWall,
  splitWallsAtIntersections,
} = require('../product/backend/frontend/js/revise/geometry.js');

function wall(id, x1, y1, x2, y2, thickness = 10) {
  return {
    id,
    start: { x: x1, y: y1 },
    end: { x: x2, y: y2 },
    thickness,
    windows: [],
    doors: [],
  };
}

{
  const horizontal = wall('h', 20, 100, 180, 100);
  horizontal.doors.push({ detection_id: 3, center: { x: 150, y: 100 }, width: 24, height: 10 });
  const vertical = wall('v', 100, 20, 100, 180);
  const result = splitWallsAtIntersections([horizontal, vertical]);
  assert.equal(result.crossSections, 1);
  assert.equal(result.walls.length, 4);
  assert.equal(result.walls.reduce((sum, item) => sum + item.doors.length, 0), 1);
  const doorWall = result.walls.find(item => item.doors.length);
  assert.equal(doorWall.doors[0].center.x, 150, 'door keeps its absolute wall position');
}

{
  const horizontal = wall('h', 20, 100, 96, 100, 12);
  const vertical = wall('v', 102, 100, 102, 180, 10);
  const data = { walls: [horizontal, vertical], metadata: {} };
  const result = normalizeFloorplanTopology(data);
  assert.ok(result.snapped >= 1);
  assert.deepEqual(horizontal.end, { x: 102, y: 100 });
  assert.deepEqual(vertical.start, { x: 102, y: 106 });
}

{
  const horizontal = wall('host', 20, 100, 180, 100, 12);
  const vertical = wall('incoming', 100, 100, 100, 180, 10);
  const data = { walls: [horizontal, vertical], metadata: {} };
  const result = normalizeFloorplanTopology(data);
  assert.equal(result.crossSections, 1, 'the host wall is split at the T junction');
  assert.equal(data.walls.length, 3);
  const incoming = data.walls.find(item => item.id === 'incoming');
  assert.deepEqual(incoming.start, { x: 100, y: 106 }, 'incoming wall snaps to lower visible edge');
  const hostSegments = data.walls.filter(item => item.source_wall_id === 'host');
  assert.equal(hostSegments.length, 2);
  assert.ok(hostSegments.every(item => (
    item.start.x === 100 || item.end.x === 100
  )), 'continuous host segments still meet at their centerline');
}

{
  const data = {
    metadata: {},
    walls: [
      wall('top', 100, 100, 300, 100),
      wall('right', 300, 100, 300, 300),
      wall('bottom', 300, 300, 100, 300),
      wall('left', 100, 300, 100, 100),
    ],
  };
  const factor = setScaleFromReferenceWall(data, data.walls[0], 4);
  assert.equal(factor, 0.02);
  const rooms = calculateRooms(data);
  assert.equal(rooms.length, 1);
  assert.ok(rooms[0].area_m2 > 13 && rooms[0].area_m2 < 16);
}

console.log('Revise geometry tests passed.');
