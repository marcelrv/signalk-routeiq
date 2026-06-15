import crypto from 'crypto';
import { RouteResult } from './types.js';

export class GpxExporter {
  /**
   * Convert a RouteResult GeoJSON to GPX XML string
   * Handles both single-feature (segments array) and multi-feature (per-segment) formats.
   */
  static toGpx(route: RouteResult, name: string = 'Autoroute'): string {
    const { coords, segments } = this.extractCoordsAndSegments(route);
    const totalDistance = route.totalDistance ?? 0;
    const totalCost = route.totalCost ?? 0;

    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="signalk-autoroute" xmlns:ar="http://signalk.org/autoroute">
  <rte>
    <name>${this.escapeXml(name)}</name>
    <desc>Route calculated by SignalK Autoroute Nautical Route Planner - Distance: ${totalDistance.toFixed(0)}m, Cost: ${totalCost.toFixed(2)}</desc>`;

    coords.forEach((coord, index) => {
      const [lon, lat] = coord;
      gpx += `
    <rtept lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">
      <name>WP${index + 1}</name>`;

      if (index > 0 && segments[index - 1]) {
        const seg = segments[index - 1];
        gpx += `
      <ele>0</ele>
      <extensions>
        <ar:minDepth>${seg.minDepth.toFixed(1)}m</ar:minDepth>
        <ar:maxAirDraft>${seg.maxAirDraft.toFixed(1)}m</ar:maxAirDraft>
        <ar:isFairway>${seg.isFairway ? 'true' : 'false'}</ar:isFairway>
      </extensions>`;
      }

      gpx += `
    </rtept>`;
    });

    gpx += `
  </rte>
</gpx>`;

    return gpx;
  }

  /**
   * Convert route to Signal K v2 Route specification
   */
  static toSignalKRoute(route: RouteResult, name: string = 'Autoroute Route', routeId?: string): any {
    const { coords, segments } = this.extractCoordsAndSegments(route);
    const totalDistance = route.totalDistance ?? 0;
    const totalCost = route.totalCost ?? 0;
    const id = routeId || crypto.randomUUID();

    return {
      name,
      description: `Route calculated by SignalK Autoroute Nautical Route Planner - Distance: ${totalDistance.toFixed(0)}m`,
      distance: totalDistance,
      feature: {
        type: 'Feature',
        geometry: {
          type: 'LineString',
          coordinates: coords as [number, number][],
        },
        properties: {
          totalCost,
          segments: segments.map(s => ({
            from: s.from ?? -1,
            to: s.to ?? -1,
            distance: s.distance,
            minDepth: s.minDepth,
            maxAirDraft: s.maxAirDraft,
            isFairway: s.isFairway,
            trafficMode: s.trafficMode,
            edgeTypeId: s.edgeTypeId,
          })),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Extract unified coordinates array and segments from either format:
   * - Multi-feature: one feature per segment, each with 2-point LineString
   * - Single-feature: one big LineString + segments array in properties
   */
  private static extractCoordsAndSegments(route: RouteResult): {
    coords: Array<[number, number]>;
    segments: Array<{
      from?: number; to?: number; distance: number;
      minDepth: number; maxAirDraft: number; isFairway: boolean;
      trafficMode?: number; edgeTypeId?: number;
    }>;
  } {
    const coords: Array<[number, number]> = [];
    const segments: Array<any> = [];

    if (route.features.length === 0) return { coords, segments };

    const first = route.features[0];

    if (first.properties.segments && first.properties.segments.length > 0) {
      // Single-feature format: one big LineString + segments array
      const allCoords = first.geometry.coordinates as Array<[number, number]>;
      for (let i = 0; i < allCoords.length; i++) {
        coords.push(allCoords[i]);
      }
      for (const seg of first.properties.segments) {
        segments.push(seg);
      }
    } else {
      // Multi-feature format: one feature per segment
      for (let fi = 0; fi < route.features.length; fi++) {
        const f = route.features[fi];
        const fCoords = f.geometry.coordinates as Array<[number, number]>;
        if (fi === 0) {
          coords.push(fCoords[0]);
        }
        coords.push(fCoords[fCoords.length - 1]);
        segments.push({
          distance: f.properties.distance ?? 0,
          minDepth: f.properties.minDepth ?? -1,
          maxAirDraft: f.properties.maxAirDraft ?? -1,
          isFairway: f.properties.isFairway ?? false,
          trafficMode: f.properties.trafficMode,
          edgeTypeId: f.properties.edgeTypeId,
        });
      }
    }

    return { coords, segments };
  }

  private static escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
