import crypto from "node:crypto";
import { format } from "./messages.js";
import { ProviderInfo, RouteResult } from "./types.js";
import { buildPassageProfile, PassageProfile } from "./passage-profile.js";

export class GpxExporter {
  /**
   * Convert a RouteResult GeoJSON to GPX XML string
   * Handles both single-feature (segments array) and multi-feature (per-segment) formats.
   */
  static toGpx(
    route: RouteResult,
    name: string,
    provider: ProviderInfo,
    lang?: string | null,
  ): string {
    const { coords, segments } = this.extractCoordsAndSegments(route);
    const totalDistance = route.totalDistance ?? 0;
    const totalCost = route.totalCost ?? 0;
    // Simplified navigable waypoints (computed server-side with bounded
    // deviation): these make the <rte>; the full computed geometry is kept
    // as a <trk> so the receiving plotter still has the reference line.
    const waypoints =
      route.waypoints && route.waypoints.length >= 2 ? route.waypoints : null;

    // The calculated times (issue #50), over the points this <rte> lists.
    const profile = buildPassageProfile(
      route,
      waypoints
        ? waypoints.map((w) => [w.longitude, w.latitude] as [number, number])
        : coords,
      provider,
    );
    const description = format(
      "ROUTE_DESCRIPTION_GPX",
      {
        provider: provider.displayName ?? provider.name,
        distance: totalDistance,
        cost: totalCost,
        ...(profile
          ? {
              duration: profile.duration.total,
              waiting: profile.duration.waiting,
            }
          : {}),
      },
      lang,
    );

    let gpx = `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="${this.escapeXml(provider.name)}" xmlns:ar="http://signalk.org/routeiq">
  <rte>
    <name>${this.escapeXml(name)}</name>
    <desc>${this.escapeXml(description)}</desc>`;
    // GPX 1.1 puts <extensions> after <desc> and before the first <rtept>.
    if (profile) gpx += this.passageProfileGpx(profile);

    if (waypoints) {
      waypoints.forEach((wp, index) => {
        gpx += `
    <rtept lat="${wp.latitude.toFixed(6)}" lon="${wp.longitude.toFixed(6)}">
      <name>WP${index + 1}</name>
    </rtept>`;
      });
    } else {
      // Legacy result without waypoints: every graph node, with the incoming
      // edge attributes attached (extensions only make sense at full resolution).
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
        <ar:costFactor>${seg.costFactor.toFixed(2)}</ar:costFactor>
      </extensions>`;
        }

        gpx += `
    </rtept>`;
      });
    }

    gpx += `
  </rte>`;

    if (waypoints) {
      gpx += `
  <trk>
    <name>${this.escapeXml(name)} (computed path)</name>
    <trkseg>`;
      for (const [lon, lat] of coords) {
        gpx += `
      <trkpt lat="${lat.toFixed(6)}" lon="${lon.toFixed(6)}"></trkpt>`;
      }
      gpx += `
    </trkseg>
  </trk>`;
    }

    gpx += `
</gpx>`;

    return gpx;
  }

  /**
   * Convert route to Signal K v2 Route specification
   */
  static toSignalKRoute(
    route: RouteResult,
    name: string,
    provider: ProviderInfo,
    routeId?: string,
    lang?: string | null,
  ): any {
    const { coords, segments } = this.extractCoordsAndSegments(route);
    const totalDistance = route.totalDistance ?? 0;
    const totalCost = route.totalCost ?? 0;
    const id = routeId || crypto.randomUUID();

    // The stored route is what a plotter navigates: use the simplified
    // waypoints (same geometry the Freeboard-SK extension saves) so the
    // waypoint list stays meaningful. Full-resolution segments are internal
    // metadata and only round-trip on legacy results without waypoints.
    const waypoints =
      route.waypoints && route.waypoints.length >= 2 ? route.waypoints : null;
    const coordinates = waypoints
      ? waypoints.map((w) => [w.longitude, w.latitude] as [number, number])
      : (coords as [number, number][]);

    // One meta entry per coordinate, each with a real name. Signal K's route
    // schema requires every coordinatesMeta entry to be {name} or {href}, and
    // the field is optional — so leaving it out was valid, but it left routes
    // saved from the webapp with unnamed waypoints while the same route saved
    // through the Freeboard panel came back numbered. Same route, two different
    // waypoint lists depending on which window it was saved from.
    const coordinatesMeta = coordinates.map((_, i) => ({ name: `WP${i + 1}` }));

    // The calculated times, tied to exactly these coordinates (issue #50).
    const passageProfile = buildPassageProfile(route, coordinates, provider);

    return {
      name,
      description: format(
        "ROUTE_DESCRIPTION_SIGNALK",
        {
          provider: provider.displayName ?? provider.name,
          distance: totalDistance,
        },
        lang,
      ),
      distance: totalDistance,
      feature: {
        type: "Feature",
        geometry: {
          type: "LineString",
          coordinates,
        },
        properties: {
          totalCost,
          coordinatesMeta,
          ...(passageProfile ? { passageProfile } : {}),
          ...(waypoints
            ? {}
            : {
                segments: segments.map((s) => ({
                  from: s.from ?? -1,
                  to: s.to ?? -1,
                  distance: s.distance,
                  minDepth: s.minDepth,
                  maxAirDraft: s.maxAirDraft,
                  costFactor: s.costFactor,
                  trafficMode: s.trafficMode,
                  edgeTypeId: s.edgeTypeId,
                })),
              }),
        },
      },
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * The passage profile as RouteIQ GPX extensions (format in
   * docs/passage-profile.md, "In GPX"). Same numbers and units as the Signal K
   * profile; no geometry hash, since a GPX file is a copy, not a resource
   * someone else can edit under it.
   */
  private static passageProfileGpx(p: PassageProfile): string {
    const x = (v: string) => escapeXmlText(v);
    const attrs = (o: Record<string, string | number | boolean | undefined>) =>
      Object.entries(o)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]) => ` ${k}="${escapeXmlAttribute(String(v))}"`)
        .join("");
    const a = p.assumptions;
    let out = `
    <extensions>
      <ar:passageProfile${attrs({
        version: p.version,
        provider: p.provider.name,
        providerVersion: p.provider.version || undefined,
        calculatedAt: p.calculatedAt ?? undefined,
      })}>
        <ar:duration${attrs({
          total: p.duration.total,
          moving: p.duration.moving,
          waiting: p.duration.waiting,
          waitingIncludedInTotal: true,
        })}/>`;
    if (p.departure)
      out += `
        <ar:departure>${x(p.departure)}</ar:departure>`;
    if (p.arrival)
      out += `
        <ar:arrival>${x(p.arrival)}</ar:arrival>`;
    out += `
        <ar:assumptions${attrs({
          speedThroughWater: a.speedThroughWater ?? undefined,
          lockWait: a.lockWait ?? undefined,
          bridgeWait: a.bridgeWait ?? undefined,
          tide: a.tide.enabled,
          tideEstimated: a.tide.enabled ? a.tide.estimated : undefined,
          tideSource: a.tide.source,
        })}/>`;
    for (const w of p.waits) {
      out += `
        <ar:wait${attrs({
          type: w.type,
          name: w.name,
          structure: w.structure,
          passage: w.passage,
          distanceFromStart: w.distanceFromStart,
          seconds: w.seconds,
          lat: w.position?.latitude.toFixed(6),
          lon: w.position?.longitude.toFixed(6),
        })}/>`;
    }
    for (const w of p.warnings) {
      out += `
        <ar:warning${attrs({
          type: w.type,
          level: w.level,
          distanceFromStart: w.distanceFromStart,
          code: w.code,
        })}>${x(w.message)}</ar:warning>`;
    }
    out += `
      </ar:passageProfile>
    </extensions>`;
    return out;
  }

  /**
   * Extract unified coordinates array and segments from either format:
   * - Multi-feature: one feature per segment, each with 2-point LineString
   * - Single-feature: one big LineString + segments array in properties
   */
  private static extractCoordsAndSegments(route: RouteResult): {
    coords: Array<[number, number]>;
    segments: Array<{
      from?: number;
      to?: number;
      distance: number;
      minDepth: number;
      maxAirDraft: number;
      costFactor: number;
      trafficMode?: number;
      edgeTypeId?: number;
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
          costFactor: f.properties.costFactor ?? 1.2,
          trafficMode: f.properties.trafficMode,
          edgeTypeId: f.properties.edgeTypeId,
        });
      }
    }

    return { coords, segments };
  }

  private static escapeXml(text: string): string {
    return escapeXmlText(text);
  }
}

/** Characters XML 1.0 does not allow: control characters other than tab, LF
 *  and CR, U+FFFE/U+FFFF, and unpaired surrogates. */
const INVALID_XML_CHARS =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

/** Text for an element body: characters XML 1.0 forbids are removed, the
 *  five markup characters escaped. */
export function escapeXmlText(text: string): string {
  return String(text)
    .replace(INVALID_XML_CHARS, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/** Text for a double-quoted attribute value: as `escapeXmlText`, and tab, LF
 *  and CR written as character references so a parser keeps them. */
export function escapeXmlAttribute(text: string): string {
  return escapeXmlText(text)
    .replace(/\t/g, "&#9;")
    .replace(/\n/g, "&#10;")
    .replace(/\r/g, "&#13;");
}
