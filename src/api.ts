/**
 * API Route Handlers
 * Express middleware for all router API endpoints
 */

import crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { ServerAPI } from "@signalk/server-api";
import { NextFunction, Request, Response, Router } from "express";
import { RoutingDatabase } from "./database.js";
import { GpxExporter } from "./gpx-export.js";
import { RoutingEngine } from "./routing.js";
import {
  PluginConfig,
  RouteResult,
  RouteWarning,
  RoutingRequest,
  VesselDimensions,
} from "./types.js";

/** Auth fields Signal K's tokensecurity middleware sets on the request. */
interface SkAuthedRequest {
  skIsAuthenticated?: boolean;
  skPrincipal?: { permissions?: string };
}

/** Narrow surface of the Signal K server app needed to persist a resource. */
interface SkResourcesApp {
  resourcesApi: {
    setResource(type: string, id: string, value: unknown): Promise<void>;
  };
}

/** A coordinate as it arrives from a client: leaflet `{lat, lng}`, `{lat, lon}`
 *  or the canonical `{latitude, longitude}`. Every field is optional because
 *  this is unvalidated request body — the handlers narrow it before use. */
interface LooseCoordinate {
  latitude?: number;
  longitude?: number;
  lat?: number;
  lng?: number;
  lon?: number;
}

/** Cap on `via` array length — each via point triggers a sequential A* search,
 *  and /route is unauthenticated, so an unbounded array is a CPU DoS vector. */
const MAX_VIA_POINTS = 25;

/** Plausible upper bounds (meters) per vessel dimension. A value outside them
 *  never reaches the engine, because a bad dimension fails *open* on a safety
 *  constraint instead of erroring: getEdgePenalty compares `edge.min_depth <
 *  draft + safetyMarginDraft`, so a string draft makes that sum a string and
 *  every comparison NaN-false (no edge is ever too shallow), and a negative
 *  draft puts the threshold below every real depth. Same shape for air draft
 *  and beam. Recognisable spellings of a real number are still read (see
 *  coerceVesselDimension) — it's the unreadable ones that must not slip
 *  through. */
const VESSEL_DIM_MAX_M: Record<VesselDimensionKey, number> = {
  draft: 30,
  beam: 100,
  airDraft: 150,
};

type VesselDimensionKey = "draft" | "beam" | "airDraft";

const VESSEL_DIM_KEYS: VesselDimensionKey[] = ["draft", "beam", "airDraft"];

/** Human wording for warnings/errors — "airDraft" reads badly in prose. */
const VESSEL_DIM_LABEL: Record<VesselDimensionKey, string> = {
  draft: "draft",
  beam: "beam",
  airDraft: "air draft",
};

/** Turns a dimension supplied by a client — or read straight off a Signal K
 *  path — into meters.
 *
 *  Beyond a plain number this accepts the two shapes that legitimately reach
 *  us carrying a perfectly good value:
 *   - a numeric string, from a form field or a settings file that stored the
 *     draft as text ("2");
 *   - Signal K's own `design.draft`, whose value is an *object*
 *     (`{maximum, minimum, current}`), plus the `{value: ...}` delta wrapper.
 *     A UI reading `vessels/self` directly gets that object, not a scalar.
 *
 *  Anything else (an empty string, "2 meters", a bare object) is undefined —
 *  never NaN, and never a string that would survive into an arithmetic
 *  comparison. See VESSEL_DIM_MAX_M for why that distinction is a safety
 *  property and not just tidiness. */
export function coerceVesselDimension(
  value: unknown,
  depth = 0,
): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  // Bounded so a hand-crafted body of nested wrappers can't recurse forever.
  if (typeof value === "object" && value !== null && depth < 4) {
    const obj = value as Record<string, unknown>;
    for (const key of ["value", "maximum", "current"] as const) {
      const nested = coerceVesselDimension(obj[key], depth + 1);
      if (nested !== undefined) return nested;
    }
  }
  return undefined;
}

/** Shared validation for the draft/beam/airDraft trio, which arrives both as
 *  the global default (PUT /vessel) and as per-request overrides (POST /route,
 *  /route/departures). `null`/`undefined` mean "not supplied" and are dropped,
 *  so a partial update never clobbers an already-set dimension — the caller
 *  gets back only the keys that were actually present and valid.
 *
 *  This is the *strict* path, for PUT /vessel: an admin writing the
 *  server-wide defaults is standing right there and should be told their value
 *  didn't take. Routing requests use validateRequestConstraints instead, which
 *  warns and carries on. */
export function pickVesselDimensions(
  body: Record<string, unknown> | undefined,
): { dims: VesselDimensions } | { error: string } {
  const dims: VesselDimensions = {};
  for (const key of VESSEL_DIM_KEYS) {
    const raw = body?.[key];
    if (raw === undefined || raw === null) continue;
    const value = coerceVesselDimension(raw);
    if (value === undefined) {
      return { error: `Invalid ${key} — expected a number in meters` };
    }
    if (value < 0 || value > VESSEL_DIM_MAX_M[key]) {
      return {
        error: `Invalid ${key} — expected 0..${VESSEL_DIM_MAX_M[key]} meters`,
      };
    }
    dims[key] = value;
  }
  return { dims };
}

/** Short, log-safe rendering of a rejected value, for the warning text. */
function describeValue(value: unknown): string {
  let text: string;
  try {
    text = typeof value === "string" ? value : JSON.stringify(value);
  } catch {
    text = String(value);
  }
  if (text === undefined) text = String(value);
  return text.length > 60 ? text.slice(0, 57) + "…" : text;
}

/** Normalizes the vessel-dimension and coast-distance overrides on a routing
 *  request in place (null -> undefined, so the engine falls back to the
 *  configured defaults).
 *
 *  An unusable *vessel dimension* is dropped rather than rejected, and
 *  reported as a route warning: a client that sends a malformed draft (the
 *  webapp used to forward Signal K's `design.draft` object verbatim) should
 *  still get a route. Dropping it is what makes that safe — the engine then
 *  falls back to the configured vessel dimensions, and failing those to its
 *  own conservative defaults (2.0 m draft, 4.0 m beam), so the depth and
 *  air-draft constraints keep applying. Keeping the bad value would disable
 *  them silently; see VESSEL_DIM_MAX_M.
 *
 *  minCoastDistance is still a hard error: it is a plain scalar with no
 *  competing wire shapes, so a bad one means a broken client rather than a
 *  value we can sensibly reinterpret. */
export function validateRequestConstraints(request: RoutingRequest): {
  error: string | null;
  warnings: RouteWarning[];
} {
  const warnings: RouteWarning[] = [];
  const body = request as unknown as Record<string, unknown>;
  for (const key of VESSEL_DIM_KEYS) {
    const raw = body[key];
    if (raw === undefined || raw === null) {
      request[key] = undefined;
      continue;
    }
    const value = coerceVesselDimension(raw);
    if (value === undefined || value < 0 || value > VESSEL_DIM_MAX_M[key]) {
      request[key] = undefined;
      warnings.push({
        type: "vessel_dimension_ignored",
        message:
          `Ignored the supplied ${VESSEL_DIM_LABEL[key]} (${describeValue(raw)}) — ` +
          `expected a number between 0 and ${VESSEL_DIM_MAX_M[key]} meters. ` +
          `Routed with the ${VESSEL_DIM_LABEL[key]} configured on the server instead; ` +
          `check the vessel dimensions in Signal K.`,
      });
      continue;
    }
    request[key] = value;
  }

  if (request.minCoastDistance === null) request.minCoastDistance = undefined;
  if (request.minCoastDistance !== undefined) {
    if (
      typeof request.minCoastDistance !== "number" ||
      !Number.isFinite(request.minCoastDistance)
    ) {
      return {
        error: "Invalid minCoastDistance — expected a number in nautical miles",
        warnings,
      };
    }
    if (request.minCoastDistance < 0 || request.minCoastDistance > 100) {
      return {
        error: "Invalid minCoastDistance — expected 0..100 nautical miles",
        warnings,
      };
    }
  }
  return { error: null, warnings };
}

export class ApiHandler {
  private router: Router;
  private routingEngine: RoutingEngine | null;
  private db: RoutingDatabase | null;
  private config: PluginConfig;
  private app: ServerAPI;
  private initError: string | null = null;
  /** Callback invoked after a database download to hot-reload the routing engine */
  public onReloadRequested: ((dataDir: string) => Promise<void>) | null = null;

  constructor(config: PluginConfig, app: ServerAPI) {
    this.routingEngine = null;
    this.db = null;
    this.config = config;
    this.app = app;
    this.router = Router();
    this.setupRoutes();
  }

  /** start() rebuilds the config object on every config save; adopt the fresh one. */
  updateConfig(config: PluginConfig): void {
    this.config = config;
  }

  setComponents(db: RoutingDatabase, engine: RoutingEngine): void {
    this.db = db;
    this.routingEngine = engine;
    this.initError = null;
    console.log("[routeiq] API handler components updated");
  }

  /**
   * Release the database and engine, leaving the router mounted.
   *
   * Must be called *before* closing a database that is being swapped out: these
   * references are what isReady() consults, so leaving them in place over a
   * close lets concurrent requests through to a closed database instead of
   * answering a clean 503 for the duration of the swap.
   */
  clearComponents(): void {
    this.db = null;
    this.routingEngine = null;
  }

  setInitError(message: string): void {
    this.initError = message;
  }

  isReady(): boolean {
    return this.db !== null && this.routingEngine !== null;
  }

  getRouter(): Router {
    return this.router;
  }

  private setupRoutes(): void {
    // CORS for sandbox/cross-origin dev access.
    // Wildcard (Access-Control-Allow-Origin: *) is granted only to safe,
    // read-only routes plus a small allowlist of non-destructive POSTs.
    // NOTE: this header does NOT provide authorization. CORS only restricts
    // which origins a browser will let its own JS read a cross-origin
    // response from — it has no effect on curl/native/server-to-server
    // clients, and by itself does nothing to stop a request from reaching
    // and mutating the server. Authorization for state-mutating endpoints
    // (graph node/edge edits, overlay repair, database load/unload/delete/
    // download) is enforced separately by requireAuth(), which checks
    // Signal K's own session/token authentication and admin permission.
    const CORS_SAFE_POSTS = new Set([
      "/route",
      "/route/departures",
      "/export/gpx",
      "/push",
    ]);
    this.router.use((_req, res, next) => {
      const allowCors =
        _req.method === "GET" ||
        _req.method === "OPTIONS" ||
        (_req.method === "POST" && CORS_SAFE_POSTS.has(_req.path));
      if (allowCors) {
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.header(
          "Access-Control-Allow-Headers",
          "Content-Type, Authorization",
        );
      }
      if (_req.method === "OPTIONS") {
        res.sendStatus(204);
        return;
      }
      next();
    });

    // POST /signalk/v1/api/router/route
    this.router.post("/route", this.handleRoute.bind(this));

    // POST /signalk/v1/api/router/route/departures — scan departure times for the best tide
    this.router.post("/route/departures", this.handleDepartureScan.bind(this));

    // GET /signalk/v1/api/router/tides/status?latitude=&longitude= — tide data availability
    this.router.get("/tides/status", this.handleTidesStatus.bind(this));

    // GET /signalk/v1/api/router/search
    this.router.get("/search", this.handleSearch.bind(this));

    // POST /signalk/v1/api/router/export/gpx
    this.router.post("/export/gpx", this.handleExportGpx.bind(this));

    // POST /signalk/v1/api/router/push
    this.router.post("/push", this.handlePushRoute.bind(this));

    // GET /signalk/v1/api/router/stats
    this.router.get("/stats", this.handleStats.bind(this));

    // GET /signalk/v1/api/router/config — client-relevant plugin settings
    this.router.get("/config", this.handleGetConfig.bind(this));

    // GET /signalk/v1/api/router/vessel
    this.router.get("/vessel", this.handleGetVessel.bind(this));

    // PUT /signalk/v1/api/router/vessel (admin — writes the server-wide defaults)
    this.router.put("/vessel", this.handleUpdateVessel.bind(this));

    // GET /signalk/v1/api/router/graph/nodes?bbox=minLon,minLat,maxLon,maxLat
    this.router.get("/graph/nodes", this.handleGraphNodes.bind(this));

    // GET /signalk/v1/api/router/graph/edges?bbox=minLon,minLat,maxLon,maxLat
    this.router.get("/graph/edges", this.handleGraphEdges.bind(this));

    // GET /signalk/v1/api/router/pois?bbox=minLon,minLat,maxLon,maxLat
    this.router.get("/pois", this.handlePois.bind(this));

    // GET /signalk/v1/api/router/poi/nearest?lat=X&lon=Y&radius=250
    this.router.get("/poi/nearest", this.handleNearestPoi.bind(this));

    // GET /signalk/v1/api/router/waterways?bbox=minLon,minLat,maxLon,maxLat
    this.router.get("/waterways", this.handleWaterways.bind(this));

    // GET /signalk/v1/api/router/graph/overlay/stats — overlay edit counts
    this.router.get("/graph/overlay/stats", this.handleOverlayStats.bind(this));
    this.router.post(
      "/graph/overlay/repair",
      this.handleOverlayRepair.bind(this),
    );

    // Graph editor endpoints (all POST with manual auth check)
    this.router.post("/graph/nodes/:id", this.handleUpsertNode.bind(this));
    this.router.post(
      "/graph/nodes/:id/delete",
      this.handleDeleteNode.bind(this),
    );
    this.router.post(
      "/graph/edges/:source/:target",
      this.handleUpsertEdge.bind(this),
    );
    this.router.post(
      "/graph/edges/:source/:target/delete",
      this.handleDeleteEdge.bind(this),
    );

    // GET /signalk/v1/api/router/databases — list locally installed databases
    this.router.get("/databases", this.handleListDatabases.bind(this));

    // GET /signalk/v1/api/router/databases/status — loading status
    this.router.get("/databases/status", this.handleDatabasesStatus.bind(this));

    // GET /signalk/v1/api/router/databases/available — fetch remote catalog
    this.router.get(
      "/databases/available",
      this.handleAvailableDatabases.bind(this),
    );

    // POST /signalk/v1/api/router/databases/download — download a database file
    this.router.post(
      "/databases/download",
      this.handleDownloadDatabase.bind(this),
    );

    // POST /signalk/v1/api/router/databases/load — §4a manual per-file load
    this.router.post("/databases/load", this.handleDatabaseLoad.bind(this));

    // POST /signalk/v1/api/router/databases/unload — §4a manual per-file unload
    this.router.post("/databases/unload", this.handleDatabaseUnload.bind(this));

    // POST /signalk/v1/api/router/databases/delete — remove an installed database file
    this.router.post("/databases/delete", this.handleDeleteDatabase.bind(this));
  }

  /**
   * Handle route calculation request
   * POST /signalk/v1/api/router/route
   */
  private async handleRoute(
    req: Request,
    res: Response,
    _next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res
        .status(503)
        .json({ error: "Routing engine not ready, still initializing" });
      return;
    }
    try {
      const request: RoutingRequest = req.body;

      if (!request.start || !request.end) {
        res.status(400).json({
          error: "Missing required fields: start and end coordinates",
        });
        return;
      }

      // Normalize leaflet {lat, lng} / {lat, lon} to {latitude, longitude}
      const norm = (p: LooseCoordinate) => {
        if (typeof p.latitude !== "number") p.latitude = p.lat;
        if (typeof p.longitude !== "number") p.longitude = p.lng ?? p.lon;
      };
      norm(request.start);
      norm(request.end);

      if (
        typeof request.start.latitude !== "number" ||
        typeof request.start.longitude !== "number" ||
        typeof request.end.latitude !== "number" ||
        typeof request.end.longitude !== "number"
      ) {
        res.status(400).json({
          error: "Invalid coordinate format. Expected {latitude, longitude}",
        });
        return;
      }

      // Normalize via points and per-leg modes ('auto' is the default; only
      // 'manual' changes behavior — anything else is rejected).
      if (request.via !== undefined && !Array.isArray(request.via)) {
        res.status(400).json({
          error:
            "Invalid via — expected an array of {latitude, longitude, mode?}",
        });
        return;
      }
      for (const v of request.via || []) {
        norm(v);
        if (typeof v.latitude !== "number" || typeof v.longitude !== "number") {
          res.status(400).json({
            error:
              "Invalid via coordinate format. Expected {latitude, longitude}",
          });
          return;
        }
        if (v.mode !== undefined && v.mode !== "auto" && v.mode !== "manual") {
          res
            .status(400)
            .json({ error: "Invalid via mode — expected 'auto' or 'manual'" });
          return;
        }
      }
      if (request.via && request.via.length > MAX_VIA_POINTS) {
        res
          .status(400)
          .json({ error: `Too many via points (max ${MAX_VIA_POINTS})` });
        return;
      }
      if (
        request.endMode !== undefined &&
        request.endMode !== "auto" &&
        request.endMode !== "manual"
      ) {
        res
          .status(400)
          .json({ error: "Invalid endMode — expected 'auto' or 'manual'" });
        return;
      }

      if (
        request.departureTime !== undefined &&
        !Number.isFinite(Date.parse(request.departureTime))
      ) {
        res.status(400).json({
          error: "Invalid departureTime — expected an ISO 8601 date string",
        });
        return;
      }

      const constraints = validateRequestConstraints(request);
      if (constraints.error) {
        res.status(400).json({ error: constraints.error });
        return;
      }
      this.logConstraintWarnings(constraints.warnings);

      const route: RouteResult =
        await this.routingEngine!.calculateRoute(request);

      // Prepended, not appended: the dimension the route was planned against
      // is context for every other warning below it.
      if (constraints.warnings.length > 0) {
        route.warnings = [...constraints.warnings, ...(route.warnings || [])];
      }

      res.json(route);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      // Use 422 (Unprocessable Entity) so clients can distinguish a routing
      // failure (constraint/graph issue) from a server error (500).
      // Do not call next(error) — the response is already sent.
      res.status(422).json({ error: message, code: "ROUTE_NOT_FOUND" });
    }
  }

  /** A dropped dimension is visible in the route pane, but the server log is
   *  where it can be traced back to the client that sent it. */
  private logConstraintWarnings(warnings: RouteWarning[]): void {
    for (const warning of warnings) {
      console.warn(`[routeiq] ${warning.message}`);
    }
  }

  /**
   * Scan departure times over a window and report total travel time per
   * departure, so the user can pick the most favorable tide.
   * POST /signalk/v1/api/router/route/departures
   * Body: RoutingRequest + { scanHours?: number, stepMinutes?: number }
   */
  private async handleDepartureScan(
    req: Request,
    res: Response,
  ): Promise<void> {
    if (!this.isReady()) {
      res
        .status(503)
        .json({ error: "Routing engine not ready, still initializing" });
      return;
    }
    try {
      const { scanHours, stepMinutes, ...request } =
        req.body as RoutingRequest & {
          scanHours?: number;
          stepMinutes?: number;
        };
      if (!request.start || !request.end) {
        res.status(400).json({
          error: "Missing required fields: start and end coordinates",
        });
        return;
      }
      if (request.via && request.via.length > MAX_VIA_POINTS) {
        res
          .status(400)
          .json({ error: `Too many via points (max ${MAX_VIA_POINTS})` });
        return;
      }
      if (
        request.departureTime !== undefined &&
        !Number.isFinite(Date.parse(request.departureTime))
      ) {
        res.status(400).json({
          error: "Invalid departureTime — expected an ISO 8601 date string",
        });
        return;
      }
      const constraints = validateRequestConstraints(request);
      if (constraints.error) {
        res.status(400).json({ error: constraints.error });
        return;
      }
      this.logConstraintWarnings(constraints.warnings);
      const hours = Math.min(48, Math.max(1, Number(scanHours) || 24));
      const step = Math.min(240, Math.max(10, Number(stepMinutes) || 60));

      if (!this.routingEngine!.tidesClient) {
        res.status(422).json({
          error: "Tide data is not available",
          code: "TIDES_UNAVAILABLE",
        });
        return;
      }
      const departures = await this.routingEngine!.scanDepartures(
        request,
        hours,
        step,
      );
      res.json({
        scanHours: hours,
        stepMinutes: step,
        departures,
        warnings:
          constraints.warnings.length > 0 ? constraints.warnings : undefined,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(422).json({ error: message, code: "SCAN_FAILED" });
    }
  }

  /**
   * Tide data availability probe for UIs: is the signalk-tides plugin
   * reachable and does it know stations near the given position?
   * GET /signalk/v1/api/router/tides/status?latitude=&longitude=
   */
  private async handleTidesStatus(req: Request, res: Response): Promise<void> {
    const client = this.routingEngine?.tidesClient;
    const currents = this.routingEngine?.currentsClient;
    if (!client && !currents) {
      res.json({ available: false, reason: "engine not ready" });
      return;
    }
    const lat = parseFloat(req.query.latitude as string);
    const lon = parseFloat(req.query.longitude as string);
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      res.status(400).json({
        error: "latitude and longitude query parameters are required",
      });
      return;
    }
    const probe = client
      ? await client.probe(lat, lon)
      : { available: false, stations: [] };
    // Real current stations (signalk-tidal-currents plugin) near this position?
    const currentStations = currents ? await currents.probe(lat, lon) : false;
    res.json({
      available: probe.available || currentStations,
      estimated: true, // station predictions still derive from community harmonic data
      currentStations,
      source: currentStations ? "stations" : "height-estimate",
      considerTidesDefault: this.config.considerTides,
      stations: probe.stations.slice(0, 5).map((s) => ({
        id: s.id,
        name: s.name,
        latitude: s.latitude,
        longitude: s.longitude,
      })),
    });
  }

  /**
   * Handle POI search request
   * GET /signalk/v1/api/router/search?q=...
   */
  private async handleSearch(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready, still initializing" });
      return;
    }
    try {
      const query = req.query.q as string;
      const limit = parseInt(req.query.limit as string) || 20;

      if (!query || query.length < 1) {
        res.status(400).json({
          error: 'Search query parameter "q" is required (minimum 1 character)',
        });
        return;
      }

      const results = await this.db!.searchPois(query, limit);
      res.json({ query, count: results.length, results });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle GPX export request
   * POST /signalk/v1/api/router/export/gpx
   */
  private async handleExportGpx(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res
        .status(503)
        .json({ error: "Routing engine not ready, still initializing" });
      return;
    }
    try {
      const route: RouteResult = req.body.route;
      const name: string = req.body.name || "RouteIQ";

      if (!route) {
        res.status(400).json({ error: "Missing route data in request body" });
        return;
      }

      const gpx = GpxExporter.toGpx(route, name);

      res.setHeader("Content-Type", "application/gpx+xml");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${name.replace(/[^a-z0-9]/gi, "_")}.gpx"`,
      );
      res.send(gpx);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle route push to Signal K resources
   * POST /signalk/v1/api/router/push
   */
  private async handlePushRoute(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res
        .status(503)
        .json({ error: "Routing engine not ready, still initializing" });
      return;
    }
    try {
      const route: RouteResult = req.body.route;
      const name: string = req.body.name || "RouteIQ Route";

      if (!route) {
        res.status(400).json({ error: "Missing route data in request body" });
        return;
      }

      // Generate a UUID and convert to v2 Route format
      const uuid = crypto.randomUUID();
      const skRoute = GpxExporter.toSignalKRoute(route, name, uuid);

      // Persist via the Resource API (goes through resources-provider plugin)
      await (this.app as unknown as SkResourcesApp).resourcesApi.setResource(
        "routes",
        uuid,
        skRoute,
      );

      res.json({
        success: true,
        message: "Route pushed to Signal K resources",
        routeId: uuid,
        path: `resources.routes.${uuid}`,
      });
    } catch (error) {
      const err = error as any;
      const message =
        err instanceof Error ? err.message : `NonError: ${JSON.stringify(err)}`;
      console.error("[routeiq] Push route error:", error);
      res.status(500).json({ error: `Failed to push route: ${message}` });
      next(error);
    }
  }

  /**
   * Handle database stats request
   * GET /signalk/v1/api/router/stats
   */
  private async handleStats(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready, still initializing" });
      return;
    }
    try {
      const stats = await this.db!.getStats();
      res.json(stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Expose the client-relevant plugin settings (used by the Freeboard-SK
   * extension panel and the webapp for ETA calculation and defaults).
   * GET /signalk/v1/api/router/config
   */
  private async handleGetConfig(_req: Request, res: Response): Promise<void> {
    res.json({
      averageSpeedKnots: this.config.averageSpeedKnots,
      defaultCoastDistance: this.config.defaultCoastDistance,
      considerTides: this.config.considerTides,
      maxTidalCurrentKnots: this.config.maxTidalCurrentKnots,
    });
  }

  /**
   * Handle get vessel dimensions request
   * GET /signalk/v1/api/router/vessel
   */
  private async handleGetVessel(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res
        .status(503)
        .json({ error: "Routing engine not ready, still initializing" });
      return;
    }
    try {
      const vessel = this.routingEngine!.vesselDims;
      const cfg = this.routingEngine!.config;
      const effectiveDraft =
        Math.round(
          ((vessel.draft || 2.0) + (cfg.safetyMarginDraft || 0.3)) * 10,
        ) / 10;
      const effectiveBeam =
        Math.round(
          ((vessel.beam || 4.0) + (cfg.safetyMarginBeam || 2.0)) * 10,
        ) / 10;
      const effectiveAirDraft =
        Math.round(
          ((vessel.airDraft || 0) + (cfg.safetyMarginAirDraft || 1.5)) * 10,
        ) / 10;
      res.json({ ...vessel, effectiveDraft, effectiveBeam, effectiveAirDraft });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle update vessel dimensions request
   * PUT /signalk/v1/api/router/vessel
   *
   * Admin-only: these are the server-wide defaults every route without
   * explicit overrides is planned against, and they survive until the plugin
   * restarts (the Signal K design.* paths are only read once, at startup).
   */
  private async handleUpdateVessel(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res
        .status(503)
        .json({ error: "Routing engine not ready, still initializing" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    try {
      const picked = pickVesselDimensions(req.body);
      if ("error" in picked) {
        res.status(400).json({ error: picked.error });
        return;
      }
      this.routingEngine!.setVesselDimensions(picked.dims);
      res.json({ success: true, vessel: this.routingEngine!.vesselDims });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle graph nodes query
   * GET /signalk/v1/api/router/graph/nodes?bbox=minLon,minLat,maxLon,maxLat&limit=5000
   */
  private async handleGraphNodes(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      const limit = parseInt(req.query.limit as string) || 5000;
      if (!bbox) {
        res.status(400).json({
          error: "Missing bbox parameter (minLon,minLat,maxLon,maxLat)",
        });
        return;
      }
      const parts = bbox.split(",").map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({
          error: "Invalid bbox format, expected minLon,minLat,maxLon,maxLat",
        });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const nodes = await this.db!.getNodesInBBox(
        minLat,
        minLon,
        maxLat,
        maxLon,
        limit,
      );
      res.json({ count: nodes.length, nodes });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[routeiq] graph/nodes error:", error);
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle graph edges query
   * GET /signalk/v1/api/router/graph/edges?bbox=minLon,minLat,maxLon,maxLat&limit=5000
   */
  private async handleGraphEdges(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      const limit = parseInt(req.query.limit as string) || 5000;
      if (!bbox) {
        res.status(400).json({
          error: "Missing bbox parameter (minLon,minLat,maxLon,maxLat)",
        });
        return;
      }
      const parts = bbox.split(",").map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({
          error: "Invalid bbox format, expected minLon,minLat,maxLon,maxLat",
        });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const edges = await this.db!.getEdgesInBBox(
        minLat,
        minLon,
        maxLat,
        maxLon,
        limit,
      );
      res.json({ count: edges.length, edges });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[routeiq] graph/edges error:", error);
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Return overlay edit counts for the editor status bar.
   * GET /signalk/v1/api/router/graph/overlay/stats
   */
  private async handleOverlayStats(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    try {
      const stats = await this.db!.getOverlayStats();
      res.json(stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  private async handleOverlayRepair(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    try {
      const result = await this.db!.clearOverlayDeletedEdges();
      // Reload graph so the restored edges take effect immediately
      await this.db!.loadGraph();
      res.json({ success: true, ...result });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Auth check for state-changing endpoints (graph edits, database
   * install/load, server-wide vessel defaults).
   *
   * Signal K's tokensecurity middleware runs before plugin routes and sets
   * `req.skIsAuthenticated` (bool) and `req.skPrincipal.permissions` after
   * validating the JWT from the JAUTHENTICATION cookie or Bearer header.
   * Checking the cookie string directly does NOT validate the token.
   *
   * Requires admin permission because these writes are destructive or
   * affect every client's routes.
   * When security is disabled, skIsAuthenticated is set to true by SK.
   */
  private requireAuth(req: Request, res: Response): boolean {
    const skReq = req as unknown as SkAuthedRequest;
    if (skReq.skIsAuthenticated !== true) {
      res.status(401).json({
        error:
          "Authentication required. Please log into the Signal K admin UI.",
      });
      return false;
    }
    if (skReq.skPrincipal && skReq.skPrincipal.permissions !== "admin") {
      res.status(403).json({ error: "Admin permission required." });
      return false;
    }
    return true;
  }

  /**
   * Handle upsert node (create or update)
   * POST /signalk/v1/api/router/graph/nodes/:id
   */
  private async handleUpsertNode(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    try {
      const nodeId = parseInt(req.params.id, 10);
      const { dbIndex, lat, lon, node_depth } = req.body;
      if (dbIndex === undefined) {
        res.status(400).json({ error: "Missing dbIndex" });
        return;
      }
      if (lat !== undefined && lon !== undefined) {
        await this.db!.addNode(dbIndex, { id: nodeId, lat, lon, node_depth });
        const connect = await this.autoConnectNode(nodeId, lat, lon);
        res.json({ success: true, ...connect });
      } else {
        await this.db!.updateNode(dbIndex, nodeId, { node_depth });
        res.json({ success: true });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Connect a newly placed editor node to the surrounding main graph.
   *
   * Candidates are the nearest main-graph nodes within a hard radius; each
   * connection line is validated against the land polygons (when present in
   * the data directory) so the editor cannot fabricate edges across land.
   * Edges carry the real geodesic distance — a zero-length edge would be
   * free for A* and distort every route through it.
   */
  private async autoConnectNode(
    nodeId: number,
    lat: number,
    lon: number,
  ): Promise<{ autoConnected: number; autoConnectSkipped: number }> {
    const MAX_CONNECT_DIST = 1000; // m — beyond this, connecting blind is guesswork
    const TARGET_CONNECTIONS = 2;
    // Over-fetch candidates so a rejected line can fall through to the next node
    const candidates = await this.db!.findKNearestMainGraphNodes(
      lat,
      lon,
      6,
      MAX_CONNECT_DIST,
    );

    let autoConnected = 0;
    let skipped = 0;
    for (const n of candidates) {
      if (autoConnected >= TARGET_CONNECTIONS) break;
      if (n.id === nodeId) continue;
      // ~50 m sampling along the straight connection, same as the LOS smoother
      const numSamples = Math.min(60, Math.max(3, Math.ceil(n.distance / 50)));
      if (this.db!.isLineCrossingLand(lat, lon, n.lat, n.lon, numSamples)) {
        skipped++;
        continue;
      }
      const distance = Math.max(1, Math.round(n.distance));
      const attrs = {
        distance,
        cost_factor: 1.2,
        min_depth: -1,
        max_air_draft: -1,
        min_width: -1,
        distance_to_land: 0,
        edge_type_id: 0,
        traffic_mode: 0,
      };
      try {
        await this.db!.addEdge(0, { source: nodeId, target: n.id, ...attrs });
        await this.db!.addEdge(0, { source: n.id, target: nodeId, ...attrs });
        autoConnected++;
      } catch {
        /* edge already exists or other non-fatal error */
      }
    }
    return { autoConnected, autoConnectSkipped: skipped };
  }

  /**
   * Handle delete node
   * POST /signalk/v1/api/router/graph/nodes/:id/delete  body: { dbIndex }
   */
  private async handleDeleteNode(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    try {
      const nodeId = parseInt(req.params.id, 10);
      const { dbIndex } = req.body;
      if (dbIndex === undefined) {
        res.status(400).json({ error: "Missing dbIndex" });
        return;
      }
      await this.db!.deleteNode(dbIndex, nodeId);
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle upsert edge (create or update)
   * POST /signalk/v1/api/router/graph/edges/:source/:target
   */
  private async handleUpsertEdge(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    try {
      const source = parseInt(req.params.source, 10);
      const target = parseInt(req.params.target, 10);
      const {
        dbIndex,
        distance,
        min_depth,
        max_air_draft,
        min_width,
        traffic_mode,
        cost_factor,
        distance_to_land,
        edge_type_id,
      } = req.body;
      if (dbIndex === undefined) {
        res.status(400).json({ error: "Missing dbIndex" });
        return;
      }
      const isBidirectional = traffic_mode === 0 || traffic_mode === undefined;
      // Try update first; if edge doesn't exist in memory, create it
      try {
        await this.db!.updateEdge(dbIndex, source, target, {
          distance,
          min_depth,
          max_air_draft,
          min_width,
          traffic_mode,
          cost_factor,
        });
      } catch {
        await this.db!.addEdge(dbIndex, {
          source,
          target,
          distance,
          min_depth,
          max_air_draft,
          min_width,
          traffic_mode,
          cost_factor,
          distance_to_land,
          edge_type_id,
        });
      }
      // For bidirectional edges also store the reverse so A* can traverse both ways
      if (isBidirectional) {
        try {
          await this.db!.updateEdge(dbIndex, target, source, {
            distance,
            min_depth,
            max_air_draft,
            min_width,
            traffic_mode,
            cost_factor,
          });
        } catch {
          try {
            await this.db!.addEdge(dbIndex, {
              source: target,
              target: source,
              distance,
              min_depth,
              max_air_draft,
              min_width,
              traffic_mode,
              cost_factor,
              distance_to_land,
              edge_type_id,
            });
          } catch {
            /* nodes may not exist for reverse — ignore */
          }
        }
      }
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle delete edge
   * POST /signalk/v1/api/router/graph/edges/:source/:target/delete  body: { dbIndex }
   */
  private async handleDeleteEdge(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    try {
      const source = parseInt(req.params.source, 10);
      const target = parseInt(req.params.target, 10);
      const { dbIndex } = req.body;
      if (dbIndex === undefined) {
        res.status(400).json({ error: "Missing dbIndex" });
        return;
      }
      await this.db!.deleteEdge(dbIndex, source, target);
      res.json({ success: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle POIs query
   * GET /signalk/v1/api/router/pois?bbox=minLon,minLat,maxLon,maxLat&limit=2000
   */
  private async handlePois(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      const limit = parseInt(req.query.limit as string) || 2000;
      if (!bbox) {
        res.status(400).json({
          error: "Missing bbox parameter (minLon,minLat,maxLon,maxLat)",
        });
        return;
      }
      const parts = bbox.split(",").map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({
          error: "Invalid bbox format, expected minLon,minLat,maxLon,maxLat",
        });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const pois = await this.db!.getPoisInBBox(
        minLat,
        minLon,
        maxLat,
        maxLon,
        limit,
      );
      res.json({ count: pois.length, pois });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle nearest POI query
   * GET /signalk/v1/api/router/poi/nearest?lat=X&lon=Y&radius=250
   */
  private async handleNearestPoi(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.db) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    try {
      const lat = parseFloat(req.query.lat as string);
      const lon = parseFloat(req.query.lon as string);
      const radius = parseFloat(req.query.radius as string) || 250;
      if (isNaN(lat) || isNaN(lon)) {
        res
          .status(400)
          .json({ error: "Missing or invalid lat/lon parameters" });
        return;
      }
      const poi = await this.db!.getNearestPoi(lat, lon, radius);
      res.json({ poi });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle waterway line query
   * GET /signalk/v1/api/router/waterways?bbox=minLon,minLat,maxLon,maxLat
   */
  private async handleWaterways(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.db) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      if (!bbox) {
        res.status(400).json({
          error: "Missing bbox parameter (minLon,minLat,maxLon,maxLat)",
        });
        return;
      }
      const parts = bbox.split(",").map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({
          error: "Invalid bbox format, expected minLon,minLat,maxLon,maxLat",
        });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const features = await this.db!.getWaterways(
        minLat,
        minLon,
        maxLat,
        maxLon,
      );
      res.json({ type: "FeatureCollection", features });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[routeiq] waterways error:", error);
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle list locally installed databases
   * GET /signalk/v1/api/router/databases
   */
  private async handleListDatabases(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.db) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    try {
      const info = await this.db.getDatabaseCatalog();
      res.json({ databases: info });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle databases loading status
   * GET /signalk/v1/api/router/databases/status
   */
  private async handleDatabasesStatus(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.db) {
      // Return 200 (not 503) so the frontend can read the error field
      res.json({
        loaded: false,
        filenames: [],
        available: 0,
        initError: this.initError,
      });
      return;
    }
    try {
      const status = this.db.getLoadingStatus();
      res.json({ ...status, initError: this.initError });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Directory the configured catalog file lives in, normalized and with a
   * trailing slash (e.g. https://host/owner/repo/main/) — the single source
   * of truth for both the download URLs this server advertises and the ones
   * handleDownloadDatabase will accept. Null if catalogUrl is unset or
   * unparseable.
   */
  private catalogBaseUrl(): string | null {
    if (!this.config.catalogUrl) return null;
    try {
      return new URL(".", this.config.catalogUrl).href;
    } catch {
      return null;
    }
  }

  /**
   * Handle fetch available databases from remote catalog
   * GET /signalk/v1/api/router/databases/available
   */
  private async handleAvailableDatabases(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const catalogUrl = this.config.catalogUrl;
      if (!catalogUrl) {
        res.status(400).json({ error: "No catalog URL configured" });
        return;
      }
      const response = await fetch(catalogUrl, {
        signal: AbortSignal.timeout(15000),
      });
      if (!response.ok) {
        res
          .status(502)
          .json({ error: `Catalog server returned ${response.status}` });
        return;
      }
      const catalog = (await response.json()) as any;
      // Derive the base URL from the catalog URL for constructing download links
      const baseUrl = this.catalogBaseUrl();
      if (baseUrl && catalog.regions && Array.isArray(catalog.regions)) {
        for (const region of catalog.regions) {
          if (region.file) {
            region.downloadUrl = baseUrl + region.file;
          }
        }
      }
      res.json(catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(502).json({ error: `Failed to fetch catalog: ${message}` });
      next(error);
    }
  }

  /**
   * Handle download a database file from a URL and save to data directory.
   * If the download is a .sqlite.gz file, it is automatically decompressed.
   * POST /signalk/v1/api/router/databases/download
   * Body: { url: string, filename: string }
   */
  private async handleDownloadDatabase(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.requireAuth(req, res)) return;
    try {
      const { url, filename } = req.body;
      if (!url || !filename) {
        res
          .status(400)
          .json({ error: "Missing required fields: url, filename" });
        return;
      }

      const dataDir = this.config.routingDataDir;
      if (!dataDir) {
        res.status(400).json({ error: "routingDataDir is not configured" });
        return;
      }

      // Only accept URLs under the catalog's own directory — the exact set
      // handleAvailableDatabases advertises. An origin-only check is not
      // enough on a shared host: the default catalog lives on
      // raw.githubusercontent.com, whose origin every GitHub user's repo
      // shares, so any of them would have passed.
      if (!this.config.catalogUrl) {
        res.status(400).json({
          error: "No catalog URL configured; cannot validate download origin",
        });
        return;
      }
      const trustedBase = this.catalogBaseUrl();
      if (!trustedBase) {
        res
          .status(400)
          .json({ error: "Configured catalog URL is not a valid URL" });
        return;
      }
      try {
        // Compare the *parsed* href, not the raw string: dot segments and
        // percent-encoding are normalized away first, so a URL that merely
        // starts with the trusted prefix but resolves elsewhere
        // (…/main/../../other/evil.sqlite) is rejected.
        const normalized = new URL(url).href;
        if (!normalized.startsWith(trustedBase)) {
          res.status(400).json({
            error: `Download URL must be under the configured catalog path (${trustedBase})`,
          });
          return;
        }
      } catch {
        res.status(400).json({ error: "Invalid download URL" });
        return;
      }

      // Ensure data directory exists
      try {
        await fs.promises.mkdir(dataDir, { recursive: true });
      } catch {
        /* ignore */
      }

      console.log(`[routeiq] Downloading database: ${url}`);
      const response = await fetch(url, {
        signal: AbortSignal.timeout(120000),
      });
      if (!response.ok) {
        res.status(502).json({
          error: `Download failed: server returned ${response.status}`,
        });
        return;
      }

      // Compute the on-disk filename (strip .gz for compressed downloads)
      // and validate it BEFORE touching the filesystem or the response body
      // — never open a write stream to an unvalidated path.
      let saveFilename = filename;
      const isGzip = filename.endsWith(".sqlite.gz");
      if (isGzip) {
        saveFilename = filename.slice(0, -3); // strip .gz
      }

      // Reject filenames that could escape the data directory (path traversal)
      if (
        !/^[\w\-.]+\.sqlite$/.test(saveFilename) ||
        saveFilename.includes("..")
      ) {
        res.status(400).json({
          error:
            "Invalid filename: must be a plain .sqlite filename with no path components",
        });
        return;
      }
      const destPath = path.resolve(dataDir, saveFilename);
      const resolvedDataDir = path.resolve(dataDir);
      if (
        !destPath.startsWith(resolvedDataDir + path.sep) &&
        destPath !== resolvedDataDir
      ) {
        res
          .status(400)
          .json({ error: "Invalid filename: path escapes data directory" });
        return;
      }

      // Stream the response body straight to disk instead of buffering the
      // whole file in RAM — regional DBs can be hundreds of MB, which OOMs
      // low-memory devices (Raspberry Pi). Write to a temp file first and
      // rename on success, so a failed/partial download never leaves a
      // corrupt .sqlite in place.
      //
      // Multi-region dynamic loading keeps every installed database around;
      // renaming to destPath below overwrites a same-named file in place, so
      // re-downloading a region updates it without touching other regions.
      const tmpPath = destPath + ".tmp";
      if (!response.body) {
        res.status(502).json({ error: "Download failed: empty response body" });
        return;
      }
      let closedForRename = false;
      try {
        const src = Readable.fromWeb(response.body as any);
        if (isGzip) {
          await pipeline(
            src,
            zlib.createGunzip(),
            fs.createWriteStream(tmpPath),
          );
          console.log(`[routeiq] Decompressed ${filename} -> ${saveFilename}`);
        } else {
          await pipeline(src, fs.createWriteStream(tmpPath));
        }
        try {
          await fs.promises.rename(tmpPath, destPath);
        } catch (e: any) {
          // Re-downloading an already-installed region renames over a file the
          // db-worker may still hold open. POSIX allows that (the old inode
          // stays alive for the open handle until the hot-reload below swaps
          // it out), but Windows refuses with EPERM/EBUSY. Drop the handles
          // and retry — the hot-reload rebuilds the database either way.
          const code = e?.code;
          if (code !== "EPERM" && code !== "EBUSY" && code !== "EACCES")
            throw e;
          console.warn(
            `[routeiq] Rename blocked (${code}); closing database handles and retrying`,
          );
          // No database when a previous init failed — exactly the case where
          // the user re-downloads to repair it, so there are no handles to drop
          // and closing must not throw over the retry.
          if (this.db) {
            const closing = this.db;
            // Unpublish first: requests must not reach a closed database while
            // the rename and the hot-reload below run.
            this.clearComponents();
            await closing.close();
            closedForRename = true;
          }
          await fs.promises.rename(tmpPath, destPath);
        }
      } catch (e) {
        try {
          await fs.promises.unlink(tmpPath);
        } catch {
          /* ignore missing tmp file */
        }
        throw e;
      }

      const sizeBytes = (await fs.promises.stat(destPath)).size;
      console.log(
        `[routeiq] Database saved: ${saveFilename} (${sizeBytes} bytes)`,
      );

      // Refresh metadata cache so the new DB shows in the installed list.
      // Skipped when the rename had to close the database first — there is no
      // worker left to ask, and the hot-reload below re-reads everything.
      try {
        if (!closedForRename) await this.db!.reloadMetadata();
        console.log(`[routeiq] Metadata cache refreshed after download`);
      } catch (e) {
        console.warn(`[routeiq] Metadata refresh failed: ${e}`);
      }

      // Hot-reload the database and routing engine so the new DB is used immediately
      if (this.onReloadRequested) {
        try {
          await this.onReloadRequested(dataDir);
          console.log(`[routeiq] Routing engine hot-reloaded`);
        } catch (e) {
          console.error(`[routeiq] Hot-reload failed: ${e}`);
          res
            .status(500)
            .json({ error: `Database saved but hot-reload failed: ${e}` });
          return;
        }
      } else if (closedForRename) {
        // Nothing will reopen what the rename fallback had to close.
        console.error(
          "[routeiq] Database closed for rename but no reload hook is registered",
        );
        res.status(500).json({
          error: `${saveFilename} was installed, but the routing database is now closed — restart the plugin to use it`,
        });
        return;
      }

      res.json({
        success: true,
        filename: saveFilename,
        sizeBytes,
        message: `Downloaded and installed ${saveFilename} (${(sizeBytes / 1048576).toFixed(1)} MB)`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[routeiq] Database download error:", error);
      res.status(500).json({ error: `Download failed: ${message}` });
      next(error);
    }
  }

  /**
   * §4a manual per-file load — dynamic-loading mode only; a no-op concept in
   * non-dynamic mode (everything is already loaded), so that mode rejects
   * it with 400 rather than pretending to support a state machine it
   * doesn't have.
   * POST /signalk/v1/api/router/databases/load  body: { filename }
   */
  private async handleDatabaseLoad(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    if (!this.db!.isDynamicLoadingEnabled()) {
      res.status(400).json({
        error:
          "Dynamic loading is not enabled (config.dynamicLoading is false) — every database is already loaded",
      });
      return;
    }
    try {
      const { filename } = req.body ?? {};
      if (!filename || typeof filename !== "string") {
        res.status(400).json({ error: "Missing required field: filename" });
        return;
      }
      if (!this.db!.hasKnownDatabase(filename)) {
        res.status(404).json({ error: `Unknown database: ${filename}` });
        return;
      }
      await this.db!.loadDatabaseGraph(filename);
      res.json({
        success: true,
        filename,
        databases: this.db!.getCoverageStatus(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * §4a manual per-file unload — same dynamic-mode-only restriction as load.
   * Refuses (409) when the file isn't currently loaded, or when unloading
   * would leave zero loaded databases, or while a route calculation is in
   * flight — RoutingDatabase.unloadDatabaseGraph enforces all three and
   * this handler just maps its rejection to 409.
   * POST /signalk/v1/api/router/databases/unload  body: { filename }
   */
  private async handleDatabaseUnload(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: "Database not ready" });
      return;
    }
    if (!this.requireAuth(req, res)) return;
    if (!this.db!.isDynamicLoadingEnabled()) {
      res.status(400).json({
        error:
          "Dynamic loading is not enabled (config.dynamicLoading is false) — databases cannot be unloaded",
      });
      return;
    }
    try {
      const { filename } = req.body ?? {};
      if (!filename || typeof filename !== "string") {
        res.status(400).json({ error: "Missing required field: filename" });
        return;
      }
      if (!this.db!.hasKnownDatabase(filename)) {
        res.status(404).json({ error: `Unknown database: ${filename}` });
        return;
      }
      const result = await this.db!.unloadDatabaseGraph(filename);
      res.json({
        success: true,
        filename,
        ...result,
        databases: this.db!.getCoverageStatus(),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      // unloadDatabaseGraph's own guards (not loaded / would leave zero
      // loaded / route in flight) are conflicts with current server state,
      // not a generic server error.
      res.status(409).json({ error: message });
      next(error);
    }
  }

  /**
   * Delete an installed database file from disk (loaded or not) and
   * hot-reload the routing engine so it forgets that data immediately —
   * the same full close+reinit handleDownloadDatabase already uses for the
   * opposite (adding a file) case, reused here rather than trying to
   * thread a per-file unload+delete through every dynamic/non-dynamic,
   * loaded/not-loaded permutation individually.
   * POST /signalk/v1/api/router/databases/delete  body: { filename }
   */
  private async handleDeleteDatabase(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.requireAuth(req, res)) return;
    try {
      const { filename } = req.body ?? {};
      if (!filename || typeof filename !== "string") {
        res.status(400).json({ error: "Missing required field: filename" });
        return;
      }
      // Same filename shape guard as handleDownloadDatabase (path traversal prevention).
      if (!/^[\w\-.]+\.sqlite$/.test(filename) || filename.includes("..")) {
        res.status(400).json({
          error:
            "Invalid filename: must be a plain .sqlite filename with no path components",
        });
        return;
      }
      const dataDir = this.config.routingDataDir;
      if (!dataDir) {
        res.status(400).json({ error: "routingDataDir is not configured" });
        return;
      }
      const targetPath = path.resolve(dataDir, filename);
      const resolvedDataDir = path.resolve(dataDir);
      if (
        !targetPath.startsWith(resolvedDataDir + path.sep) &&
        targetPath !== resolvedDataDir
      ) {
        res
          .status(400)
          .json({ error: "Invalid filename: path escapes data directory" });
        return;
      }
      try {
        await fs.promises.unlink(targetPath);
      } catch (e: any) {
        if (e && e.code === "ENOENT") {
          res.status(404).json({ error: `Database not found: ${filename}` });
          return;
        }
        throw e;
      }
      console.log(`[routeiq] Database deleted: ${filename}`);

      try {
        if (this.db) await this.db.reloadMetadata();
      } catch (e) {
        console.warn(`[routeiq] Metadata refresh failed after delete: ${e}`);
      }
      if (this.onReloadRequested) {
        try {
          await this.onReloadRequested(dataDir);
          console.log("[routeiq] Routing engine hot-reloaded after delete");
        } catch (e) {
          console.error(`[routeiq] Hot-reload failed after delete: ${e}`);
          res
            .status(500)
            .json({ error: `Database deleted but hot-reload failed: ${e}` });
          return;
        }
      }

      res.json({ success: true, filename });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[routeiq] Database delete error:", error);
      res.status(500).json({ error: `Delete failed: ${message}` });
      next(error);
    }
  }
}
