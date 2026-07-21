import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader }    from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader }   from 'three/addons/loaders/DRACOLoader.js';
import { GLTFExporter }  from 'three/addons/exporters/GLTFExporter.js';
import { downloadIfcModel } from './ifc-export.js';

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
renderer.setClearColor(0x181818);
viewport.appendChild(renderer.domElement);

const scene  = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(45, 1, 0.01, 5000);
camera.position.set(0, 18, 18);
camera.lookAt(0, 0, 0);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.dampingFactor = 0.08;
controls.screenSpacePanning = true;

const hemi = new THREE.HemisphereLight(0xffffff, 0xd0c8b0, 1.4);
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

const rim = new THREE.DirectionalLight(0xddeeff, 0.5);
rim.position.set(-20, 20, -20);
scene.add(rim);

renderer.toneMapping        = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.0;
renderer.outputColorSpace    = THREE.SRGBColorSpace;

const gridHelper = new THREE.GridHelper(200, 80, 0x303030, 0x282828);
gridHelper.position.y = -0.045;
scene.add(gridHelper);

const floorGeo  = new THREE.PlaneGeometry(300, 300);
const floorMat  = new THREE.MeshStandardMaterial({ color: 0x1c1c1c, roughness: 0.9 });
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
  wall:      new THREE.MeshStandardMaterial({ color: 0xc8c8c8, roughness: 0.7, metalness: 0.0 }),
  door:      new THREE.MeshStandardMaterial({ color: 0x8b7ec8, roughness: 0.5, transparent: true, opacity: 0.72 }),
  window:    new THREE.MeshStandardMaterial({ color: 0x6fa3c8, roughness: 0.1, metalness: 0.9, transparent: true, opacity: 0.35 }),
  furniture: new THREE.MeshStandardMaterial({ color: 0xe8855a, roughness: 0.6, transparent: true, opacity: 0.85 }),
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

// ─────────────────────────────────────────────
//  3D FURNITURE ASSET REGISTRY
// ─────────────────────────────────────────────
const FURNITURE_ASSETS_3D = {
  Waschbecken: 'assets/3d/waschbecken.glb',
  Herd:        'assets/3d/herd.glb',
  Toilette:    'assets/3d/toilette.glb',
  Bett:    'assets/3d/bett.glb',
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
                const col = m.color ? m.color.clone() : new THREE.Color(0xe8855a);
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
const P = {
  scale:    0.02,
  wallH:    2.8,
  doorH:    2.1,
  winSill:  0.9,
  winH:     1.3,
};

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
  document.getElementById('btn-download-glb').disabled = true;
  document.getElementById('btn-download-ifc').disabled = true;
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
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x222222, roughness: 0.5 });

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
      const frameMat = new THREE.MeshStandardMaterial({ color: 0x2a2421, roughness: 0.6 });

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

  // ── Build Joints (L-Junction Fillers) ──────────────
  const jointsGroup = new THREE.Group();
  jointsGroup.name = "jointsGroup";
  jointsGroup.userData.visualLayer = 'walls';
  jointsGroup.scale.y = wallScaleY;
  floorplanGroup.add(jointsGroup);

  const nodesMap = {};
  walls.forEach(w => {
    const sx = w.start.x.toFixed(2), sy = w.start.y.toFixed(2);
    const ex = w.end.x.toFixed(2), ey = w.end.y.toFixed(2);
    if (!nodesMap[sx+','+sy]) nodesMap[sx+','+sy] = [];
    nodesMap[sx+','+sy].push({ wall: w, isStart: true });
    
    if (!nodesMap[ex+','+ey]) nodesMap[ex+','+ey] = [];
    nodesMap[ex+','+ey].push({ wall: w, isStart: false });
  });

  function isHoriz(w) { return Math.abs(w.end.y - w.start.y) < Math.abs(w.end.x - w.start.x); }

  Object.values(nodesMap).forEach(list => {
    if (list.length === 2) {
      const w1 = list[0].wall, w2 = list[1].wall;
      const isH1 = isHoriz(w1), isH2 = isHoriz(w2);
      if (isH1 !== isH2) {
        const hw = isH1 ? w1 : w2;
        const vw = isH1 ? w2 : w1;
        
        const nodeX = list[0].isStart ? w1.start.x : w1.end.x;
        const nodeY = list[0].isStart ? w1.start.y : w1.end.y;
        
        const hwIsStart = Math.abs(hw.start.x - nodeX) < 0.1 && Math.abs(hw.start.y - nodeY) < 0.1;
        const vwIsStart = Math.abs(vw.start.x - nodeX) < 0.1 && Math.abs(vw.start.y - nodeY) < 0.1;
        
        const hwOther = hwIsStart ? hw.end : hw.start;
        const vwOther = vwIsStart ? vw.end : vw.start;
        
        const gapDirX = -Math.sign(hwOther.x - nodeX);
        const gapDirY = -Math.sign(vwOther.y - nodeY);
        
        const th = Math.max(hw.thickness * s, 0.01);
        const tv = Math.max(vw.thickness * s, 0.01);
        
        const w = tv / 2;
        const d = th / 2;
        
        const px = nodeX * s - centerX;
        const pz = nodeY * s - centerZ;
        
        const cx = gapDirX > 0 ? px + w/2 : px - w/2;
        const cz = gapDirY > 0 ? pz + d/2 : pz - d/2;
        
        const geo = new THREE.BoxGeometry(w, P.wallH, d);
        const mesh = new THREE.Mesh(geo, MAT.wall.clone());
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.position.set(cx, P.wallH / 2, cz);
        mesh.name = `joint_filler`;
        jointsGroup.add(mesh);
      }
    }
  });

  (data.furniture || []).forEach(item => {
    const fw  = item.width  * s;
    const fd  = item.height * s;
    const fh  = FURNITURE_HEIGHTS[item.class] ?? FURNITURE_DEFAULT_H;
    const fcx = item.center.x * s - centerX;
    const fcz = item.center.y * s - centerZ;
    const cached = gltfCache[item.class];

    if (cached) {
      const obj = cached.clone(true);
      const box = new THREE.Box3().setFromObject(obj);
      const sz  = new THREE.Vector3();
      box.getSize(sz);

      const scaleX = sz.x > 0 ? fw / sz.x : 1;
      const scaleZ = sz.z > 0 ? fd / sz.z : 1;
      const scaleY = sz.y > 0 ? fh / sz.y : Math.min(scaleX, scaleZ);
      obj.scale.set(scaleX, scaleY, scaleZ);

      const box2 = new THREE.Box3().setFromObject(obj);
      obj.position.set(fcx - (box2.min.x + box2.max.x) / 2,
                       -box2.min.y,
                       fcz - (box2.min.z + box2.max.z) / 2);
      obj.name = item.id;
      obj.userData.visualLayer = 'objects';
      obj.traverse(child => { if (child.isMesh) { child.castShadow = child.receiveShadow = true; } });
      floorplanGroup.add(obj);
    } else {
      const geo  = new THREE.BoxGeometry(fw, fh, fd);
      const mesh = new THREE.Mesh(geo, MAT.furniture.clone());
      mesh.position.set(fcx, fh / 2, fcz);
      mesh.castShadow = mesh.receiveShadow = true;
      mesh.name = item.id;
      mesh.userData.visualLayer = 'objects';
      floorplanGroup.add(mesh);
    }

    const cvs  = document.createElement('canvas');
    cvs.width  = 256; cvs.height = 64;
    const lctx = cvs.getContext('2d');
    lctx.fillStyle    = '#e8855a';
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
  document.getElementById('btn-download-glb').disabled = false;
  document.getElementById('btn-download-ifc').disabled = false;
  document.getElementById('model-status').innerHTML = '<span class="status-dot"></span>Ready';
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
  document.getElementById('model-status').innerHTML = '<span class="status-dot"></span>Building';
  requestAnimationFrame(() => {
    buildFloorplan(currentData);
    applyWireframe(document.getElementById('tog-wire').checked);
    applyTransparencyState();
    document.getElementById('loading').classList.remove('active');
  });
}

function loadData(json) {
  if (!json || !Array.isArray(json.walls)) throw new Error('Missing walls array');
  currentData = json;
  const calibratedScale = Number(json.metadata?.measurement?.meters_per_pixel);
  if (Number.isFinite(calibratedScale) && calibratedScale > 0) {
    P.scale = calibratedScale;
    const scaleSlider = document.getElementById('sl-scale');
    scaleSlider.value = String(Math.max(Number(scaleSlider.min), Math.min(Number(scaleSlider.max), calibratedScale)));
    document.getElementById('val-scale').textContent = calibratedScale.toFixed(4);
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
      loadData(JSON.parse(ev.target.result));
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

document.getElementById('btn-reset-camera').addEventListener('click', resetCamera);
document.getElementById('btn-toggle-walls').addEventListener('click', toggleWalls);

renderer.domElement.addEventListener('dblclick', resetCamera);

document.getElementById('btn-download-glb').addEventListener('click', async () => {
  if (!floorplanGroup || !currentData) return;
  const button = document.getElementById('btn-download-glb');
  button.disabled = true;
  button.textContent = 'Exporting…';
  try {
    const exportGroup = floorplanGroup.clone(true);
    const removable = [];
    exportGroup.traverse(obj => {
      if (obj.isSprite || obj.name === '__outline__') removable.push(obj);
    });
    removable.forEach(obj => obj.parent?.remove(obj));
    const result = await new GLTFExporter().parseAsync(exportGroup, {
      binary: true,
      onlyVisible: true,
      trs: false,
    });
    const blob = new Blob([result], { type: 'model/gltf-binary' });
    const anchor = document.createElement('a');
    const source = (localStorage.getItem('floorplan_source') || 'floorplan').replace(/\.[^.]+$/, '');
    anchor.href = URL.createObjectURL(blob);
    anchor.download = `${source.replace(/[^a-z0-9_-]+/gi, '_')}.glb`;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
    showToast('GLB model exported.');
  } catch (error) {
    console.error('GLB export failed', error);
    showToast('GLB export failed. Check the browser console.');
  } finally {
    button.disabled = false;
    button.textContent = 'Export GLB model';
  }
});

document.getElementById('btn-download-ifc').addEventListener('click', () => {
  if (!currentData?.walls?.length) return;
  const button = document.getElementById('btn-download-ifc');
  button.disabled = true;
  const originalLabel = button.textContent;
  button.textContent = 'Exporting…';
  try {
    const source = (localStorage.getItem('floorplan_source') || 'floorplan').replace(/\.[^.]+$/, '');
    downloadIfcModel(currentData, {
      fileName: `${source.replace(/[^a-z0-9_-]+/gi, '_')}.ifc`,
      scale: P.scale,
      wallHeight: P.wallH,
      doorHeight: P.doorH,
      windowSill: P.winSill,
      windowHeight: P.winH,
    });
    showToast('IFC4 model exported.');
  } catch (error) {
    console.error('IFC export failed', error);
    showToast(`IFC export failed: ${error.message}`);
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
});

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
    new THREE.MeshBasicMaterial({ color: 0xd39e53, wireframe: true })
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
  if (document.activeElement.tagName === 'INPUT') return;

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
  if (e.key === 'Escape') deselectFurniture();
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
  controls.update();

  // Dynamic wall scale calculation
  const dt = Math.min(animClock.getDelta(), 0.1);
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
