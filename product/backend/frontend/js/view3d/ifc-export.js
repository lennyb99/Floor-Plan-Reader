const IFC_GUID_ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_$';

function ifcGuid(seed = '') {
  let hash = 2166136261;
  for (let index = 0; index < seed.length; index++) {
    hash ^= seed.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  let value = hash >>> 0;
  let result = '';
  for (let index = 0; index < 22; index++) {
    value = (Math.imul(value ^ (index + 1), 1664525) + 1013904223) >>> 0;
    result += IFC_GUID_ALPHABET[value % IFC_GUID_ALPHABET.length];
  }
  return result;
}

function ifcString(value) {
  return `'${String(value ?? '').replace(/'/g, "''")}'`;
}

function ifcNumber(value) {
  const number = Number(value) || 0;
  if (Math.abs(number) < 1e-9) return '0.';
  const formatted = number.toFixed(6).replace(/0+$/, '').replace(/\.$/, '.');
  return formatted.includes('.') ? formatted : `${formatted}.`;
}

class IfcWriter {
  constructor() {
    this.entities = [];
  }

  add(expression) {
    const id = this.entities.length + 1;
    this.entities.push(`#${id}=${expression};`);
    return `#${id}`;
  }
}

function addPlacement(writer, parentPlacement, x, y, z, angle = 0) {
  const point = writer.add(`IFCCARTESIANPOINT((${ifcNumber(x)},${ifcNumber(y)},${ifcNumber(z)}))`);
  const direction = writer.add(`IFCDIRECTION((${ifcNumber(Math.cos(angle))},${ifcNumber(Math.sin(angle))},0.))`);
  const axis = writer.add(`IFCAXIS2PLACEMENT3D(${point},$,${direction})`);
  return writer.add(`IFCLOCALPLACEMENT(${parentPlacement || '$'},${axis})`);
}

function addBoxRepresentation(writer, context, length, width, height) {
  const solid = addBoxSolid(writer, length, width, height, 0, 0, 0, 0);
  const representation = writer.add(`IFCSHAPEREPRESENTATION(${context},'Body','SweptSolid',(${solid}))`);
  return writer.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${representation}))`);
}

function addBoxSolid(writer, length, width, height, x, y, z = 0, angle = 0) {
  const origin = writer.add('IFCCARTESIANPOINT((0.,0.,0.))');
  const direction = writer.add(`IFCDIRECTION((${ifcNumber(Math.cos(angle))},${ifcNumber(Math.sin(angle))},0.))`);
  const point = writer.add(`IFCCARTESIANPOINT((${ifcNumber(x)},${ifcNumber(y)},${ifcNumber(z)}))`);
  const placement = (Math.abs(x) < 1e-9 && Math.abs(y) < 1e-9 && Math.abs(z) < 1e-9 && Math.abs(angle) < 1e-9)
    ? writer.add(`IFCAXIS2PLACEMENT3D(${origin},$,$)`)
    : writer.add(`IFCAXIS2PLACEMENT3D(${point},$,${direction})`);
  const profile = writer.add(`IFCRECTANGLEPROFILEDEF(.AREA.,$,$,${ifcNumber(length)},${ifcNumber(width)})`);
  const extrusionDirection = writer.add('IFCDIRECTION((0.,0.,1.))');
  return writer.add(`IFCEXTRUDEDAREASOLID(${profile},${placement},${extrusionDirection},${ifcNumber(height)})`);
}

function addMultiBoxRepresentation(writer, context, boxes) {
  const solids = boxes
    .filter(box => box.length > 0.001 && box.width > 0.001 && box.height > 0.001)
    .map(box => addBoxSolid(
      writer,
      box.length,
      box.width,
      box.height,
      box.x,
      box.y,
      box.z || 0,
      box.angle || 0,
    ));
  const representation = writer.add(`IFCSHAPEREPRESENTATION(${context},'Body','SweptSolid',(${solids.join(',')}))`);
  return writer.add(`IFCPRODUCTDEFINITIONSHAPE($,$,(${representation}))`);
}

function openingWidth(wall, opening) {
  const horizontal = Math.abs(wall.end.x - wall.start.x) >= Math.abs(wall.end.y - wall.start.y);
  return Number(opening.opening_width)
    || Number(horizontal ? opening.width : opening.height)
    || Number(horizontal ? opening.height : opening.width)
    || 40;
}

function wallIsHorizontal(wall) {
  return Math.abs(wall.end.x - wall.start.x) >= Math.abs(wall.end.y - wall.start.y);
}

function furnitureIfcAngle(item) {
  if (Number.isFinite(Number(item?.rotation))) return -Number(item.rotation) * Math.PI / 180;
  return Number(item?._rotationY) || 0;
}

export function buildIfcModel(data, options = {}) {
  if (!data || !Array.isArray(data.walls) || data.walls.length === 0) {
    throw new Error('IFC export requires at least one wall.');
  }
  const scale = Number(options.scale) > 0 ? Number(options.scale) : 0.02;
  const wallHeight = Number(options.wallHeight) > 0 ? Number(options.wallHeight) : 2.8;
  const doorHeight = Number(options.doorHeight) > 0 ? Number(options.doorHeight) : 2.1;
  const windowSill = Math.max(0, Number(options.windowSill) || 0.9);
  const windowHeight = Number(options.windowHeight) > 0 ? Number(options.windowHeight) : 1.3;
  const writer = new IfcWriter();
  const timestamp = Math.floor(Date.now() / 1000);

  const person = writer.add("IFCPERSON($,$,'Floor Plan Reader',$,$,$,$,$)");
  const organization = writer.add("IFCORGANIZATION($,'Floor Plan Reader',$,$,$)");
  const personOrganization = writer.add(`IFCPERSONANDORGANIZATION(${person},${organization},$)`);
  const application = writer.add(`IFCAPPLICATION(${organization},'1.0','Floor Plan Reader','FPR')`);
  const history = writer.add(`IFCOWNERHISTORY(${personOrganization},${application},$,.ADDED.,$,$,$,${timestamp})`);
  const worldPoint = writer.add('IFCCARTESIANPOINT((0.,0.,0.))');
  const worldAxis = writer.add(`IFCAXIS2PLACEMENT3D(${worldPoint},$,$)`);
  const context = writer.add(`IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-5,${worldAxis},$)`);
  const lengthUnit = writer.add('IFCSIUNIT(*,.LENGTHUNIT.,$,.METRE.)');
  const areaUnit = writer.add('IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.)');
  const volumeUnit = writer.add('IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.)');
  const units = writer.add(`IFCUNITASSIGNMENT((${lengthUnit},${areaUnit},${volumeUnit}))`);
  const project = writer.add(`IFCPROJECT(${ifcString(ifcGuid('project'))},${history},'Floor Plan Reader Project',$,$,$,$,(${context}),${units})`);
  const rootPlacement = writer.add(`IFCLOCALPLACEMENT($,${worldAxis})`);
  const site = writer.add(`IFCSITE(${ifcString(ifcGuid('site'))},${history},'Site',$,$,${rootPlacement},$,$,.ELEMENT.,$,$,$,$,$)`);
  const buildingPlacement = writer.add(`IFCLOCALPLACEMENT(${rootPlacement},${worldAxis})`);
  const building = writer.add(`IFCBUILDING(${ifcString(ifcGuid('building'))},${history},'Building',$,$,${buildingPlacement},$,$,.ELEMENT.,$,$,$)`);
  const storeyPlacement = writer.add(`IFCLOCALPLACEMENT(${buildingPlacement},${worldAxis})`);
  const storey = writer.add(`IFCBUILDINGSTOREY(${ifcString(ifcGuid('storey'))},${history},'Ground Floor',$,$,${storeyPlacement},$,$,.ELEMENT.,0.)`);
  writer.add(`IFCRELAGGREGATES(${ifcString(ifcGuid('project-site'))},${history},$,$,${project},(${site}))`);
  writer.add(`IFCRELAGGREGATES(${ifcString(ifcGuid('site-building'))},${history},$,$,${site},(${building}))`);
  writer.add(`IFCRELAGGREGATES(${ifcString(ifcGuid('building-storey'))},${history},$,$,${building},(${storey}))`);

  const containedProducts = [];
  const wallBoxes = [];
  data.walls.forEach(wall => {
    const dx = (wall.end.x - wall.start.x) * scale;
    const dy = (wall.end.y - wall.start.y) * scale;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    const angle = Math.atan2(dy, dx);
    const thickness = Math.max(Number(wall.thickness) * scale || 0.12, 0.01);
    const midpointX = ((wall.start.x + wall.end.x) / 2) * scale;
    const midpointY = ((wall.start.y + wall.end.y) / 2) * scale;
    wallBoxes.push({ length, width: thickness, height: wallHeight, x: midpointX, y: midpointY, angle });
  });
  const wallSystemPlacement = addPlacement(writer, storeyPlacement, 0, 0, 0, 0);
  const wallSystemShape = addMultiBoxRepresentation(writer, context, wallBoxes);
  const wallSystem = writer.add(`IFCWALL(${ifcString(ifcGuid('wall-system'))},${history},'Wall Structure',$,$,${wallSystemPlacement},${wallSystemShape},$,.STANDARD.)`);
  containedProducts.push(wallSystem);

  data.walls.forEach((wall) => {
    const dx = (wall.end.x - wall.start.x) * scale;
    const dy = (wall.end.y - wall.start.y) * scale;
    const length = Math.hypot(dx, dy);
    if (length < 0.001) return;
    const angle = Math.atan2(dy, dx);
    const thickness = Math.max(Number(wall.thickness) * scale || 0.12, 0.01);
    (wall.doors || []).forEach((door, doorIndex) => {
      const width = openingWidth(wall, door) * scale;
      const x = Number(door.center.x) * scale;
      const y = Number(door.center.y) * scale;
      const doorPlacement = addPlacement(writer, storeyPlacement, x, y, 0, angle);
      const doorShape = addBoxRepresentation(writer, context, width, Math.max(thickness * 0.35, 0.025), doorHeight);
      const doorEntity = writer.add(`IFCDOOR(${ifcString(ifcGuid(`door-${wall.id}-${doorIndex}`))},${history},${ifcString(`Door ${door.detection_id ?? doorIndex + 1}`)},$,$,${doorPlacement},${doorShape},$,${ifcNumber(doorHeight)},${ifcNumber(width)},.DOOR.,.NOTDEFINED.,$)`);
      containedProducts.push(doorEntity);
    });

    (wall.windows || []).forEach((window, windowIndex) => {
      const width = openingWidth(wall, window) * scale;
      const x = Number(window.center.x) * scale;
      const y = Number(window.center.y) * scale;
      const windowPlacement = addPlacement(writer, storeyPlacement, x, y, windowSill, angle);
      const windowShape = addBoxRepresentation(writer, context, width, Math.max(thickness * 0.25, 0.02), windowHeight);
      const windowEntity = writer.add(`IFCWINDOW(${ifcString(ifcGuid(`window-${wall.id}-${windowIndex}`))},${history},${ifcString(`Window ${window.detection_id ?? windowIndex + 1}`)},$,$,${windowPlacement},${windowShape},$,${ifcNumber(windowHeight)},${ifcNumber(width)},.WINDOW.,.NOTDEFINED.,$)`);
      containedProducts.push(windowEntity);
    });
  });

  (data.furniture || []).forEach((item, index) => {
    const width = Math.max(0.05, Number(item.width) * scale || 0.5);
    const depth = Math.max(0.05, Number(item.height) * scale || 0.5);
    const height = 0.7;
    const placement = addPlacement(
      writer,
      storeyPlacement,
      Number(item.center?.x) * scale || 0,
      Number(item.center?.y) * scale || 0,
      0,
      furnitureIfcAngle(item),
    );
    const representation = addBoxRepresentation(writer, context, width, depth, height);
    const entity = writer.add(`IFCBUILDINGELEMENTPROXY(${ifcString(ifcGuid(`furniture-${index}`))},${history},${ifcString(item.class || `Furniture ${index + 1}`)},$,$,${placement},${representation},$,.ELEMENT.)`);
    containedProducts.push(entity);
  });

  writer.add(`IFCRELCONTAINEDINSPATIALSTRUCTURE(${ifcString(ifcGuid('storey-products'))},${history},$,$,(${containedProducts.join(',')}),${storey})`);

  return [
    'ISO-10303-21;',
    'HEADER;',
    "FILE_DESCRIPTION(('ViewDefinition [ReferenceView]'),'2;1');",
    `FILE_NAME(${ifcString(options.fileName || 'floorplan.ifc')},${ifcString(new Date().toISOString())},('Floor Plan Reader'),('Floor Plan Reader'),'Floor Plan Reader','Floor Plan Reader','');`,
    "FILE_SCHEMA(('IFC4'));",
    'ENDSEC;',
    'DATA;',
    ...writer.entities,
    'ENDSEC;',
    'END-ISO-10303-21;',
    '',
  ].join('\n');
}

export function downloadIfcModel(data, options = {}) {
  const content = buildIfcModel(data, options);
  const blob = new Blob([content], { type: 'application/x-step' });
  const anchor = document.createElement('a');
  anchor.href = URL.createObjectURL(blob);
  anchor.download = options.fileName || 'floorplan.ifc';
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(anchor.href), 0);
}
