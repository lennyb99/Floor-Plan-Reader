// Geometry normalization and derived measurements for the Revise editor.
// Kept DOM-free so the same behavior can be verified from Node tests.
(function exposeReviseGeometry(globalScope) {
  const EPSILON = 0.01;

  function wallIsHorizontalGeometry(wall) {
    return Math.abs(wall.end.x - wall.start.x) >= Math.abs(wall.end.y - wall.start.y);
  }

  function wallPixelLength(wall) {
    return Math.hypot(wall.end.x - wall.start.x, wall.end.y - wall.start.y);
  }

  function ensureFloorplanCollections(data) {
    if (!data || !Array.isArray(data.walls)) return data;
    data.furniture = Array.isArray(data.furniture) ? data.furniture : [];
    data.metadata = data.metadata && typeof data.metadata === 'object' ? data.metadata : {};
    data.walls.forEach((wall, index) => {
      wall.id = wall.id || `wall_${String(index).padStart(4, '0')}`;
      wall.windows = Array.isArray(wall.windows) ? wall.windows : [];
      wall.doors = Array.isArray(wall.doors) ? wall.doors : [];
      wall.thickness = Math.max(2, Number(wall.thickness) || 8);
    });
    return data;
  }

  function pointOnAxisSegment(value, a, b, tolerance = EPSILON) {
    return value >= Math.min(a, b) - tolerance && value <= Math.max(a, b) + tolerance;
  }

  function endpointNearIntersection(wall, intersection, tolerance) {
    const endpoints = ['start', 'end'];
    let best = null;
    endpoints.forEach(endpoint => {
      const point = wall[endpoint];
      const distance = Math.hypot(point.x - intersection.x, point.y - intersection.y);
      if (distance <= tolerance && (!best || distance < best.distance)) {
        best = { endpoint, distance };
      }
    });
    return best;
  }

  function endpointHasCollinearSibling(walls, wall, endpoint, tolerance) {
    if (!Array.isArray(walls)) return false;
    const point = wall[endpoint];
    const wallHorizontal = wallIsHorizontalGeometry(wall);
    return walls.some(other => {
      if (!other || other === wall || other.id === wall.id) return false;
      if (wallIsHorizontalGeometry(other) !== wallHorizontal) return false;
      if (wall.source_wall_id && other.source_wall_id && wall.source_wall_id !== other.source_wall_id) return false;
      return ['start', 'end'].some(otherEndpoint => {
        const otherPoint = other[otherEndpoint];
        return Math.hypot(otherPoint.x - point.x, otherPoint.y - point.y) <= tolerance;
      });
    });
  }

  function snapPerpendicularCenterlines(walls) {
    let snapped = 0;
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const first = walls[i];
        const second = walls[j];
        if (wallIsHorizontalGeometry(first) === wallIsHorizontalGeometry(second)) continue;
        const horizontal = wallIsHorizontalGeometry(first) ? first : second;
        const vertical = horizontal === first ? second : first;
        const intersection = {
          x: (vertical.start.x + vertical.end.x) / 2,
          y: (horizontal.start.y + horizontal.end.y) / 2,
        };
        const tolerance = Math.max(4, (horizontal.thickness + vertical.thickness) / 2 + 2);
        const horizontalInRange = pointOnAxisSegment(
          intersection.x,
          horizontal.start.x,
          horizontal.end.x,
          tolerance,
        );
        const verticalInRange = pointOnAxisSegment(
          intersection.y,
          vertical.start.y,
          vertical.end.y,
          tolerance,
        );
        if (!horizontalInRange || !verticalInRange) continue;

        const horizontalEnd = endpointNearIntersection(horizontal, intersection, tolerance);
        const verticalEnd = endpointNearIntersection(vertical, intersection, tolerance);
        if (!horizontalEnd && !verticalEnd) continue;

        if (horizontalEnd) {
          const point = horizontal[horizontalEnd.endpoint];
          if (Math.hypot(point.x - intersection.x, point.y - intersection.y) > EPSILON) snapped++;
          point.x = intersection.x;
          point.y = intersection.y;
        }
        if (verticalEnd) {
          const point = vertical[verticalEnd.endpoint];
          if (Math.hypot(point.x - intersection.x, point.y - intersection.y) > EPSILON) snapped++;
          point.x = intersection.x;
          point.y = intersection.y;
        }
      }
    }
    return snapped;
  }

  function endpointFacingEdge(wall, endpoint, center, halfThickness) {
    const other = wall[endpoint === 'start' ? 'end' : 'start'];
    if (wallIsHorizontalGeometry(wall)) {
      return center.x + (other.x < center.x ? -halfThickness : halfThickness);
    }
    return center.y + (other.y < center.y ? -halfThickness : halfThickness);
  }

  function endpointFarEdge(wall, endpoint, center, halfThickness) {
    const facingEdge = endpointFacingEdge(wall, endpoint, center, halfThickness);
    return wallIsHorizontalGeometry(wall)
      ? center.x * 2 - facingEdge
      : center.y * 2 - facingEdge;
  }

  function wallHalfThickness(wall) {
    return Math.max(1, Number(wall.thickness) / 2 || 4);
  }

  function snapWallEndpointToVisibleEdges(walls, movingWall, endpoint, proposedPoint, tolerance = 10) {
    if (!Array.isArray(walls) || !movingWall || !proposedPoint) {
      return { point: proposedPoint, snapped: false };
    }
    const movingHorizontal = wallIsHorizontalGeometry(movingWall);
    let best = null;
    walls.forEach(host => {
      if (!host || host === movingWall || host.id === movingWall.id) return;
      if (wallIsHorizontalGeometry(host) === movingHorizontal) return;
      const hostHorizontal = wallIsHorizontalGeometry(host);
      const hostCenter = hostHorizontal
        ? (host.start.y + host.end.y) / 2
        : (host.start.x + host.end.x) / 2;
      const hostStart = hostHorizontal ? host.start.x : host.start.y;
      const hostEnd = hostHorizontal ? host.end.x : host.end.y;
      const along = movingHorizontal ? proposedPoint.y : proposedPoint.x;
      if (!pointOnAxisSegment(along, hostStart, hostEnd, tolerance)) return;

      const intersection = movingHorizontal
        ? { x: hostCenter, y: proposedPoint.y }
        : { x: proposedPoint.x, y: hostCenter };
      const hostEndpoint = endpointNearIntersection(host, intersection, tolerance);
      const hostContinues = hostEndpoint
        ? endpointHasCollinearSibling(walls, host, hostEndpoint.endpoint, tolerance)
        : false;
      const isLJunction = Boolean(hostEndpoint && !hostContinues);
      const hostHalfThickness = wallHalfThickness(host);
      const facingScalar = endpointFacingEdge(movingWall, endpoint, intersection, hostHalfThickness);
      const targetScalar = isLJunction && !movingHorizontal
        ? endpointFarEdge(movingWall, endpoint, intersection, hostHalfThickness)
        : facingScalar;
      const currentScalar = movingHorizontal ? proposedPoint.x : proposedPoint.y;
      const distance = isLJunction
        ? Math.min(Math.abs(currentScalar - targetScalar), Math.abs(currentScalar - facingScalar))
        : Math.abs(currentScalar - targetScalar);
      if (distance > tolerance) return;
      if (best && distance >= best.distance) return;
      best = {
        distance,
        host,
        point: movingHorizontal
          ? { x: targetScalar, y: proposedPoint.y }
          : { x: proposedPoint.x, y: targetScalar },
      };
    });
    return best
      ? { point: best.point, snapped: true, targetWallId: best.host.id }
      : { point: proposedPoint, snapped: false };
  }

  /**
   * Convert centerline junctions into visible butt joints.
   *
   * T junctions keep the host centerline continuous while the incoming wall
   * endpoint snaps to the host's visible outside edge. L junctions trim both
   * endpoints to the other wall's visible edge, so the two wall bodies meet
   * cleanly without needing extra patch rectangles in Revise, 3D or IFC.
   */
  function snapPerpendicularJunctions(walls) {
    let snapped = 0;
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const first = walls[i];
        const second = walls[j];
        if (wallIsHorizontalGeometry(first) === wallIsHorizontalGeometry(second)) continue;
        const horizontal = wallIsHorizontalGeometry(first) ? first : second;
        const vertical = horizontal === first ? second : first;
        const intersection = {
          x: (vertical.start.x + vertical.end.x) / 2,
          y: (horizontal.start.y + horizontal.end.y) / 2,
        };
        const tolerance = Math.max(4, (horizontal.thickness + vertical.thickness) / 2 + 2);
        const horizontalInRange = pointOnAxisSegment(
          intersection.x,
          horizontal.start.x,
          horizontal.end.x,
          tolerance,
        );
        const verticalInRange = pointOnAxisSegment(
          intersection.y,
          vertical.start.y,
          vertical.end.y,
          tolerance,
        );
        if (!horizontalInRange || !verticalInRange) continue;

        const horizontalEnd = endpointNearIntersection(horizontal, intersection, tolerance);
        const verticalEnd = endpointNearIntersection(vertical, intersection, tolerance);
        if (!horizontalEnd && !verticalEnd) continue;

        const verticalContinues = verticalEnd
          ? endpointHasCollinearSibling(walls, vertical, verticalEnd.endpoint, tolerance)
          : false;
        const horizontalContinues = horizontalEnd
          ? endpointHasCollinearSibling(walls, horizontal, horizontalEnd.endpoint, tolerance)
          : false;
        const trueLJunction = Boolean(horizontalEnd && verticalEnd && !horizontalContinues && !verticalContinues);
        if (verticalEnd && (!horizontalEnd || !verticalContinues)) {
          const point = vertical[verticalEnd.endpoint];
          const targetY = trueLJunction
            ? endpointFarEdge(vertical, verticalEnd.endpoint, intersection, horizontal.thickness / 2)
            : endpointFacingEdge(vertical, verticalEnd.endpoint, intersection, horizontal.thickness / 2);
          if (Math.hypot(point.x - intersection.x, point.y - targetY) > EPSILON) snapped++;
          point.x = intersection.x;
          point.y = targetY;
        }

        if (horizontalEnd && (!verticalEnd || !horizontalContinues)) {
          const point = horizontal[horizontalEnd.endpoint];
          const targetX = endpointFacingEdge(
            horizontal,
            horizontalEnd.endpoint,
            intersection,
            vertical.thickness / 2,
          );
          if (Math.hypot(point.x - targetX, point.y - intersection.y) > EPSILON) snapped++;
          point.x = targetX;
          point.y = intersection.y;
        }
      }
    }
    return snapped;
  }

  function segmentParameter(wall, point) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;
    const denominator = dx * dx + dy * dy;
    if (denominator < EPSILON) return 0;
    return ((point.x - wall.start.x) * dx + (point.y - wall.start.y) * dy) / denominator;
  }

  function interpolationPoint(wall, t) {
    return {
      x: wall.start.x + (wall.end.x - wall.start.x) * t,
      y: wall.start.y + (wall.end.y - wall.start.y) * t,
    };
  }

  function collectIntersectionCuts(walls) {
    const cuts = walls.map(() => [0, 1]);
    let crossSections = 0;
    for (let i = 0; i < walls.length; i++) {
      for (let j = i + 1; j < walls.length; j++) {
        const first = walls[i];
        const second = walls[j];
        if (wallIsHorizontalGeometry(first) === wallIsHorizontalGeometry(second)) continue;
        const horizontal = wallIsHorizontalGeometry(first) ? first : second;
        const vertical = horizontal === first ? second : first;
        const intersection = {
          x: (vertical.start.x + vertical.end.x) / 2,
          y: (horizontal.start.y + horizontal.end.y) / 2,
        };
        if (!pointOnAxisSegment(intersection.x, horizontal.start.x, horizontal.end.x)) continue;
        if (!pointOnAxisSegment(intersection.y, vertical.start.y, vertical.end.y)) continue;

        const firstT = segmentParameter(first, intersection);
        const secondT = segmentParameter(second, intersection);
        const firstInterior = firstT > EPSILON && firstT < 1 - EPSILON;
        const secondInterior = secondT > EPSILON && secondT < 1 - EPSILON;
        if (!firstInterior && !secondInterior) continue;
        if (firstInterior) cuts[i].push(firstT);
        if (secondInterior) cuts[j].push(secondT);
        crossSections++;
      }
    }
    return { cuts, crossSections };
  }

  function openingExtentAlongWall(wall, opening) {
    const horizontal = wallIsHorizontalGeometry(wall);
    return Math.max(1, Number(opening.opening_width)
      || Number(horizontal ? opening.width : opening.height)
      || Number(horizontal ? opening.height : opening.width)
      || 1);
  }

  function attachOpeningToSegment(originalWall, segments, opening) {
    const t = Math.max(0, Math.min(1, segmentParameter(originalWall, opening.center)));
    const scalar = wallIsHorizontalGeometry(originalWall) ? opening.center.x : opening.center.y;
    const halfExtent = openingExtentAlongWall(originalWall, opening) / 2;
    let bestIndex = 0;
    let bestScore = -Infinity;
    segments.forEach((segment, index) => {
      const startScalar = wallIsHorizontalGeometry(segment) ? segment.start.x : segment.start.y;
      const endScalar = wallIsHorizontalGeometry(segment) ? segment.end.x : segment.end.y;
      const min = Math.min(startScalar, endScalar);
      const max = Math.max(startScalar, endScalar);
      const fullyFits = scalar - halfExtent >= min - EPSILON && scalar + halfExtent <= max + EPSILON;
      const containsCenter = scalar >= min - EPSILON && scalar <= max + EPSILON;
      const midpoint = (min + max) / 2;
      const score = (fullyFits ? 100000 : 0) + (containsCenter ? 10000 : 0) - Math.abs(scalar - midpoint);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = index;
      }
    });
    const segment = segments[bestIndex];
    const horizontal = wallIsHorizontalGeometry(segment);
    const startScalar = horizontal ? segment.start.x : segment.start.y;
    const endScalar = horizontal ? segment.end.x : segment.end.y;
    const min = Math.min(startScalar, endScalar);
    const max = Math.max(startScalar, endScalar);
    const inset = Math.min(halfExtent, Math.max(0, (max - min) / 2));
    const clamped = Math.max(min + inset, Math.min(max - inset, scalar));
    opening.center = {
      x: horizontal ? clamped : segment.start.x,
      y: horizontal ? segment.start.y : clamped,
    };
    // Keep a stable reference for diagnostics even after multiple splits.
    opening.wall_position = Number(t.toFixed(6));
    return bestIndex;
  }

  function uniqueWallId(preferred, usedIds) {
    if (!usedIds.has(preferred)) {
      usedIds.add(preferred);
      return preferred;
    }
    let suffix = 1;
    while (usedIds.has(`${preferred}__${suffix}`)) suffix++;
    const id = `${preferred}__${suffix}`;
    usedIds.add(id);
    return id;
  }

  function splitWallsAtIntersections(walls) {
    const { cuts, crossSections } = collectIntersectionCuts(walls);
    const reservedIds = new Set(walls.map(wall => wall.id));
    const output = [];
    let createdSegments = 0;

    walls.forEach((wall, wallIndex) => {
      const values = [...cuts[wallIndex]]
        .sort((a, b) => a - b)
        .filter((value, index, array) => index === 0 || Math.abs(value - array[index - 1]) > EPSILON);
      if (values.length <= 2) {
        output.push(wall);
        return;
      }

      const segments = [];
      for (let index = 0; index < values.length - 1; index++) {
        const start = interpolationPoint(wall, values[index]);
        const end = interpolationPoint(wall, values[index + 1]);
        if (Math.hypot(end.x - start.x, end.y - start.y) < 1) continue;
        const preferredId = index === 0 ? wall.id : `${wall.id}__${index}`;
        if (index === 0) reservedIds.delete(wall.id);
        segments.push({
          ...wall,
          id: uniqueWallId(preferredId, reservedIds),
          source_wall_id: wall.source_wall_id || wall.id,
          start,
          end,
          windows: [],
          doors: [],
        });
      }
      (wall.windows || []).forEach(opening => {
        const index = attachOpeningToSegment(wall, segments, opening);
        segments[index].windows.push(opening);
      });
      (wall.doors || []).forEach(opening => {
        const index = attachOpeningToSegment(wall, segments, opening);
        segments[index].doors.push(opening);
      });
      output.push(...segments);
      createdSegments += Math.max(0, segments.length - 1);
    });
    return { walls: output, crossSections, createdSegments };
  }

  function normalizeFloorplanTopology(data) {
    ensureFloorplanCollections(data);
    if (!data?.walls) return { changed: false, snapped: 0, crossSections: 0, createdSegments: 0 };
    // First align near misses on their centerlines so that every actual
    // cross-section can be discovered and split. Only then convert endpoints
    // to visible wall-edge joints.
    const centerlineSnapped = snapPerpendicularCenterlines(data.walls);
    const split = splitWallsAtIntersections(data.walls);
    data.walls = split.walls;
    const edgeSnapped = snapPerpendicularJunctions(data.walls);
    const snapped = centerlineSnapped + edgeSnapped;
    data.metadata.topology = {
      ...(data.metadata.topology || {}),
      normalized: true,
      snapped_junctions: snapped,
      centerline_snapped_junctions: centerlineSnapped,
      edge_snapped_junctions: edgeSnapped,
      cross_sections: split.crossSections,
      created_segments: split.createdSegments,
    };
    return {
      changed: snapped > 0 || split.createdSegments > 0,
      snapped,
      crossSections: split.crossSections,
      createdSegments: split.createdSegments,
    };
  }

  function getMetersPerPixel(data) {
    const factor = Number(data?.metadata?.measurement?.meters_per_pixel);
    return Number.isFinite(factor) && factor > 0 ? factor : null;
  }

  function setScaleFromReferenceWall(data, wall, realLengthMeters) {
    const pixels = wallPixelLength(wall);
    const meters = Number(realLengthMeters);
    if (!Number.isFinite(meters) || meters <= 0 || pixels <= EPSILON) return null;
    const metersPerPixel = meters / pixels;
    data.metadata = data.metadata || {};
    data.metadata.measurement = {
      ...(data.metadata.measurement || {}),
      meters_per_pixel: Number(metersPerPixel.toFixed(9)),
      reference_wall_id: wall.id,
      reference_length_m: Number(meters.toFixed(4)),
      reference_length_px: Number(pixels.toFixed(4)),
    };
    return metersPerPixel;
  }

  function calculateRooms(data, width = 512, height = 512) {
    if (!data?.walls?.length) return [];
    const occupancy = new Uint8Array(width * height);
    const paint = (x0, y0, x1, y1) => {
      const left = Math.max(0, Math.floor(Math.min(x0, x1)));
      const right = Math.min(width - 1, Math.ceil(Math.max(x0, x1)));
      const top = Math.max(0, Math.floor(Math.min(y0, y1)));
      const bottom = Math.min(height - 1, Math.ceil(Math.max(y0, y1)));
      for (let y = top; y <= bottom; y++) {
        const offset = y * width;
        for (let x = left; x <= right; x++) occupancy[offset + x] = 1;
      }
    };
    data.walls.forEach(wall => {
      const half = Math.max(1.5, Number(wall.thickness) / 2 || 4);
      if (wallIsHorizontalGeometry(wall)) {
        paint(wall.start.x, wall.start.y - half, wall.end.x, wall.start.y + half);
      } else {
        paint(wall.start.x - half, wall.start.y, wall.start.x + half, wall.end.y);
      }
    });

    const visited = new Uint8Array(width * height);
    const rooms = [];
    const queueX = new Int32Array(width * height);
    const queueY = new Int32Array(width * height);
    const factor = getMetersPerPixel(data);
    for (let startY = 0; startY < height; startY++) {
      for (let startX = 0; startX < width; startX++) {
        const startIndex = startY * width + startX;
        if (occupancy[startIndex] || visited[startIndex]) continue;
        let head = 0;
        let tail = 0;
        queueX[tail] = startX;
        queueY[tail++] = startY;
        visited[startIndex] = 1;
        let area = 0;
        let sumX = 0;
        let sumY = 0;
        let touchesBoundary = false;
        while (head < tail) {
          const x = queueX[head];
          const y = queueY[head++];
          area++;
          sumX += x;
          sumY += y;
          if (x === 0 || y === 0 || x === width - 1 || y === height - 1) touchesBoundary = true;
          const neighbors = [[x - 1, y], [x + 1, y], [x, y - 1], [x, y + 1]];
          neighbors.forEach(([nx, ny]) => {
            if (nx < 0 || ny < 0 || nx >= width || ny >= height) return;
            const index = ny * width + nx;
            if (occupancy[index] || visited[index]) return;
            visited[index] = 1;
            queueX[tail] = nx;
            queueY[tail++] = ny;
          });
        }
        if (!touchesBoundary && area >= 80) {
          rooms.push({
            id: `room_${String(rooms.length + 1).padStart(2, '0')}`,
            center: { x: sumX / area, y: sumY / area },
            area_px2: area,
            area_m2: factor ? area * factor * factor : null,
          });
        }
      }
    }
    return rooms.sort((a, b) => b.area_px2 - a.area_px2).map((room, index) => ({
      ...room,
      id: `room_${String(index + 1).padStart(2, '0')}`,
    }));
  }

  const api = {
    wallIsHorizontalGeometry,
    wallPixelLength,
    openingExtentAlongWall,
    ensureFloorplanCollections,
    snapWallEndpointToVisibleEdges,
    snapPerpendicularJunctions,
    splitWallsAtIntersections,
    normalizeFloorplanTopology,
    getMetersPerPixel,
    setScaleFromReferenceWall,
    calculateRooms,
  };
  Object.assign(globalScope, api);
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
