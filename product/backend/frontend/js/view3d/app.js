import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';

document.body.classList.toggle('debug-mode', new URLSearchParams(location.search).get('debug') === '1');

let toastTimer;
function showToast(message) {
  const toast = document.getElementById('toast');
  toast.textContent = message;
  toast.classList.add('visible');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
}

// ─────────────────────────────────────────────
//  SCENE SETUP
// ─────────────────────────────────────────────
const viewport = document.getElementById('viewport');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
renderer.setClearColor(0xf2f4ed);
viewport.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
camera.position.set(0, 18, 18);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

const hemi = new THREE.HemisphereLight(0xffffff, 0xb8bfad, 1.4);
scene.add(hemi);

const sun = new THREE.DirectionalLight(0xffffff, 1.2);
sun.position.set(20, 40, 20);
sun.castShadow = true;
sun.shadow.mapSize.set(1024, 1024);
sun.shadow.camera.near = 0.5;
sun.shadow.camera.far  = 500;
sun.shadow.camera.left = sun.shadow.camera.bottom = -100;
sun.shadow.camera.right = sun.shadow.camera.top   =  100;
scene.add(sun);

const rim = new THREE.DirectionalLight(0xe1e5d9, 0.5);
rim.position.set(-20, 20, -20);
scene.add(rim);

renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace    = THREE.SRGBColorSpace;

const gridHelper = new THREE.GridHelper(200, 80, 0x576049, 0xd6dacd);
gridHelper.position.y = -0.045;
scene.add(gridHelper);

const floorGeo  = new THREE.PlaneGeometry(300, 300);
const floorMat  = new THREE.MeshStandardMaterial({ color: 0xedf0e8, roughness: 0.9 });
const floorMesh = new THREE.Mesh(floorGeo, floorMat);
floorMesh.rotation.x = -Math.PI / 2;
// Keep the presentation floor below both the wall bases and the grid.  Two
// coplanar surfaces caused the striped/flickering z-fighting seen in 3D view.
floorMesh.position.y = -0.06;
floorMesh.receiveShadow = true;
scene.add(floorMesh);

// ─────────────────────────────────────────────
//  MATERIALS
// ─────────────────────────────────────────────
const MAT = {
  wall:      new THREE.MeshStandardMaterial({ color: 0xb8bfad, roughness: 0.7, metalness: 0.0 }),
  door:      new THREE.MeshStandardMaterial({ color: 0x8a6d5c, roughness: 0.5, transparent: true, opacity: 0.78 }),
  window:    new THREE.MeshStandardMaterial({ color: 0x617e82, roughness: 0.1, metalness: 0.65, transparent: true, opacity: 0.42 }),
  furniture: new THREE.MeshStandardMaterial({ color: 0x8f6652, roughness: 0.6, transparent: true, opacity: 0.88 }),
};

function setObjectOpacity(root, enabled, opacity) {
  if (!root) return;
  root.traverse(object => {
    if (!object.isMesh || !object.material) return;
    const materials = Array.isArray(object.material) ? object.material : [object.material];
    materials.forEach(material => {
      if (material.userData.baseOpacity === undefined) {
        material.userData.baseOpacity = material.opacity;
        material.userData.baseTransparent = material.transparent;
        material.userData.baseDepthWrite = material.depthWrite;
      }
      material.opacity = enabled ? Math.min(material.userData.baseOpacity, opacity) : material.userData.baseOpacity;
      material.transparent = enabled || material.userData.baseTransparent;
      material.depthWrite = enabled ? false : material.userData.baseDepthWrite;
      material.needsUpdate = true;
    });
  });
}

function applyTransparencyState() {
  if (floorplanGroup) {
    floorplanGroup.children.forEach(child => {
      if (child.userData.visualLayer === 'walls') {
        setObjectOpacity(child, document.getElementById('tog-transparent-walls').checked, 0.32);
      } else if (child.userData.visualLayer === 'objects') {
        setObjectOpacity(child, document.getElementById('tog-transparent-objects').checked, 0.38);
      }
    });
  }
  setObjectOpacity(floorMesh, document.getElementById('tog-transparent-floor').checked, 0.22);
}

const FURNITURE_HEIGHTS = {
  'Waschbecken': 0.85,
  'Herd':        0.90,
  'Toilette':    0.45,
  'Bett':        1.00,
  'Dusche':      0.18,
  'Treppe':      0.20,
};
const FURNITURE_DEFAULT_H = 0.70;
const FURNITURE_DEFAULT_SIZES = {
  Waschbecken: [42, 32],
  Herd: [34, 34],
  Toilette: [22, 34],
  Bett: [72, 92],
  Dusche: [48, 48],
  Treppe: [52, 76],
};
const FURNITURE_VIEWER_AUTO_DEFAULT_CLASSES = new Set(['Toilette', 'Waschbecken']);
const FURNITURE_VISUAL_ROTATION_OFFSETS = {
  Waschbecken: -90,
  Bett: -90,
};

// ─────────────────────────────────────────────
//  3D FURNITURE ASSET REGISTRY
// ─────────────────────────────────────────────
const FURNITURE_ASSETS_3D = {
  Waschbecken: 'assets/3d/waschbecken.glb',
  Herd:        'assets/3d/herd.glb',
  Toilette:    'assets/3d/toilette.glb',
  Bett:    'assets/3d/bett.glb',
};

const FURNITURE_ASSET_OPTIONS = {
  // The sanitary GLBs are already modeled with realistic proportions.  Scaling
  // X/Z/Y independently flattened the toilet and made the sink look oversized.
  // We fit their footprint uniformly and keep the height proportional to the
  // asset instead of forcing it into a generic furniture height.
  Toilette: {
    uniformFootprint: true,
  },
  Waschbecken: {
    uniformFootprint: true,
  },
};

const gltfCache = {};
const _gltfLoader = new GLTFLoader();

const _dracoLoader = new DRACOLoader();
_dracoLoader.setDecoderPath('https://www.gstatic.com/draco/versioned/decoders/1.5.6/');
_gltfLoader.setDRACOLoader(_dracoLoader);

async function loadFurnitureAssets3D() {
  console.log('[3D assets] Starting GLTF load for:', Object.keys(FURNITURE_ASSETS_3D));
  await Promise.all(
    Object.entries(FURNITURE_ASSETS_3D).map(([cls, path]) => {
      if (!path) { gltfCache[cls] = null; return Promise.resolve(); }
      return new Promise(resolve => {
        _gltfLoader.load(
          path,
          gltf => {
            gltf.scene.traverse(child => {
              if (child.isMesh) {
                const m   = child.material;
                const col = m.color ? m.color.clone() : new THREE.Color(0x8f6652);
                child.material      = new THREE.MeshLambertMaterial({ color: col, map: m.map ?? null });
                child.castShadow    = true;
                child.receiveShadow = true;
              }
            });
            gltfCache[cls] = gltf.scene;
            console.log(`[3D assets] Loaded: ${cls} from ${path}`);
            resolve();
          },
          null,
          err => {
            console.warn(`[3D assets] Failed to load ${cls} (${path}):`, err);
            gltfCache[cls] = null;
            resolve();
          }
        );
      });
    })
  );
  if (currentData) rebuild();
}

// ─────────────────────────────────────────────
//  PARAMS
// ─────────────────────────────────────────────
let stored3dSettings = {};
try {
  stored3dSettings = JSON.parse(localStorage.getItem('floorplan_3d_settings') || '{}');
} catch {
  stored3dSettings = {};
}

function storedPositive(key, fallback) {
  const value = Number(stored3dSettings[key]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

const storedWindowSill = Number(stored3dSettings.winSill);
const P = {
  scale: storedPositive('scale', 0.02),
  wallH: storedPositive('wallH', 2.8),
  doorH: storedPositive('doorH', 2.1),
  winSill: Number.isFinite(storedWindowSill) && storedWindowSill >= 0 ? storedWindowSill : 0.9,
  winH: storedPositive('winH', 1.3),
};

function persist3dSettings() {
  localStorage.setItem('floorplan_3d_settings', JSON.stringify(P));
}

function furnitureRotationY(item) {
  if (Number.isFinite(Number(item?.rotation))) {
    // Revise stores canvas/floorplan degrees clockwise. Three.js uses a
    // right-handed X/Z floor plane, so the sign is inverted for matching view.
    const visualRotation = Number(item.rotation) + (Number(FURNITURE_VISUAL_ROTATION_OFFSETS[item.class]) || 0);
    return -visualRotation * Math.PI / 180;
  }
  return Number(item?._rotationY) || 0;
}

function furnitureAssetOptions(item) {
  return FURNITURE_ASSET_OPTIONS[item?.class] || {};
}

function rotationYToFurnitureDegrees(rotationY) {
  let degrees = -rotationY * 180 / Math.PI;
  while (degrees <= -180) degrees += 360;
  while (degrees > 180) degrees -= 360;
  return Number(degrees.toFixed(1));
}

function syncParameterControls() {
  const settings = [
    ['sl-scale', 'val-scale', P.scale, value => value.toFixed(3)],
    ['sl-wall-h', 'val-wall-h', P.wallH, value => `${value.toFixed(1)} m`],
    ['sl-door-h', 'val-door-h', P.doorH, value => `${value.toFixed(1)} m`],
    ['sl-win-sill', 'val-win-sill', P.winSill, value => `${value.toFixed(2)} m`],
    ['sl-win-h', 'val-win-h', P.winH, value => `${value.toFixed(1)} m`],
  ];
  settings.forEach(([sliderId, valueId, value, format]) => {
    const slider = document.getElementById(sliderId);
    slider.value = String(Math.max(Number(slider.min), Math.min(Number(slider.max), value)));
    document.getElementById(valueId).textContent = format(value);
  });
}

syncParameterControls();

// ─────────────────────────────────────────────
//  WALL HIDING & ANIMATION STATE
// ─────────────────────────────────────────────
let wallsHidden = false;
let wallScaleY = 1.0;
let wallScaleVelocity = 0;
const transitionDuration = 0.75; // Seconds to complete standard slide down
const springStiffness = 110;     // Stiffness of the unhiding bounce
const springDamping = 12;        // Friction preventing endless bouncing
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ─────────────────────────────────────────────
//  GEOMETRY BUILDER (1D Segmenter Pipeline)
// ─────────────────────────────────────────────
let floorplanGroup = null;

function buildFloorplan(data) {
  if (floorplanGroup) {
    scene.remove(floorplanGroup);
    floorplanGroup.traverse(o => {
      if (o.geometry) o.geometry.dispose();
    });
  }

  floorplanGroup = new THREE.Group();
  scene.add(floorplanGroup);

  const walls = data.walls || [];
  const s = P.scale;

  if (walls.length === 0) {
    document.getElementById('empty-state').style.display = '';
    document.getElementById('stats-strip').textContent = 'No wall geometry detected';
    return;
  }

  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  walls.forEach(w => {
    minX = Math.min(minX, w.start.x, w.end.x);
    maxX = Math.max(maxX, w.start.x, w.end.x);
    minY = Math.min(minY, w.start.y, w.end.y);
    maxY = Math.max(maxY, w.start.y, w.end.y);
  });
  const centerX = (minX + maxX) / 2 * s;
  const centerZ = (minY + maxY) / 2 * s;

  walls.forEach(wall => {
    const x1 = wall.start.x * s - centerX;
    const z1 = wall.start.y * s - centerZ;
    const x2 = wall.end.x   * s - centerX;
    const z2 = wall.end.y   * s - centerZ;

    const dx     = x2 - x1;
    const dz     = z2 - z1;
    const length = Math.sqrt(dx * dx + dz * dz);
    if (length < 0.001) return;

    const angle  = Math.atan2(dz, dx);
    const thick  = Math.max(wall.thickness * s, 0.01);

    const wallGroup = new THREE.Group();
    wallGroup.position.set(x1, 0, z1);
    wallGroup.rotation.y = -angle;
    wallGroup.name = wall.id;
    wallGroup.userData.visualLayer = 'walls';
    floorplanGroup.add(wallGroup);

    const ux = dx / length;
    const uz = dz / length;

    const intervals = [];

    (wall.doors || []).forEach((door, i) => {
      const dw = (door.opening_width || Math.min(door.width || 0, door.height || 0)) * s || 0.8;
      const dcx = door.center.x * s - centerX;
      const dcz = door.center.y * s - centerZ;
      const t = (dcx - x1) * ux + (dcz - z1) * uz;
      intervals.push({
        t0: t - dw/2,
        t1: t + dw/2,
        type: 'door',
        index: i,
        data: door
      });
    });

    (wall.windows || []).forEach((win, i) => {
      const ww = (win.opening_width || Math.min(win.width || 0, win.height || 0)) * s || 1.0;
      const wcx = win.center.x * s - centerX;
      const wcz = win.center.y * s - centerZ;
      const t = (wcx - x1) * ux + (wcz - z1) * uz;
      intervals.push({
        t0: t - ww/2,
        t1: t + ww/2,
        type: 'window',
        index: i,
        data: win
      });
    });

    intervals.sort((a, b) => a.t0 - b.t0);

    function addWallBlock(a, b, yMin, yMax) {
      if (b <= a) return;
      // Keep mesh ends on the detected segment endpoints. L/T junctions are
      // closed by the dedicated joint meshes below; extending every free end
      // by half a wall thickness creates visible protrusions.
      const start = a;
      const end = b;
      const w = end - start;
      const h = yMax - yMin;
      if (w <= 0.001 || h <= 0.001) return;

      const geo = new THREE.BoxGeometry(w, h, thick);
      const mesh = new THREE.Mesh(geo, MAT.wall.clone());
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.position.set(start + w / 2, yMin + h / 2, 0);
      mesh.name = `${wall.id}_solid_${a.toFixed(2)}`;
      wallGroup.add(mesh);
    }

    function addWindowBlock(a, b, yMin, yMax, index) {
      if (b <= a) return;
      const w = b - a;
      const h = yMax - yMin;
      if (w <= 0.001 || h <= 0.001) return;

      const glassThick = thick * 0.25;
      const glassGeo = new THREE.BoxGeometry(w, h, glassThick);
      const glassMesh = new THREE.Mesh(glassGeo, MAT.window.clone());
      glassMesh.position.set(a + w/2, yMin + h/2, 0);
      glassMesh.castShadow = true;
      glassMesh.receiveShadow = true;
      glassMesh.name = `${wall.id}_win_glass_${index}`;
      wallGroup.add(glassMesh);

      const frameThick = thick + 0.005;
      const frameWidth = Math.min(0.04, w * 0.1);
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x424a38, roughness: 0.5 });

      const topGeo = new THREE.BoxGeometry(w, frameWidth, frameThick);
      const topMesh = new THREE.Mesh(topGeo, frameMat);
      topMesh.position.set(a + w/2, yMax - frameWidth/2, 0);
      wallGroup.add(topMesh);

      const botGeo = new THREE.BoxGeometry(w, frameWidth, frameThick);
      const botMesh = new THREE.Mesh(botGeo, frameMat);
      botMesh.position.set(a + w/2, yMin + frameWidth/2, 0);
      wallGroup.add(botMesh);

      const sideH = h - 2 * frameWidth;
      if (sideH > 0) {
        const leftGeo = new THREE.BoxGeometry(frameWidth, sideH, frameThick);
        const leftMesh = new THREE.Mesh(leftGeo, frameMat);
        leftMesh.position.set(a + frameWidth/2, yMin + h/2, 0);
        wallGroup.add(leftMesh);

        const rightGeo = new THREE.BoxGeometry(frameWidth, sideH, frameThick);
        const rightMesh = new THREE.Mesh(rightGeo, frameMat);
        rightMesh.position.set(b - frameWidth/2, yMin + h/2, 0);
        wallGroup.add(rightMesh);
      }
    }

    function addDoorBlock(a, b, yMin, yMax, index) {
      if (b <= a) return;
      const w = b - a;
      const h = yMax - yMin;
      if (w <= 0.001 || h <= 0.001) return;

      const frameThick = thick + 0.005;
      const frameWidth = Math.min(0.05, w * 0.1);
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x5f4d42, roughness: 0.6 });

      const topGeo = new THREE.BoxGeometry(w, frameWidth, frameThick);
      const topMesh = new THREE.Mesh(topGeo, frameMat);
      topMesh.position.set(a + w/2, yMax - frameWidth/2, 0);
      wallGroup.add(topMesh);

      const sideH = h - frameWidth;
      if (sideH > 0) {
        const leftGeo = new THREE.BoxGeometry(frameWidth, sideH, frameThick);
        const leftMesh = new THREE.Mesh(leftGeo, frameMat);
        leftMesh.position.set(a + frameWidth/2, yMin + sideH/2, 0);
        wallGroup.add(leftMesh);

        const rightGeo = new THREE.BoxGeometry(frameWidth, sideH, frameThick);
        const rightMesh = new THREE.Mesh(rightGeo, frameMat);
        rightMesh.position.set(b - frameWidth/2, yMin + sideH/2, 0);
        wallGroup.add(rightMesh);
      }

      const panelW = w - 2 * frameWidth;
      const panelH = h - frameWidth;
      if (panelW > 0 && panelH > 0) {
        const panelThick = thick * 0.35;
        const panelGeo = new THREE.BoxGeometry(panelW, panelH, panelThick);
        const panelMesh = new THREE.Mesh(panelGeo, MAT.door.clone());
        panelMesh.position.set(a + w/2, yMin + panelH/2, 0);
        panelMesh.castShadow = true;
        panelMesh.receiveShadow = true;
        panelMesh.name = `${wall.id}_door_panel_${index}`;
        wallGroup.add(panelMesh);
      }
    }

    let currentT = 0;

    intervals.forEach(seg => {
      const tStart = Math.max(currentT, seg.t0);
      const tEnd = Math.min(length, seg.t1);

      if (tEnd > tStart) {
        if (tStart > currentT) {
          addWallBlock(currentT, tStart, 0, P.wallH);
        }

        if (seg.type === 'door') {
          if (P.wallH > P.doorH) {
            addWallBlock(tStart, tEnd, P.doorH, P.wallH);
          }
          addDoorBlock(tStart, tEnd, 0, P.doorH, seg.index);
        } else if (seg.type === 'window') {
          if (P.winSill > 0) {
            addWallBlock(tStart, tEnd, 0, P.winSill);
          }
          const winTop = P.winSill + P.winH;
          if (P.wallH > winTop) {
            addWallBlock(tStart, tEnd, winTop, P.wallH);
          }
          addWindowBlock(tStart, tEnd, P.winSill, winTop, seg.index);
        }
        currentT = tEnd;
      }
    });

    if (currentT < length) {
      addWallBlock(currentT, length, 0, P.wallH);
    }

    // Apply immediate state scale on rebuild to maintain visibility preference
    wallGroup.scale.y = wallScaleY;
  });

  (data.furniture || []).forEach(item => {
    const fw  = item.width  * s;
    const fd  = item.height * s;
    const fh  = FURNITURE_HEIGHTS[item.class] ?? FURNITURE_DEFAULT_H;
    const fcx = item.center.x * s - centerX;
    const fcz = item.center.y * s - centerZ;
    const cached = gltfCache[item.class];
    const assetOptions = furnitureAssetOptions(item);
    const rotationY = furnitureRotationY(item) + (Number(assetOptions.yawOffset) || 0);

    if (cached) {
      const root = new THREE.Group();
      root.position.set(fcx, 0, fcz);
      root.rotation.y = rotationY;
      root.name = item.id;
      root.userData.visualLayer = 'objects';

      const obj = cached.clone(true);
      const box = new THREE.Box3().setFromObject(obj);
      const sz  = new THREE.Vector3();
      box.getSize(sz);

      if (assetOptions.uniformFootprint) {
        const fitX = sz.x > 0 ? fw / sz.x : 1;
        const fitZ = sz.z > 0 ? fd / sz.z : 1;
        const uniformScale = Math.min(fitX, fitZ);
        obj.scale.set(uniformScale, uniformScale, uniformScale);
      } else {
        const scaleX = sz.x > 0 ? fw / sz.x : 1;
        const scaleZ = sz.z > 0 ? fd / sz.z : 1;
        const scaleY = sz.y > 0 ? fh / sz.y : Math.min(scaleX, scaleZ);
        obj.scale.set(scaleX, scaleY, scaleZ);
      }

      const box2 = new THREE.Box3().setFromObject(obj);
      obj.position.set(
        -(box2.min.x + box2.max.x) / 2,
        -box2.min.y,
        -(box2.min.z + box2.max.z) / 2,
      );
      obj.userData.visualLayer = 'objects';
      obj.traverse(child => { if (child.isMesh) { child.castShadow = child.receiveShadow = true; } });
      root.add(obj);
      floorplanGroup.add(root);
    } else {
      const geo  = new THREE.BoxGeometry(fw, fh, fd);
      const mesh = new THREE.Mesh(geo, MAT.furniture.clone());
      mesh.position.set(fcx, fh / 2, fcz);
      mesh.rotation.y = rotationY;
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = item.id;
      mesh.userData.visualLayer = 'objects';
      floorplanGroup.add(mesh);
    }

    const cvs  = document.createElement('canvas');
    cvs.width  = 256; cvs.height = 64;
    const lctx = cvs.getContext('2d');
    lctx.fillStyle    = '#576049';
    lctx.font         = 'bold 26px sans-serif';
    lctx.textAlign    = 'center';
    lctx.textBaseline = 'middle';
    lctx.fillText(item.class, 128, 32);
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cvs), transparent: true })
    );
    sprite.scale.set(Math.max(fw, 0.8), Math.max(fw, 0.8) * 0.25, 1);
    sprite.position.set(fcx, fh + 0.25, fcz);
    sprite.name = `label_${item.id}`;
    sprite.visible = document.getElementById('tog-labels').checked;
    floorplanGroup.add(sprite);
  });

  const size  = Math.max((maxX - minX), (maxY - minY)) * s;
  const dist  = size * 1.4 + P.wallH * 2;
  camera.position.set(0, dist * 0.7, dist);
  camera.lookAt(0, P.wallH / 2, 0);
  controls.target.set(0, P.wallH / 2, 0);
  controls.update();

  const nWins  = walls.reduce((a, w) => a + (w.windows || []).length, 0);
  const nDoors = walls.reduce((a, w) => a + (w.doors || []).length, 0);
  const nFurn = (data.furniture || []).length;
  document.getElementById('stats-strip').innerHTML =
    `${walls.length} walls &nbsp;·&nbsp; ${nWins} windows &nbsp;·&nbsp; ${nDoors} doors &nbsp;·&nbsp; ${nFurn} furniture`;

  document.getElementById('empty-state').style.display  = 'none';
  applyTransparencyState();
}

function applyWireframe(enabled) {
  if (!floorplanGroup) return;
  floorplanGroup.traverse(obj => {
    if (obj.isMesh) {
      obj.material.wireframe = enabled;
    }
  });
}

let currentData = null;

function rebuild() {
  if (!currentData) return;
  document.getElementById('loading').classList.add('active');
  requestAnimationFrame(() => {
    buildFloorplan(currentData);
    applyWireframe(document.getElementById('tog-wire').checked);
    applyTransparencyState();
    document.getElementById('loading').classList.remove('active');
  });
}

function normalizeViewerFurnitureDefaults(json) {
  (json.furniture || []).forEach(item => {
    if (!item || !FURNITURE_VIEWER_AUTO_DEFAULT_CLASSES.has(item.class)) return;
    if (!item.raw_bbox || item.user_scaled) return;
    const width = Number(item.width);
    const height = Number(item.height);
    const [defaultWidth, defaultHeight] = FURNITURE_DEFAULT_SIZES[item.class] || [width, height];
    if (!Number.isFinite(width) || !Number.isFinite(height)) return;
    const tooLarge = (
      Math.max(width, height) > Math.max(defaultWidth, defaultHeight) * 1.35
      || Math.min(width, height) > Math.min(defaultWidth, defaultHeight) * 1.35
    );
    if (!tooLarge) return;
    item.width = defaultWidth;
    item.height = defaultHeight;
  });
}

function loadData(json) {
  if (!json || !Array.isArray(json.walls)) throw new Error('Missing walls array');
  normalizeViewerFurnitureDefaults(json);
  currentData = json;
  const calibratedScale = Number(json.metadata?.measurement?.meters_per_pixel);
  if (Number.isFinite(calibratedScale) && calibratedScale > 0) {
    P.scale = calibratedScale;
    const scaleSlider = document.getElementById('sl-scale');
    scaleSlider.value = String(Math.max(Number(scaleSlider.min), Math.min(Number(scaleSlider.max), calibratedScale)));
    document.getElementById('val-scale').textContent = calibratedScale.toFixed(4);
    persist3dSettings();
  }
  const source = localStorage.getItem('floorplan_source');
  if (source) document.getElementById('nav-source').textContent = source;
  rebuild();
}

loadFurnitureAssets3D();

const saved = localStorage.getItem('floorplan');
if (saved) {
  try { loadData(JSON.parse(saved)); } catch(e) { console.warn('localStorage parse error', e); }
}

document.getElementById('btn-load-json').addEventListener('click', () => {
  document.getElementById('file-input-3d').click();
});
document.getElementById('file-input-3d').addEventListener('change', e => {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = ev => {
    try {
      const json = JSON.parse(ev.target.result);
      loadData(json);
      localStorage.setItem('floorplan', JSON.stringify(json));
      localStorage.setItem('floorplan_source', file.name);
      document.getElementById('nav-source').textContent = file.name;
    } catch { showToast('This is not a valid floor plan JSON file.'); }
  };
  reader.readAsText(file);
  e.target.value = '';
});

function bindSlider(id, valId, key, fmt) {
  const sl = document.getElementById(id);
  const vl = document.getElementById(valId);
  sl.addEventListener('input', () => {
    P[key] = parseFloat(sl.value);
    vl.textContent = fmt(P[key]);
    persist3dSettings();
    rebuild();
  });
}

bindSlider('sl-wall-h',   'val-wall-h',   'wallH',   v => v.toFixed(1) + ' m');
bindSlider('sl-door-h',   'val-door-h',   'doorH',   v => v.toFixed(1) + ' m');
bindSlider('sl-win-sill', 'val-win-sill', 'winSill', v => v.toFixed(2) + ' m');
bindSlider('sl-win-h',    'val-win-h',    'winH',    v => v.toFixed(1) + ' m');
bindSlider('sl-scale',    'val-scale',    'scale',   v => v.toFixed(3));

document.getElementById('tog-floor').addEventListener('change', e => {
  floorMesh.visible = e.target.checked;
});
document.getElementById('tog-grid').addEventListener('change', e => {
  gridHelper.visible = e.target.checked;
});
document.getElementById('tog-wire').addEventListener('change', e => {
  applyWireframe(e.target.checked);
});
document.getElementById('tog-transparent-walls').addEventListener('change', applyTransparencyState);
document.getElementById('tog-transparent-objects').addEventListener('change', applyTransparencyState);
document.getElementById('tog-transparent-floor').addEventListener('change', applyTransparencyState);

document.getElementById('tog-labels').addEventListener('change', e => {
  if (!floorplanGroup) return;
  floorplanGroup.traverse(obj => { if (obj.isSprite && obj.name.startsWith('label_')) obj.visible = e.target.checked; });
});

function resetCamera() {
  if (!currentData) return;
  const walls = currentData.walls || [];
  if (!walls.length) return;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  walls.forEach(w => {
    minX = Math.min(minX, w.start.x, w.end.x); maxX = Math.max(maxX, w.start.x, w.end.x);
    minY = Math.min(minY, w.start.y, w.end.y); maxY = Math.max(maxY, w.start.y, w.end.y);
  });
  const size = Math.max(maxX - minX, maxY - minY) * P.scale;
  const dist = size * 1.4 + P.wallH * 2;
  camera.position.set(0, dist * 0.7, dist);
  controls.target.set(0, P.wallH / 2, 0);
  controls.update();
}

function toggleWalls() {
  wallsHidden = !wallsHidden;
  wallScaleVelocity = 0;
  const button = document.getElementById('btn-toggle-walls');
  button.textContent = wallsHidden ? 'Show walls' : 'Hide walls';
  button.setAttribute('aria-pressed', String(wallsHidden));
}

// ─────────────────────────────────────────────
//  FIRST PERSON MODE & CAMERA TRANSITIONS (0.75s)
// ─────────────────────────────────────────────
let isFirstPerson = false;
let isFPTransitioning = false;
let fpTransitionStartTime = 0;
const FP_TRANSITION_DURATION = 0.75; // 0.75 seconds smooth transition

const animStartCamPos = new THREE.Vector3();
const animTargetCamPos = new THREE.Vector3();
const animStartLookAt = new THREE.Vector3();
const animTargetLookAt = new THREE.Vector3();
const currentLookAt = new THREE.Vector3();

const fpPos = new THREE.Vector3();
let fpYaw = 0;
let fpPitch = 0;
const EYE_HEIGHT = 1.54; // Standing height above ground

const fpKeys = {
  forward: false,
  backward: false,
  left: false,
  right: false,
};

function getFloorplanCenter() {
  if (!currentData || !currentData.walls || !currentData.walls.length) {
    return { x: 0, z: 0 };
  }
  const s = P.scale;
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  currentData.walls.forEach(w => {
    minX = Math.min(minX, w.start.x, w.end.x); maxX = Math.max(maxX, w.start.x, w.end.x);
    minY = Math.min(minY, w.start.y, w.end.y); maxY = Math.max(maxY, w.start.y, w.end.y);
  });
  return { x: 0, z: 0 }; // Floorplan geometry is centered at scene (0,0)
}

function getFPLookDirection() {
  const dir = new THREE.Vector3(
    -Math.sin(fpYaw) * Math.cos(fpPitch),
    Math.sin(fpPitch),
    -Math.cos(fpYaw) * Math.cos(fpPitch)
  );
  return dir.normalize();
}

function updateDoorOpacity(opacity) {
  if (!floorplanGroup) return;
  const clampedOpacity = Math.max(0, Math.min(1, opacity));
  floorplanGroup.traverse(obj => {
    if (!obj.isMesh || !obj.material) return;

    let isDoor = false;
    let curr = obj;
    while (curr && curr !== floorplanGroup) {
      if (curr.name && (curr.name.includes('_door') || curr.name === 'Door' || curr.name === 'DoorFrame')) {
        isDoor = true;
        break;
      }
      curr = curr.parent;
    }
    if (!isDoor && obj.material === MAT.door) {
      isDoor = true;
    }

    if (isDoor) {
      const materials = Array.isArray(obj.material) ? obj.material : [obj.material];
      materials.forEach(mat => {
        if (mat.userData.baseDoorOpacity === undefined) {
          mat.userData.baseDoorOpacity = mat.opacity !== undefined ? mat.opacity : 1.0;
          mat.userData.baseDoorTransparent = mat.transparent;
          mat.userData.baseDoorDepthWrite = mat.depthWrite;
        }
        const targetAlpha = mat.userData.baseDoorOpacity * clampedOpacity;
        mat.opacity = targetAlpha;
        mat.transparent = clampedOpacity < 0.99 || mat.userData.baseDoorTransparent;
        mat.depthWrite = clampedOpacity > 0.1 && mat.userData.baseDoorDepthWrite;
        mat.needsUpdate = true;
      });
    }
  });
}

function enterFirstPerson() {
  if (isFirstPerson || isFPTransitioning) return;

  isFPTransitioning = true;
  isFirstPerson = true;
  fpTransitionStartTime = performance.now();

  deselectFurniture();
  controls.enabled = false;

  animStartCamPos.copy(camera.position);
  animStartLookAt.copy(controls.target);

  // Compute horizontal forward vector from current camera to target
  const forward = new THREE.Vector3().subVectors(controls.target, camera.position);
  forward.y = 0;
  if (forward.lengthSq() < 0.0001) {
    forward.set(0, 0, -1);
  } else {
    forward.normalize();
  }

  // Position FP camera 2.0 metres forward along current camera view direction, at standing eye height
  fpPos.x = camera.position.x + forward.x * 2.0;
  fpPos.z = camera.position.z + forward.z * 2.0;
  fpPos.y = EYE_HEIGHT;

  // Align FP yaw seamlessly with the camera's current horizontal view direction
  fpYaw = Math.atan2(-forward.x, -forward.z);
  fpPitch = 0;

  animTargetCamPos.copy(fpPos);
  const lookDir = getFPLookDirection();
  animTargetLookAt.copy(fpPos).add(lookDir);

  const button = document.getElementById('btn-first-person');
  if (button) {
    button.classList.add('active');
    button.setAttribute('aria-pressed', 'true');
    button.textContent = 'Exit 1st Person';
  }

  const fpHud = document.getElementById('fp-hud');
  if (fpHud) fpHud.classList.add('visible');

  const fpCrosshair = document.getElementById('fp-crosshair');
  if (fpCrosshair) {
    fpCrosshair.classList.remove('visually-hidden');
    fpCrosshair.classList.add('visible');
  }

  showToast('Entered 1st Person Mode · WASD to walk, Mouse to look, Esc to exit');
  requestPointerLock();
}

function exitFirstPerson() {
  if (!isFirstPerson && !isFPTransitioning) return;

  if (document.pointerLockElement) {
    document.exitPointerLock();
  }

  isFPTransitioning = true;
  isFirstPerson = false;
  fpTransitionStartTime = performance.now();

  animStartCamPos.copy(camera.position);
  const lookDir = getFPLookDirection();
  animStartLookAt.copy(camera.position).add(lookDir);

  if (currentData && currentData.walls && currentData.walls.length) {
    const s = P.scale;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    currentData.walls.forEach(w => {
      minX = Math.min(minX, w.start.x, w.end.x); maxX = Math.max(maxX, w.start.x, w.end.x);
      minY = Math.min(minY, w.start.y, w.end.y); maxY = Math.max(maxY, w.start.y, w.end.y);
    });
    const size = Math.max(maxX - minX, maxY - minY) * s;
    const dist = size * 1.4 + P.wallH * 2;
    animTargetCamPos.set(0, dist * 0.7, dist);
    animTargetLookAt.set(0, P.wallH / 2, 0);
  } else {
    animTargetCamPos.set(0, 18, 18);
    animTargetLookAt.set(0, 0, 0);
  }

  const button = document.getElementById('btn-first-person');
  if (button) {
    button.classList.remove('active');
    button.setAttribute('aria-pressed', 'false');
    button.textContent = 'First Person';
  }

  const fpHud = document.getElementById('fp-hud');
  if (fpHud) fpHud.classList.remove('visible');

  const fpCrosshair = document.getElementById('fp-crosshair');
  if (fpCrosshair) {
    fpCrosshair.classList.remove('visible');
    fpCrosshair.classList.add('visually-hidden');
  }
}

function toggleFirstPerson() {
  if (isFirstPerson) {
    exitFirstPerson();
  } else {
    enterFirstPerson();
  }
}

function requestPointerLock() {
  if (!document.pointerLockElement && (isFirstPerson || isFPTransitioning)) {
    renderer.domElement.requestPointerLock?.();
  }
}

document.getElementById('btn-reset-camera').addEventListener('click', resetCamera);
document.getElementById('btn-toggle-walls').addEventListener('click', toggleWalls);
document.getElementById('btn-first-person')?.addEventListener('click', toggleFirstPerson);
document.getElementById('btn-exit-fp')?.addEventListener('click', exitFirstPerson);

document.addEventListener('pointerlockchange', () => {
  if (!document.pointerLockElement && isFirstPerson && !isFPTransitioning) {
    exitFirstPerson();
  }
});

document.addEventListener('mousemove', e => {
  if (!isFirstPerson || isFPTransitioning) return;
  if (document.pointerLockElement === renderer.domElement) {
    const sensitivity = 0.0022;
    fpYaw -= e.movementX * sensitivity;
    fpPitch -= e.movementY * sensitivity;

    const maxPitch = Math.PI / 2 - 0.05;
    fpPitch = Math.max(-maxPitch, Math.min(maxPitch, fpPitch));
  }
});

renderer.domElement.addEventListener('dblclick', resetCamera);

window.addEventListener('storage', e => {
  if (e.key !== 'floorplan' || !e.newValue) return;
  try { loadData(JSON.parse(e.newValue)); } catch(err) { console.warn('3D sync error', err); }
});

const raycaster  = new THREE.Raycaster();
const pointer    = new THREE.Vector2();
const floorPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);

let selectedFurniture = null;
let isDragging        = false;
let dragOffset        = new THREE.Vector3();

const hud     = document.getElementById('furniture-hud');
const hudName = document.getElementById('hud-name');

function getFurnitureMeshes() {
  if (!floorplanGroup) return [];
  return floorplanGroup.children.filter(o => o.name && o.name.startsWith('furniture_'));
}

function screenToPointer(e) {
  const rect = renderer.domElement.getBoundingClientRect();
  pointer.x =  ((e.clientX - rect.left)  / rect.width)  * 2 - 1;
  pointer.y = -((e.clientY - rect.top)   / rect.height) * 2 + 1;
}

function selectFurniture(obj) {
  deselectFurniture();
  const dataIdx = parseInt(obj.name.replace('furniture_', ''), 10);
  if (isNaN(dataIdx)) return;

  const box = new THREE.Box3().setFromObject(obj);
  const sz  = new THREE.Vector3(); box.getSize(sz);
  const ctr = new THREE.Vector3(); box.getCenter(ctr);
  const outline = new THREE.Mesh(
    new THREE.BoxGeometry(sz.x + 0.05, sz.y + 0.05, sz.z + 0.05),
    new THREE.MeshBasicMaterial({ color: 0x8a7552, wireframe: true })
  );
  outline.position.copy(ctr);
  outline.name = '__outline__';
  floorplanGroup.add(outline);

  selectedFurniture = { dataIdx, obj, outline };
  const item = (currentData.furniture || [])[dataIdx];
  hudName.textContent = item ? item.class : '';
  hud.classList.add('visible');
}

function deselectFurniture() {
  if (!selectedFurniture) return;
  const ol = floorplanGroup.getObjectByName('__outline__');
  if (ol) floorplanGroup.remove(ol);
  selectedFurniture = null;
  hud.classList.remove('visible');
}

function syncFurnitureToData() {
  if (!selectedFurniture || !currentData) return;
  const { dataIdx, obj } = selectedFurniture;
  const item = (currentData.furniture || [])[dataIdx];
  if (!item) return;
  const s = P.scale;
  const walls = currentData.walls || [];
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  walls.forEach(w => {
    minX = Math.min(minX, w.start.x, w.end.x); maxX = Math.max(maxX, w.start.x, w.end.x);
    minY = Math.min(minY, w.start.y, w.end.y); maxY = Math.max(maxY, w.start.y, w.end.y);
  });
  item.center.x = Math.round((obj.position.x + (minX + maxX) / 2 * s) / s);
  item.center.y = Math.round((obj.position.z + (minY + maxY) / 2 * s) / s);
  item.rotation = rotationYToFurnitureDegrees(obj.rotation.y);
  item._rotationY = obj.rotation.y;
  localStorage.setItem('floorplan', JSON.stringify(currentData));
}

renderer.domElement.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  screenToPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const hits = raycaster.intersectObjects(getFurnitureMeshes(), true);
  if (hits.length > 0) {
    let root = hits[0].object;
    while (root.parent && !root.name.startsWith('furniture_')) root = root.parent;
    if (root.name.startsWith('furniture_')) {
      selectFurniture(root);
      const hit3d = new THREE.Vector3();
      raycaster.ray.intersectPlane(floorPlane, hit3d);
      dragOffset.set(root.position.x - hit3d.x, 0, root.position.z - hit3d.z);
      isDragging = true;
      controls.enabled = false;
    } else { deselectFurniture(); }
  } else { deselectFurniture(); }
});

renderer.domElement.addEventListener('pointermove', e => {
  if (!isDragging || !selectedFurniture) return;
  screenToPointer(e);
  raycaster.setFromCamera(pointer, camera);
  const hit = new THREE.Vector3();
  if (raycaster.ray.intersectPlane(floorPlane, hit)) {
    selectedFurniture.obj.position.x = hit.x + dragOffset.x;
    selectedFurniture.obj.position.z = hit.z + dragOffset.z;
    const ol = floorplanGroup.getObjectByName('__outline__');
    if (ol) { ol.position.x = selectedFurniture.obj.position.x; ol.position.z = selectedFurniture.obj.position.z; }
  }
});

renderer.domElement.addEventListener('pointerup', e => {
  if (e.button !== 0) return;
  if (isDragging) { isDragging = false; controls.enabled = true; syncFurnitureToData(); }
});

window.addEventListener('keydown', e => {
  if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;

  if (e.key === 'Escape') {
    if (isFirstPerson || isFPTransitioning) {
      exitFirstPerson();
      return;
    }
    deselectFurniture();
    return;
  }

  // Handle WASD & Arrow key states in 1st person mode
  if (isFirstPerson && !isFPTransitioning) {
    if (e.code === 'KeyW' || e.code === 'ArrowUp') { fpKeys.forward = true; }
    if (e.code === 'KeyS' || e.code === 'ArrowDown') { fpKeys.backward = true; }
    if (e.code === 'KeyA' || e.code === 'ArrowLeft') { fpKeys.left = true; }
    if (e.code === 'KeyD' || e.code === 'ArrowRight') { fpKeys.right = true; }
  }

  // Toggle wall hiding with the 'H' key
  if (e.key === 'h' || e.key === 'H') {
    toggleWalls();
  }

  if (!selectedFurniture) return;
  if (e.key === 'r' || e.key === 'R') {
    selectedFurniture.obj.rotation.y += Math.PI / 4;
    const ol = floorplanGroup.getObjectByName('__outline__');
    if (ol) ol.rotation.y = selectedFurniture.obj.rotation.y;
    syncFurnitureToData();
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const { dataIdx, obj, outline } = selectedFurniture;
    floorplanGroup.remove(obj);
    if (outline) floorplanGroup.remove(outline);
    const label = floorplanGroup.children.find(
      o => o.isSprite && Math.abs(o.position.x - obj.position.x) < 0.05
        && Math.abs(o.position.z - obj.position.z) < 0.05
    );
    if (label) floorplanGroup.remove(label);
    if (currentData.furniture) currentData.furniture.splice(dataIdx, 1);
    selectedFurniture = null;
    hud.classList.remove('visible');
    localStorage.setItem('floorplan', JSON.stringify(currentData));
    rebuild();
  }
});

window.addEventListener('keyup', e => {
  if (e.code === 'KeyW' || e.code === 'ArrowUp') { fpKeys.forward = false; }
  if (e.code === 'KeyS' || e.code === 'ArrowDown') { fpKeys.backward = false; }
  if (e.code === 'KeyA' || e.code === 'ArrowLeft') { fpKeys.left = false; }
  if (e.code === 'KeyD' || e.code === 'ArrowRight') { fpKeys.right = false; }
});

function resize() {
  const w = viewport.clientWidth;
  const h = viewport.clientHeight;
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(viewport);
resize();

// Clock for delta timing transitions
const animClock = new THREE.Clock();

(function animate() {
  requestAnimationFrame(animate);

  const dt = Math.min(animClock.getDelta(), 0.1);
  const now = performance.now();

  // First Person Camera & Door Opacity Transition (0.75s smooth interpolation)
  if (isFPTransitioning) {
    const elapsed = (now - fpTransitionStartTime) / 1000;
    const progress = Math.min(1.0, elapsed / FP_TRANSITION_DURATION);

    // Smoothstep cubic easing: t*t*(3 - 2*t)
    const ease = reduceMotion ? progress : progress * progress * (3 - 2 * progress);

    camera.position.lerpVectors(animStartCamPos, animTargetCamPos, ease);
    currentLookAt.lerpVectors(animStartLookAt, animTargetLookAt, ease);
    camera.lookAt(currentLookAt);

    // Fade doors to alpha = 0 when entering FP, and fade back to alpha = 1 when exiting
    const doorAlpha = isFirstPerson ? (1.0 - ease) : ease;
    updateDoorOpacity(doorAlpha);

    if (progress >= 1.0) {
      isFPTransitioning = false;
      if (isFirstPerson) {
        camera.position.copy(fpPos);
        const lookDir = getFPLookDirection();
        camera.lookAt(fpPos.clone().add(lookDir));
        updateDoorOpacity(0.0);
      } else {
        controls.target.copy(animTargetLookAt);
        controls.enabled = true;
        controls.update();
        updateDoorOpacity(1.0);
      }
    }
  } else if (isFirstPerson) {
    updateDoorOpacity(0.0);

    // First Person WASD walking movement
    let moveForward = (fpKeys.forward ? 1 : 0) - (fpKeys.backward ? 1 : 0);
    let moveRight = (fpKeys.right ? 1 : 0) - (fpKeys.left ? 1 : 0);

    if (moveForward !== 0 || moveRight !== 0) {
      const len = Math.hypot(moveForward, moveRight);
      moveForward /= len;
      moveRight /= len;

      const walkSpeed = 3.4 * dt; // 3.4 m/s walking speed

      const dirX = -Math.sin(fpYaw);
      const dirZ = -Math.cos(fpYaw);
      const rightX = Math.cos(fpYaw);
      const rightZ = -Math.sin(fpYaw);

      fpPos.x += (dirX * moveForward + rightX * moveRight) * walkSpeed;
      fpPos.z += (dirZ * moveForward + rightZ * moveRight) * walkSpeed;
    }

    fpPos.y = EYE_HEIGHT;
    camera.position.copy(fpPos);

    const lookDir = getFPLookDirection();
    camera.lookAt(fpPos.clone().add(lookDir));
  } else {
    controls.update();
  }

  // Dynamic wall scale calculation
  const targetScale = wallsHidden ? 0.05 : 1.0;

  if (Math.abs(wallScaleY - targetScale) > 0.0001 || Math.abs(wallScaleVelocity) > 0.0001) {
    if (reduceMotion) {
      wallScaleY = targetScale;
      wallScaleVelocity = 0;
    } else if (wallsHidden) {
      // Linear ease-down (clean exit transition)
      wallScaleY = THREE.MathUtils.lerp(wallScaleY, targetScale, dt * (1 / transitionDuration) * 8);
    } else {
      // Spring simulation (bouncy elastic return transition)
      const displacement = wallScaleY - targetScale;
      const springForce = -springStiffness * displacement;
      const dampingForce = -springDamping * wallScaleVelocity;
      const acceleration = springForce + dampingForce;

      wallScaleVelocity += acceleration * dt;
      wallScaleY += wallScaleVelocity * dt;
    }

    // Apply scale to wall groups (excluding furniture and labels)
    if (floorplanGroup) {
      floorplanGroup.children.forEach(child => {
        if (child instanceof THREE.Group && !child.name.startsWith('furniture_')) {
          child.scale.y = wallScaleY;
        }
      });
    }
  }

  renderer.render(scene, camera);
})();
