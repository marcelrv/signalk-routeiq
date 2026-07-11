/**
 * Consumption of `navmesh_regions` (routing-database-format-specification.md
 * §2.9/§6): point location, entry/exit triangle lookup, a Dijkstra corridor
 * search over the triangle dual graph, and the Simple Stupid Funnel
 * Algorithm producing the exact taut polyline through an open-water region.
 *
 * Pure geometry — no dependency on database.ts/routing.ts (database.ts is
 * the only importer, keeping the existing routing.ts -> database.ts ->
 * db-worker.ts layering intact).
 */

const EARTH_RADIUS_M = 6371000;

export interface NavmeshRegion {
  regionId: number;
  boundaryGeometry: GeoJSON.Polygon | GeoJSON.MultiPolygon;
  vertices: Array<[number, number]>; // [lat, lon], index 0..n-1
  triangles: Array<[number, number, number]>; // vertex-index triples, normalized CCW
  triangleCentroids: Array<[number, number]>; // parallel to triangles
  triangleBBoxes: Float64Array; // 4 floats/triangle: minLon,minLat,maxLon,maxLat
  adjacency: Map<number, Array<{ neighbor: number; a: number; b: number }>>; // triangle idx -> neighbors, edge (a->b) is this triangle's own CCW-ordered shared edge
  vertexToTriangles: Map<number, number[]>;
  boundaryNodeIds: number[];
  boundaryNodeToVertex: Map<number, number>;
  vertexToBoundaryNode: Map<number, number>;
  depthCeilingM: number;
  bbox: { minLat: number; minLon: number; maxLat: number; maxLon: number };
}

interface RawNavmeshRegionRow {
  region_id: number;
  boundary_geometry: string;
  vertices: string;
  triangles: string;
  triangle_adjacency: string | null;
  boundary_node_ids: string;
  depth_ceiling_m: number;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return EARTH_RADIUS_M * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function polylineLength(path: Array<[number, number]>): number {
  let d = 0;
  for (let i = 1; i < path.length; i++) {
    d += haversineMeters(path[i - 1][0], path[i - 1][1], path[i][0], path[i][1]);
  }
  return d;
}

function coordKey(lat: number, lon: number): string {
  return `${lat.toFixed(5)},${lon.toFixed(5)}`;
}

// ---------------------------------------------------------------------------
// Point-in-polygon (mirrors database.ts's raycastPolygon/raycastRing pattern
// for land_polygons.geojson — duplicated rather than shared since that logic
// lives on RoutingDatabase and this module must not depend on database.ts).
// ---------------------------------------------------------------------------

function raycastRing(lon: number, lat: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1];
    const xj = ring[j][0], yj = ring[j][1];
    if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

function raycastPolygon(lon: number, lat: number, rings: number[][][]): boolean {
  if (!raycastRing(lon, lat, rings[0])) return false;
  for (let h = 1; h < rings.length; h++) {
    if (raycastRing(lon, lat, rings[h])) return false; // inside a hole
  }
  return true;
}

export function pointInPolygon(lat: number, lon: number, geometry: GeoJSON.Polygon | GeoJSON.MultiPolygon): boolean {
  if (geometry.type === 'Polygon') {
    return raycastPolygon(lon, lat, geometry.coordinates as unknown as number[][][]);
  }
  for (const poly of geometry.coordinates as unknown as number[][][][]) {
    if (raycastPolygon(lon, lat, poly)) return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Region construction
// ---------------------------------------------------------------------------

/**
 * Resolve each triangle to a canonical CCW vertex order using the sign of its
 * signed area in (lon, lat) space. The producer's own winding convention is
 * not trusted (the spec doesn't guarantee one) — this makes portal left/right
 * assignment in `funnel()` correct regardless of what the producer emitted.
 */
function normalizeWinding(
  vertices: Array<[number, number]>,
  triangles: Array<[number, number, number]>,
): Array<[number, number, number]> {
  return triangles.map(([a, b, c]) => {
    const va = vertices[a], vb = vertices[b], vc = vertices[c];
    // x = lon, y = lat
    const area2 = (vb[1] - va[1]) * (vc[0] - va[0]) - (vc[1] - va[1]) * (vb[0] - va[0]);
    return area2 >= 0 ? [a, b, c] : [a, c, b];
  }) as Array<[number, number, number]>;
}

function buildAdjacency(
  triangles: Array<[number, number, number]>,
): Map<number, Array<{ neighbor: number; a: number; b: number }>> {
  const edgeMap = new Map<string, Array<{ tri: number; a: number; b: number }>>();
  triangles.forEach((tri, triIdx) => {
    const edges: Array<[number, number]> = [[tri[0], tri[1]], [tri[1], tri[2]], [tri[2], tri[0]]];
    for (const [a, b] of edges) {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      let occ = edgeMap.get(key);
      if (!occ) { occ = []; edgeMap.set(key, occ); }
      occ.push({ tri: triIdx, a, b });
    }
  });

  const adjacency = new Map<number, Array<{ neighbor: number; a: number; b: number }>>();
  for (const occurrences of edgeMap.values()) {
    if (occurrences.length !== 2) continue; // boundary edge (1) or non-manifold (skip)
    const [x, y] = occurrences;
    if (!adjacency.has(x.tri)) adjacency.set(x.tri, []);
    adjacency.get(x.tri)!.push({ neighbor: y.tri, a: x.a, b: x.b });
    if (!adjacency.has(y.tri)) adjacency.set(y.tri, []);
    adjacency.get(y.tri)!.push({ neighbor: x.tri, a: y.a, b: y.b });
  }
  return adjacency;
}

export function buildNavmeshRegion(
  row: RawNavmeshRegionRow,
  getNodeCoord: (id: number) => { lat: number; lon: number } | undefined,
): NavmeshRegion {
  const boundaryGeometry = JSON.parse(row.boundary_geometry) as GeoJSON.Polygon | GeoJSON.MultiPolygon;
  const vertices = JSON.parse(row.vertices) as Array<[number, number]>;
  const rawTriangles = JSON.parse(row.triangles) as Array<[number, number, number]>;
  const boundaryNodeIds = JSON.parse(row.boundary_node_ids) as number[];

  const triangles = normalizeWinding(vertices, rawTriangles);
  // triangle_adjacency (row.triangle_adjacency) is intentionally not trusted for
  // portal construction — its positional [n0,n1,n2] slot meaning isn't pinned
  // down by the spec, and rebuilding via shared-vertex-pair detection is O(T)
  // and cheap at these mesh sizes (see NEXT_PHASES.md's own sizing guidance).
  const adjacency = buildAdjacency(triangles);

  const vertexToTriangles = new Map<number, number[]>();
  const triangleCentroids: Array<[number, number]> = new Array(triangles.length);
  const triangleBBoxes = new Float64Array(triangles.length * 4);
  let minLat = Infinity, maxLat = -Infinity, minLon = Infinity, maxLon = -Infinity;

  triangles.forEach((tri, triIdx) => {
    const [a, b, c] = tri;
    for (const v of tri) {
      if (!vertexToTriangles.has(v)) vertexToTriangles.set(v, []);
      vertexToTriangles.get(v)!.push(triIdx);
    }
    const va = vertices[a], vb = vertices[b], vc = vertices[c];
    triangleCentroids[triIdx] = [(va[0] + vb[0] + vc[0]) / 3, (va[1] + vb[1] + vc[1]) / 3];

    const tMinLat = Math.min(va[0], vb[0], vc[0]);
    const tMaxLat = Math.max(va[0], vb[0], vc[0]);
    const tMinLon = Math.min(va[1], vb[1], vc[1]);
    const tMaxLon = Math.max(va[1], vb[1], vc[1]);
    const base = triIdx * 4;
    triangleBBoxes[base] = tMinLon;
    triangleBBoxes[base + 1] = tMinLat;
    triangleBBoxes[base + 2] = tMaxLon;
    triangleBBoxes[base + 3] = tMaxLat;
  });

  for (const [lat, lon] of vertices) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }

  const vertexIndexByCoord = new Map<string, number>();
  vertices.forEach(([lat, lon], idx) => vertexIndexByCoord.set(coordKey(lat, lon), idx));

  const boundaryNodeToVertex = new Map<number, number>();
  const vertexToBoundaryNode = new Map<number, number>();
  for (const nodeId of boundaryNodeIds) {
    const coord = getNodeCoord(nodeId);
    if (!coord) continue; // node not loaded (e.g. deleted by overlay) — skip, degrades gracefully
    const idx = vertexIndexByCoord.get(coordKey(coord.lat, coord.lon));
    if (idx === undefined) continue; // coordinate mismatch — skip rather than guess
    boundaryNodeToVertex.set(nodeId, idx);
    vertexToBoundaryNode.set(idx, nodeId);
  }

  return {
    regionId: row.region_id,
    boundaryGeometry,
    vertices,
    triangles,
    triangleCentroids,
    triangleBBoxes,
    adjacency,
    vertexToTriangles,
    boundaryNodeIds,
    boundaryNodeToVertex,
    vertexToBoundaryNode,
    depthCeilingM: row.depth_ceiling_m,
    bbox: { minLat, minLon, maxLat, maxLon },
  };
}

// ---------------------------------------------------------------------------
// Point location
// ---------------------------------------------------------------------------

function sign(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by);
}

function pointInTriangle(
  px: number, py: number,
  ax: number, ay: number, bx: number, by: number, cx: number, cy: number,
): boolean {
  const d1 = sign(px, py, ax, ay, bx, by);
  const d2 = sign(px, py, bx, by, cx, cy);
  const d3 = sign(px, py, cx, cy, ax, ay);
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNeg && hasPos); // boundary-inclusive
}

export function locateTriangle(region: NavmeshRegion, lat: number, lon: number): number | null {
  if (lat < region.bbox.minLat || lat > region.bbox.maxLat ||
      lon < region.bbox.minLon || lon > region.bbox.maxLon) return null;

  const n = region.triangles.length;
  for (let t = 0; t < n; t++) {
    const base = t * 4;
    if (lon < region.triangleBBoxes[base] || lon > region.triangleBBoxes[base + 2] ||
        lat < region.triangleBBoxes[base + 1] || lat > region.triangleBBoxes[base + 3]) continue;
    const [ia, ib, ic] = region.triangles[t];
    const a = region.vertices[ia], b = region.vertices[ib], c = region.vertices[ic];
    if (pointInTriangle(lon, lat, a[1], a[0], b[1], b[0], c[1], c[0])) return t;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Corridor search: multi-source/multi-sink Dijkstra over the triangle dual
// graph. Multi-source/sink lets callers pass every triangle incident to a
// shared vertex (a boundary node or an interior point that's exactly on an
// edge) without having to arbitrarily pick just one.
// ---------------------------------------------------------------------------

class MinHeap<T> {
  private data: T[] = [];
  constructor(private score: (item: T) => number) {}
  push(item: T): void {
    this.data.push(item);
    let i = this.data.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.score(this.data[i]) >= this.score(this.data[p])) break;
      [this.data[i], this.data[p]] = [this.data[p], this.data[i]];
      i = p;
    }
  }
  pop(): T | undefined {
    if (this.data.length === 0) return undefined;
    const top = this.data[0];
    const bottom = this.data.pop()!;
    if (this.data.length > 0) {
      this.data[0] = bottom;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = 2 * i + 2;
        let smallest = i;
        if (l < this.data.length && this.score(this.data[l]) < this.score(this.data[smallest])) smallest = l;
        if (r < this.data.length && this.score(this.data[r]) < this.score(this.data[smallest])) smallest = r;
        if (smallest === i) break;
        [this.data[i], this.data[smallest]] = [this.data[smallest], this.data[i]];
        i = smallest;
      }
    }
    return top;
  }
  isEmpty(): boolean { return this.data.length === 0; }
}

export function corridorSearch(region: NavmeshRegion, startCandidates: number[], endCandidates: number[]): number[] | null {
  if (startCandidates.length === 0 || endCandidates.length === 0) return null;
  const endSet = new Set(endCandidates);
  for (const s of startCandidates) if (endSet.has(s)) return [s];

  const dist = new Map<number, number>();
  const prev = new Map<number, number>();
  const visited = new Set<number>();
  const heap = new MinHeap<{ tri: number; d: number }>(x => x.d);

  for (const s of startCandidates) {
    if (!dist.has(s) || dist.get(s)! > 0) dist.set(s, 0);
    heap.push({ tri: s, d: 0 });
  }

  while (!heap.isEmpty()) {
    const cur = heap.pop()!;
    if (visited.has(cur.tri)) continue;
    visited.add(cur.tri);

    if (endSet.has(cur.tri)) {
      const path: number[] = [cur.tri];
      let node = cur.tri;
      while (prev.has(node)) {
        node = prev.get(node)!;
        path.unshift(node);
      }
      return path;
    }

    const neighbors = region.adjacency.get(cur.tri) ?? [];
    for (const { neighbor } of neighbors) {
      if (visited.has(neighbor)) continue;
      const [clat, clon] = region.triangleCentroids[cur.tri];
      const [nlat, nlon] = region.triangleCentroids[neighbor];
      const w = haversineMeters(clat, clon, nlat, nlon);
      const nd = cur.d + w;
      if (!dist.has(neighbor) || nd < dist.get(neighbor)!) {
        dist.set(neighbor, nd);
        prev.set(neighbor, cur.tri);
        heap.push({ tri: neighbor, d: nd });
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Simple Stupid Funnel Algorithm (Mononen). Operates in a local equirectangular
// meters projection (consistent per-region origin) so the cross-product sign
// tests are metrically well-behaved, then unprojects the result back to lat/lon.
// ---------------------------------------------------------------------------

interface Pt { x: number; y: number }

function triarea2(a: Pt, b: Pt, c: Pt): number {
  return (b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y);
}

function funnelAlgorithm(portals: Array<{ left: Pt; right: Pt }>): Pt[] {
  const pts: Pt[] = [portals[0].left];
  let apex = portals[0].left;
  let portalLeft = portals[0].left;
  let portalRight = portals[0].right;
  let apexIdx = 0, leftIdx = 0, rightIdx = 0;

  let i = 1;
  while (i < portals.length) {
    const left = portals[i].left;
    const right = portals[i].right;

    // Tighten/restart the right side of the funnel.
    if (triarea2(apex, portalRight, right) <= 0) {
      if (apexIdx === rightIdx || triarea2(apex, portalLeft, right) > 0) {
        portalRight = right;
        rightIdx = i;
      } else {
        pts.push(portalLeft);
        apex = portalLeft;
        apexIdx = leftIdx;
        portalLeft = apex;
        portalRight = apex;
        leftIdx = apexIdx;
        rightIdx = apexIdx;
        i = apexIdx + 1;
        continue;
      }
    }

    // Tighten/restart the left side of the funnel.
    if (triarea2(apex, portalLeft, left) >= 0) {
      if (apexIdx === leftIdx || triarea2(apex, portalRight, left) < 0) {
        portalLeft = left;
        leftIdx = i;
      } else {
        pts.push(portalRight);
        apex = portalRight;
        apexIdx = rightIdx;
        portalLeft = apex;
        portalRight = apex;
        leftIdx = apexIdx;
        rightIdx = apexIdx;
        i = apexIdx + 1;
        continue;
      }
    }

    i++;
  }

  const lastPt = portals[portals.length - 1].left;
  const tail = pts[pts.length - 1];
  if (tail.x !== lastPt.x || tail.y !== lastPt.y) pts.push(lastPt);
  return pts;
}

function getPortalEdge(region: NavmeshRegion, fromTri: number, toTri: number): { a: number; b: number } | null {
  const entries = region.adjacency.get(fromTri);
  if (!entries) return null;
  for (const e of entries) if (e.neighbor === toTri) return { a: e.a, b: e.b };
  return null;
}

export function funnel(
  region: NavmeshRegion,
  corridor: number[],
  start: [number, number],
  end: [number, number],
): Array<[number, number]> {
  if (corridor.length <= 1) return [start, end];

  const originLat = (region.bbox.minLat + region.bbox.maxLat) / 2;
  const cosLat = Math.cos(originLat * Math.PI / 180);
  const proj = (lat: number, lon: number): Pt => ({
    x: lon * Math.PI / 180 * EARTH_RADIUS_M * cosLat,
    y: lat * Math.PI / 180 * EARTH_RADIUS_M,
  });
  const unproj = (p: Pt): [number, number] => [
    (p.y / EARTH_RADIUS_M) * 180 / Math.PI,
    (p.x / (EARTH_RADIUS_M * cosLat)) * 180 / Math.PI,
  ];

  const startP = proj(start[0], start[1]);
  const endP = proj(end[0], end[1]);
  const portals: Array<{ left: Pt; right: Pt }> = [{ left: startP, right: startP }];

  for (let i = 1; i < corridor.length; i++) {
    const edge = getPortalEdge(region, corridor[i - 1], corridor[i]);
    if (!edge) {
      // corridorSearch only ever returns adjacent triangle chains, so this
      // indicates caller-constructed input, not a search result — fail safe.
      return [start, end];
    }
    const vLeft = region.vertices[edge.b];
    const vRight = region.vertices[edge.a];
    portals.push({ left: proj(vLeft[0], vLeft[1]), right: proj(vRight[0], vRight[1]) });
  }
  portals.push({ left: endP, right: endP });

  return funnelAlgorithm(portals).map(unproj);
}

// ---------------------------------------------------------------------------
// Public convenience wrappers
// ---------------------------------------------------------------------------

export interface FunnelResult {
  distance: number;
  path: Array<[number, number]>;
}

export function funnelBetweenNodes(region: NavmeshRegion, nodeA: number, nodeB: number): FunnelResult | null {
  const va = region.boundaryNodeToVertex.get(nodeA);
  const vb = region.boundaryNodeToVertex.get(nodeB);
  if (va === undefined || vb === undefined) return null;
  if (va === vb) return { distance: 0, path: [region.vertices[va]] };

  const startCandidates = region.vertexToTriangles.get(va) ?? [];
  const endCandidates = region.vertexToTriangles.get(vb) ?? [];
  const corridor = corridorSearch(region, startCandidates, endCandidates);
  if (!corridor) return null;

  const start = region.vertices[va];
  const end = region.vertices[vb];
  const path = funnel(region, corridor, start, end);
  return { distance: polylineLength(path), path };
}

export function funnelFromPoint(region: NavmeshRegion, lat: number, lon: number, targetNodeId: number): FunnelResult | null {
  const vTarget = region.boundaryNodeToVertex.get(targetNodeId);
  if (vTarget === undefined) return null;

  const startTri = locateTriangle(region, lat, lon);
  if (startTri === null) return null;
  const endCandidates = region.vertexToTriangles.get(vTarget) ?? [];
  const corridor = corridorSearch(region, [startTri], endCandidates);
  if (!corridor) return null;

  const end = region.vertices[vTarget];
  const path = funnel(region, corridor, [lat, lon], end);
  return { distance: polylineLength(path), path };
}

export function funnelBetweenPoints(
  region: NavmeshRegion,
  latA: number, lonA: number,
  latB: number, lonB: number,
): FunnelResult | null {
  const triA = locateTriangle(region, latA, lonA);
  const triB = locateTriangle(region, latB, lonB);
  if (triA === null || triB === null) return null;

  if (triA === triB) {
    const path: Array<[number, number]> = [[latA, lonA], [latB, lonB]];
    return { distance: polylineLength(path), path };
  }

  const corridor = corridorSearch(region, [triA], [triB]);
  if (!corridor) return null;

  const path = funnel(region, corridor, [latA, lonA], [latB, lonB]);
  return { distance: polylineLength(path), path };
}
