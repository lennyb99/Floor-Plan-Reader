import * as THREE from 'three';
import { GLTFExporter } from 'three/addons/exporters/GLTFExporter.js';

const FURNITURE_HEIGHTS = {
  Waschbecken: 0.85,
  Herd: 0.90,
  Toilette: 0.45,
  Bett: 1.00,
  Dusche: 0.18,
  Treppe: 0.20,
};

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function openingWidth(wall, opening) {
  const horizontal = Math.abs(wall.end.x - wall.start.x) >= Math.abs(wall.end.y - wall.start.y);
  return positiveNumber(
    opening.opening_width,
    positiveNumber(
      horizontal ? opening.width : opening.height,
      positiveNumber(horizontal ? opening.height : opening.width, 40),
    ),
  );
}

function floorplanCenter(walls, scale) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  walls.forEach(wall => {
    minX = Math.min(minX, Number(wall.start?.x) || 0, Number(wall.end?.x) || 0);
    maxX = Math.max(maxX, Number(wall.start?.x) || 0, Number(wall.end?.x) || 0);
    minY = Math.min(minY, Number(wall.start?.y) || 0, Number(wall.end?.y) || 0);
    maxY = Math.max(maxY, Number(wall.start?.y) || 0, Number(wall.end?.y) || 0);
  });
  return {
    x: (minX + maxX) * scale / 2,
    z: (minY + maxY) * scale / 2,
  };
}

function addBox(parent, material, dimensions, position, name) {
  if (dimensions.x <= 0.001 || dimensions.y <= 0.001 || dimensions.z <= 0.001) return null;
  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(dimensions.x, dimensions.y, dimensions.z),
    material,
  );
  mesh.position.set(position.x, position.y, position.z);
  mesh.name = name;
  parent.add(mesh);
  return mesh;
}

export function buildGlbModel(data, options = {}) {
  if (!data || !Array.isArray(data.walls) || data.walls.length === 0) {
    throw new Error('GLB export requires at least one wall.');
  }

  const scale = positiveNumber(options.scale, 0.02);
  const wallHeight = positiveNumber(options.wallHeight, 2.8);
  const doorHeight = Math.min(positiveNumber(options.doorHeight, 2.1), wallHeight);
  const windowSill = Math.max(0, Number(options.windowSill) || 0.9);
  const windowHeight = positiveNumber(options.windowHeight, 1.3);
  const center = floorplanCenter(data.walls, scale);
  const root = new THREE.Group();
  root.name = 'Floor_Plan_Reader';

  const materials = {
    wall: new THREE.MeshStandardMaterial({ color: 0xb8bfad, roughness: 0.7 }),
    door: new THREE.MeshStandardMaterial({ color: 0x8a6d5c, roughness: 0.55 }),
    window: new THREE.MeshStandardMaterial({ color: 0x617e82, roughness: 0.2, metalness: 0.25, transparent: true, opacity: 0.56 }),
    furniture: new THREE.MeshStandardMaterial({ color: 0x8f6652, roughness: 0.65 }),
  };

  data.walls.forEach((wall, wallIndex) => {
    const x1 = (Number(wall.start?.x) || 0) * scale - center.x;
    const z1 = (Number(wall.start?.y) || 0) * scale - center.z;
    const x2 = (Number(wall.end?.x) || 0) * scale - center.x;
    const z2 = (Number(wall.end?.y) || 0) * scale - center.z;
    const dx = x2 - x1;
    const dz = z2 - z1;
    const length = Math.hypot(dx, dz);
    if (length <= 0.001) return;

    const wallName = wall.id || `wall_${wallIndex + 1}`;
    const thickness = Math.max(positiveNumber(wall.thickness, 6) * scale, 0.01);
    const angle = Math.atan2(dz, dx);
    const ux = dx / length;
    const uz = dz / length;
    const wallGroup = new THREE.Group();
    wallGroup.name = wallName;
    wallGroup.position.set(x1, 0, z1);
    wallGroup.rotation.y = -angle;
    root.add(wallGroup);

    const intervals = [];
    (wall.doors || []).forEach((door, index) => {
      const centerX = (Number(door.center?.x) || 0) * scale - center.x;
      const centerZ = (Number(door.center?.y) || 0) * scale - center.z;
      const alongWall = (centerX - x1) * ux + (centerZ - z1) * uz;
      const width = openingWidth(wall, door) * scale;
      intervals.push({ type: 'door', index, start: alongWall - width / 2, end: alongWall + width / 2 });
    });
    (wall.windows || []).forEach((window, index) => {
      const centerX = (Number(window.center?.x) || 0) * scale - center.x;
      const centerZ = (Number(window.center?.y) || 0) * scale - center.z;
      const alongWall = (centerX - x1) * ux + (centerZ - z1) * uz;
      const width = openingWidth(wall, window) * scale;
      intervals.push({ type: 'window', index, start: alongWall - width / 2, end: alongWall + width / 2 });
    });
    intervals.sort((a, b) => a.start - b.start);

    let blockIndex = 0;
    const addWallBlock = (start, end, minY, maxY) => {
      const blockLength = end - start;
      const blockHeight = maxY - minY;
      addBox(
        wallGroup,
        materials.wall,
        { x: blockLength, y: blockHeight, z: thickness },
        { x: start + blockLength / 2, y: minY + blockHeight / 2, z: 0 },
        `${wallName}_solid_${blockIndex++}`,
      );
    };

    let cursor = 0;
    intervals.forEach(interval => {
      const start = Math.max(cursor, Math.max(0, interval.start));
      const end = Math.min(length, interval.end);
      if (end <= start) return;
      if (start > cursor) addWallBlock(cursor, start, 0, wallHeight);

      const width = end - start;
      if (interval.type === 'door') {
        if (wallHeight > doorHeight) addWallBlock(start, end, doorHeight, wallHeight);
        addBox(
          wallGroup,
          materials.door,
          { x: width, y: doorHeight, z: Math.max(thickness * 0.35, 0.025) },
          { x: start + width / 2, y: doorHeight / 2, z: 0 },
          `${wallName}_door_${interval.index + 1}`,
        );
      } else {
        const windowBase = Math.min(windowSill, wallHeight);
        const windowTop = Math.min(wallHeight, windowSill + windowHeight);
        if (windowBase > 0) addWallBlock(start, end, 0, windowBase);
        if (wallHeight > windowTop) addWallBlock(start, end, windowTop, wallHeight);
        const visibleHeight = windowTop - windowBase;
        if (visibleHeight > 0.001) {
          addBox(
            wallGroup,
            materials.window,
            { x: width, y: visibleHeight, z: Math.max(thickness * 0.25, 0.02) },
            { x: start + width / 2, y: windowBase + visibleHeight / 2, z: 0 },
            `${wallName}_window_${interval.index + 1}`,
          );
        }
      }
      cursor = Math.max(cursor, end);
    });

    if (cursor < length) addWallBlock(cursor, length, 0, wallHeight);
  });

  (data.furniture || []).forEach((item, index) => {
    const width = Math.max(0.05, positiveNumber(item.width, 25) * scale);
    const depth = Math.max(0.05, positiveNumber(item.height, 25) * scale);
    const height = FURNITURE_HEIGHTS[item.class] || 0.7;
    const mesh = addBox(
      root,
      materials.furniture,
      { x: width, y: height, z: depth },
      {
        x: (Number(item.center?.x) || 0) * scale - center.x,
        y: height / 2,
        z: (Number(item.center?.y) || 0) * scale - center.z,
      },
      item.id || `furniture_${index + 1}`,
    );
    if (mesh) mesh.rotation.y = Number(item._rotationY) || 0;
  });

  return root;
}

function disposeModel(root) {
  const materials = new Set();
  root.traverse(object => {
    object.geometry?.dispose();
    if (Array.isArray(object.material)) object.material.forEach(material => materials.add(material));
    else if (object.material) materials.add(object.material);
  });
  materials.forEach(material => material.dispose());
}

export async function downloadGlbModel(data, options = {}) {
  const model = buildGlbModel(data, options);
  try {
    const result = await new GLTFExporter().parseAsync(model, {
      binary: true,
      onlyVisible: true,
      trs: false,
    });
    const blob = new Blob([result], { type: 'model/gltf-binary' });
    const anchor = document.createElement('a');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = options.fileName || 'floorplan.glb';
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
  } finally {
    disposeModel(model);
  }
}
