/**
 * GPX Export Module
 * Converts route GeoJSON to GPX format for navigation software
 */

import { RouteResult } from './types.js';

export class GpxExporter {
  /**
   * Convert a RouteResult GeoJSON to GPX XML string
   */
  static toGpx(route: RouteResult, name: string = 'Autoroute'): string {
    const feature = route.features[0];
    const coords = feature.geometry.coordinates;
    const props = feature.properties;

    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="signalk-autoroute">
  <rte>
    <name>${this.escapeXml(name)}</name>
    <desc>Route calculated by SignalK Autoroute - Distance: ${props.totalDistance.toFixed(0)}m, Cost: ${props.totalCost.toFixed(2)}</desc>`;

    // Add route points
    coords.forEach((coord, index) => {
      const [lon, lat] = coord;
      gpx += `
    <rtept lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}">
      <name>WP${index + 1}</name>`;

      // Add depth information if available from segments
      if (index > 0 && props.segments[index - 1]) {
        const segment = props.segments[index - 1];
        gpx += `
      <ele>0</ele>
      <extensions>
        <minDepth>${segment.minDepth.toFixed(1)}m</minDepth>
        <maxAirDraft>${segment.maxAirDraft.toFixed(1)}m</maxAirDraft>
        <isFairway>${segment.isFairway ? 'true' : 'false'}</isFairway>
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
   * Convert route to Signal K Route specification
   * See: https://signalk.org/specification/1.4.0/doc/object_route.html
   */
  static toSignalKRoute(route: RouteResult, name: string = 'Autoroute Route', routeId?: string): any {
    const feature = route.features[0];
    const coords = feature.geometry.coordinates;
    const id = routeId || `autoroute-${Date.now()}`;

    const waypoints = coords.map((coord, index) => {
      const [lon, lat] = coord;
      return {
        type: 'signalk#Waypoint',
        waypointId: `WP${index + 1}`,
        name: `WP${index + 1}`,
        position: {
          type: 'signalk#Position',
          latitude: lat,
          longitude: lon,
        },
      };
    });

    return {
      type: 'signalk#Route',
      routeId: id,
      name: name,
      description: `Route calculated by SignalK Autoroute - Distance: ${feature.properties.totalDistance.toFixed(0)}m`,
      active: false,
      originTimestamp: new Date().toISOString(),
      waypoints: waypoints,
      _metadata: {
        totalDistance: feature.properties.totalDistance,
        totalCost: feature.properties.totalCost,
        segments: feature.properties.segments,
      },
    };
  }

  /**
   * Escape XML special characters
   */
  private static escapeXml(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
