import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  buildNavmeshRegion,
  corridorSearch,
  funnelBetweenNodes,
  funnelBetweenPoints,
  locateTriangle,
  pointInPolygon,
  type NavmeshRegion,
} from '../dist/navmesh.js';

describe('pointInPolygon', () => {
  it('detects a point inside a simple square', () => {
    const square = { type: 'Polygon' as const, coordinates: [[[0, 0], [2, 0], [2, 2], [0, 2], [0, 0]]] };
    assert.strictEqual(pointInPolygon(1, 1, square), true);
    assert.strictEqual(pointInPolygon(3, 3, square), false);
  });

  it('excludes a hole in a donut polygon', () => {
    const donut = {
      type: 'Polygon' as const,
      coordinates: [
        [[0, 0], [4, 0], [4, 4], [0, 4], [0, 0]],
        [[1, 1], [3, 1], [3, 3], [1, 3], [1, 1]],
      ],
    };
    assert.strictEqual(pointInPolygon(2, 2, donut), false); // inside the hole
    assert.strictEqual(pointInPolygon(0.5, 0.5, donut), true); // inside the ring, outside the hole
  });

  it('matches either polygon of a MultiPolygon', () => {
    const multi = {
      type: 'MultiPolygon' as const,
      coordinates: [
        [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]],
        [[[5, 5], [6, 5], [6, 6], [5, 6], [5, 5]]],
      ],
    };
    assert.strictEqual(pointInPolygon(0.5, 0.5, multi), true);
    assert.strictEqual(pointInPolygon(5.5, 5.5, multi), true);
    assert.strictEqual(pointInPolygon(3, 3, multi), false);
  });
});

// ---------------------------------------------------------------------------
// Convex rectangle fixture: x:0-2, y:0-1, split by the Q0-Q2 diagonal.
// Regression control for the funnel algorithm — a convex corridor must
// collapse to a straight 2-point path.
// ---------------------------------------------------------------------------

function buildRectangleRegion(): NavmeshRegion {
  const Q0: [number, number] = [0, 0]; // [lat, lon]
  const Q1: [number, number] = [0, 2];
  const Q2: [number, number] = [1, 2];
  const Q3: [number, number] = [1, 0];
  const row = {
    region_id: 1,
    boundary_geometry: JSON.stringify({ type: 'Polygon', coordinates: [[[0, 0], [2, 0], [2, 1], [0, 1], [0, 0]]] }),
    vertices: JSON.stringify([Q0, Q1, Q2, Q3]),
    triangles: JSON.stringify([[0, 1, 2], [0, 2, 3]]),
    triangle_adjacency: null,
    boundary_node_ids: JSON.stringify([]),
    depth_ceiling_m: 5,
  };
  return buildNavmeshRegion(row, () => undefined);
}

// ---------------------------------------------------------------------------
// L-shaped concave fixture (outer ring, CCW, in [x,y]=[lon,lat] terms):
//   (0,0) -> (1,0) -> (3,0) -> (3,0.5) -> (3,1) -> (1,1) -> (1,3) -> (0,3) -> (0,2.5) -> close
// The reflex corner at (1,1) forces any path between the two arms to bend.
// Decomposed into 7 triangles (right arm R1 x:1-3,y:0-1; left column R2
// x:0-1,y:0-3), verified by hand (see PR description / commit) to tile the
// L exactly with no gaps/overlaps.
// ---------------------------------------------------------------------------

function buildLShapeRegion(): { region: NavmeshRegion; nodeA: number; nodeB: number } {
  // vertices, indexed 0..8, as [lat, lon]
  const P0: [number, number] = [0, 0];
  const P1: [number, number] = [0, 3];
  const P2: [number, number] = [1, 3];
  const P3: [number, number] = [1, 1];
  const P4: [number, number] = [3, 1];
  const P5: [number, number] = [3, 0];
  const P6: [number, number] = [0.5, 3]; // boundary node A, on edge P1-P2
  const P7: [number, number] = [2.5, 0]; // boundary node B, on edge P5-P0
  const P8: [number, number] = [0, 1]; // on edge P0-P1
  const vertices = [P0, P1, P2, P3, P4, P5, P6, P7, P8];

  const triangles = [
    [8, 1, 6], [8, 6, 2], [8, 2, 3], // R1 (right arm)
    [0, 8, 3], [0, 3, 4], [4, 5, 7], [4, 7, 0], // R2 (left column)
  ];

  const ring = [
    [0, 0], [1, 0], [3, 0], [3, 0.5], [3, 1], [1, 1], [1, 3], [0, 3], [0, 2.5], [0, 0],
  ];

  const nodeIdFor = (lat: number, lon: number): number => {
    const latInt = Math.round((Math.round(lat * 100000) / 100000 + 90) * 100000);
    const lonInt = Math.round((Math.round(lon * 100000) / 100000 + 180) * 100000);
    return latInt * 36_000_000 + lonInt;
  };
  const nodeA = nodeIdFor(P6[0], P6[1]);
  const nodeB = nodeIdFor(P7[0], P7[1]);
  const coordsById = new Map<number, { lat: number; lon: number }>([
    [nodeA, { lat: P6[0], lon: P6[1] }],
    [nodeB, { lat: P7[0], lon: P7[1] }],
  ]);

  const row = {
    region_id: 1,
    boundary_geometry: JSON.stringify({ type: 'Polygon', coordinates: [ring] }),
    vertices: JSON.stringify(vertices),
    triangles: JSON.stringify(triangles),
    triangle_adjacency: null,
    boundary_node_ids: JSON.stringify([nodeA, nodeB]),
    depth_ceiling_m: 5,
  };
  const region = buildNavmeshRegion(row, (id) => coordsById.get(id));
  return { region, nodeA, nodeB };
}

describe('buildNavmeshRegion + locateTriangle', () => {
  it('locates a point inside the rectangle mesh', () => {
    const region = buildRectangleRegion();
    const tri = locateTriangle(region, 0.5, 0.5);
    assert.notStrictEqual(tri, null);
  });

  it('returns null outside the mesh bbox', () => {
    const region = buildRectangleRegion();
    assert.strictEqual(locateTriangle(region, 50, 50), null);
  });

  it('resolves boundary_node_ids to vertex indices by coordinate match', () => {
    const { region, nodeA, nodeB } = buildLShapeRegion();
    assert.strictEqual(region.boundaryNodeToVertex.has(nodeA), true);
    assert.strictEqual(region.boundaryNodeToVertex.has(nodeB), true);
  });
});

describe('corridorSearch', () => {
  it('picks the shorter of two candidate branches (Dijkstra)', () => {
    // Abstract 5-triangle dual graph (geometry unused by corridorSearch):
    //   0 -> 1 -> 3 (short: ~222km)
    //   0 -> 2 -> 4 -> 3 (long: ~2442km)
    const centroids: Array<[number, number]> = [
      [0, 0],   // 0 start
      [0, 1],   // 1
      [0, -5],  // 2
      [0, 2],   // 3 end
      [0, -10], // 4
    ];
    const adjacency = new Map<number, Array<{ neighbor: number; a: number; b: number }>>([
      [0, [{ neighbor: 1, a: 0, b: 0 }, { neighbor: 2, a: 0, b: 0 }]],
      [1, [{ neighbor: 0, a: 0, b: 0 }, { neighbor: 3, a: 0, b: 0 }]],
      [2, [{ neighbor: 0, a: 0, b: 0 }, { neighbor: 4, a: 0, b: 0 }]],
      [3, [{ neighbor: 1, a: 0, b: 0 }, { neighbor: 4, a: 0, b: 0 }]],
      [4, [{ neighbor: 2, a: 0, b: 0 }, { neighbor: 3, a: 0, b: 0 }]],
    ]);
    const region: NavmeshRegion = {
      regionId: 1,
      boundaryGeometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      vertices: [],
      triangles: [],
      triangleCentroids: centroids,
      triangleBBoxes: new Float64Array(0),
      adjacency,
      vertexToTriangles: new Map(),
      boundaryNodeIds: [],
      boundaryNodeToVertex: new Map(),
      vertexToBoundaryNode: new Map(),
      depthCeilingM: 0,
      bbox: { minLat: -90, minLon: -180, maxLat: 90, maxLon: 180 },
    };

    const corridor = corridorSearch(region, [0], [3]);
    assert.deepStrictEqual(corridor, [0, 1, 3]);
  });

  it('returns null when start/end are unreachable', () => {
    const region: NavmeshRegion = {
      regionId: 1,
      boundaryGeometry: { type: 'Polygon', coordinates: [[[0, 0], [1, 0], [1, 1], [0, 1], [0, 0]]] },
      vertices: [],
      triangles: [],
      triangleCentroids: [[0, 0], [0, 1]],
      triangleBBoxes: new Float64Array(0),
      adjacency: new Map(), // no edges at all
      vertexToTriangles: new Map(),
      boundaryNodeIds: [],
      boundaryNodeToVertex: new Map(),
      vertexToBoundaryNode: new Map(),
      depthCeilingM: 0,
      bbox: { minLat: -90, minLon: -180, maxLat: 90, maxLon: 180 },
    };
    assert.strictEqual(corridorSearch(region, [0], [1]), null);
  });
});

describe('funnel algorithm', () => {
  it('collapses to a straight 2-point path across a convex corridor', () => {
    const region = buildRectangleRegion();
    // Q1 (0,2) and Q3 (1,0): opposite corners, straight line stays inside
    // the convex rectangle and crosses the shared Q0-Q2 diagonal.
    const result = funnelBetweenPoints(region, 0, 2, 1, 0);
    assert.notStrictEqual(result, null);
    assert.strictEqual(result!.path.length, 2);
  });

  it('bends around a concave (reflex) corner instead of cutting the corner', () => {
    const { region, nodeA, nodeB } = buildLShapeRegion();
    const result = funnelBetweenNodes(region, nodeA, nodeB);
    assert.notStrictEqual(result, null);
    assert.ok(result!.path.length > 2, `expected a bent path, got ${result!.path.length} points`);

    // The naive straight chord between the two boundary nodes passes through
    // (1.5, 1.5), which is outside the L polygon (inside the excluded notch) —
    // confirms this fixture actually exercises concavity, not just a longer mesh.
    assert.strictEqual(pointInPolygon(1.5, 1.5, region.boundaryGeometry), false);
  });

  it('funnel distance is never shorter than the straight-line distance', () => {
    const { region, nodeA, nodeB } = buildLShapeRegion();
    const result = funnelBetweenNodes(region, nodeA, nodeB);
    assert.notStrictEqual(result, null);
    const [latA, lonA] = region.vertices[region.boundaryNodeToVertex.get(nodeA)!];
    const [latB, lonB] = region.vertices[region.boundaryNodeToVertex.get(nodeB)!];
    const straight = haversine(latA, lonA, latB, lonB);
    assert.ok(result!.distance >= straight - 1); // -1m float slack
  });
});

function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
