/**
 * API Route Handlers
 * Express middleware for all router API endpoints
 */

import crypto from "crypto";
import * as fs from "fs";
import * as path from "path";
import * as zlib from "node:zlib";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { ServerAPI } from "@signalk/server-api";
import { NextFunction, Request, Response, Router } from "express";
import { DISABLED_SUFFIX, RoutingDatabase } from "./database.js";
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

  // Waits are per-request overrides of the configured defaults. Zero is
  // meaningful (a lock that never holds you up), so only the range is checked.
  for (const key of ["lockWaitMinutes", "bridgeWaitMinutes"] as const) {
    if (request[key] === null) request[key] = undefined;
    if (request[key] === undefined) continue;
    const v = request[key];
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0 || v > 24 * 60) {
      return {
        error: `Invalid ${key} — expected 0..1440 minutes`,
        warnings,
      };
    }
  }
  return { error: null, warnings };
}

/**
 * Forwards every chunk unchanged while hashing it -- unlike a bare
 * crypto.createHash(), which is writable-only-then-drain: piping it
 * downstream yields just the final digest, not the bytes written to it.
 */
class HashingPassThrough extends Transform {
  private readonly hash = crypto.createHash("sha256");

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.hash.update(chunk);
    this.push(chunk);
    callback();
  }

  digestHex(): string {
    return this.hash.digest("hex");
  }
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

    // POST /signalk/v1/api/router/databases/enabled — autoload/disabled switch
    this.router.post(
      "/databases/enabled",
      this.handleSetDatabaseEnabled.bind(this),
    );
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
      const warnings =
        constraints.warnings.length > 0 ? constraints.warnings : undefined;

      // A scan is one full route calculation per step and can run for minutes.
      // A client that asks for NDJSON gets each step as it lands, on one line,
      // so it can draw the window filling in; everyone else gets the single
      // JSON document this endpoint has always returned.
      //
      // The header is read directly rather than through req.accepts(): this
      // router is mounted by the host server, but it is also driven directly in
      // tests, where req is a plain object with no express prototype on it. The
      // choice here is binary anyway — a client either asks for the stream by
      // name or it does not — so negotiation adds nothing.
      // Lowercased: Node normalises header *names*, not values, and a media
      // type is case-insensitive — `Application/X-NDJSON` is a legal way to
      // ask for the stream, and would otherwise silently get the batch.
      if (
        String(req.headers.accept || "")
          .toLowerCase()
          .includes("application/x-ndjson")
      ) {
        await this.streamDepartureScan(
          req,
          res,
          request,
          hours,
          step,
          warnings,
        );
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
        warnings,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      res.status(422).json({ error: message, code: "SCAN_FAILED" });
    }
  }

  /**
   * Stream a departure scan as newline-delimited JSON: one `meta` line naming
   * every step the scan will cover, one `departure` line per result as it is
   * computed, and a final `done`. NDJSON rather than server-sent events because
   * EventSource cannot issue the POST this endpoint needs.
   *
   * The status code is committed the moment the first line is written, so a
   * failure after that is reported as an `error` line rather than a 4xx — the
   * results already delivered stay valid and the client keeps them.
   */
  private async streamDepartureScan(
    req: Request,
    res: Response,
    request: RoutingRequest,
    hours: number,
    step: number,
    warnings: RouteWarning[] | undefined,
  ): Promise<void> {
    const engine = this.routingEngine!;
    const steps = RoutingEngine.departureScanSteps(hours, step);
    // One base for the whole scan. The times announced in `meta` and the times
    // attached to the results have to be the same instants, because that is what
    // a client places results by — and a request without an explicit
    // departureTime would otherwise re-read the clock for each one.
    const baseMs = RoutingEngine.departureScanBase(request);

    res.setHeader("Content-Type", "application/x-ndjson; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    // Proxies that buffer a response would defeat the entire point of streaming.
    res.setHeader("X-Accel-Buffering", "no");

    // Closing the planner, or navigating away, should stop the work — not leave
    // the server computing routes for a window nobody is looking at any more.
    const signal = { aborted: false };
    const stop = (): void => {
      signal.aborted = true;
    };
    res.on("close", stop);

    const write = (obj: unknown): void => {
      if (signal.aborted) return;
      res.write(JSON.stringify(obj) + "\n");
      // Present when a compression middleware is in the chain; without it the
      // lines sit in its buffer until the response ends.
      (res as Response & { flush?: () => void }).flush?.();
    };

    try {
      write({
        type: "meta",
        scanHours: hours,
        stepMinutes: step,
        steps,
        departureTimes: Array.from({ length: steps }, (_, i) =>
          RoutingEngine.departureScanTime(baseMs, i, step),
        ),
        warnings,
      });
      for await (const d of engine.streamDepartures(
        request,
        hours,
        step,
        signal,
        baseMs,
      )) {
        write({ type: "departure", ...d });
      }
      write({ type: signal.aborted ? "aborted" : "done" });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      write({ type: "error", error: message, code: "SCAN_FAILED" });
    } finally {
      res.off("close", stop);
      // Ended unconditionally: after a client hang-up the socket is already
      // gone and this is a no-op, but leaving it out would mean a response that
      // never completes in every path that sets `aborted` without one — and
      // `close` also fires on a perfectly normal finish.
      res.end();
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
      lockWaitMinutes: this.config.lockWaitMinutes,
      bridgeWaitMinutes: this.config.bridgeWaitMinutes,
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
          ((vessel.draft ?? 2.0) + (cfg.safetyMarginDraft ?? 0.3)) * 10,
        ) / 10;
      const effectiveBeam =
        Math.round(
          ((vessel.beam ?? 4.0) + (cfg.safetyMarginBeam ?? 2.0)) * 10,
        ) / 10;
      const effectiveAirDraft =
        Math.round(
          ((vessel.airDraft ?? 0) + (cfg.safetyMarginAirDraft ?? 1.5)) * 10,
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
        loading: [],
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
   * Release-asset download prefix for the same GitHub repository the catalog
   * is served from, e.g.
   *   https://raw.githubusercontent.com/owner/repo/main/routing-index.json
   *   -> https://github.com/owner/repo/releases/download/
   *
   * Large routing databases are published as rolling release assets rather
   * than committed to the repo, so their URLs sit outside catalogBaseUrl()
   * and need their own trusted prefix. It is still pinned to the catalog's
   * own owner/repo: any other repo's releases stay untrusted, which is the
   * same property the catalog-directory check gives us.
   *
   * Null when the catalog is not served from a recognised GitHub raw URL —
   * in that case release-hosted downloads are simply not accepted.
   */
  private releaseDownloadBase(): string | null {
    if (!this.config.catalogUrl) return null;
    try {
      const u = new URL(this.config.catalogUrl);
      const parts = u.pathname.split("/").filter(Boolean);
      let owner: string | undefined;
      let repo: string | undefined;
      if (u.hostname === "raw.githubusercontent.com") {
        // /owner/repo/ref/path...
        [owner, repo] = parts;
      } else if (u.hostname === "github.com" && parts[2] === "raw") {
        // /owner/repo/raw/ref/path...
        [owner, repo] = parts;
      }
      if (!owner || !repo) return null;
      return `https://github.com/${owner}/${repo}/releases/download/`;
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
      if (catalog.regions && Array.isArray(catalog.regions)) {
        for (const region of catalog.regions) {
          // catalog_schema_version >= 1.1.0 carries an absolute download_url
          // for release-hosted databases; `file` (repo-relative, resolved
          // against the catalog's directory) remains for regions still
          // served straight out of the repository.
          if (region.download_url) {
            region.downloadUrl = region.download_url;
          } else if (baseUrl && region.file) {
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
      const { url, filename, sha256 } = req.body;
      if (!url || !filename) {
        res
          .status(400)
          .json({ error: "Missing required fields: url, filename" });
        return;
      }
      if (
        sha256 !== undefined &&
        (typeof sha256 !== "string" || !/^[0-9a-f]{64}$/i.test(sha256))
      ) {
        // typeof check first: RegExp#test() coerces its argument via
        // ToString, and a single-element array stringifies to just that
        // element (no brackets/commas) -- ["<64 hex chars>"] would otherwise
        // pass the regex, then crash on sha256.toLowerCase() below (arrays
        // have no such method) only after the download already ran.
        res
          .status(400)
          .json({ error: "sha256 must be a 64-character hex string" });
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
      // Release assets of the catalog's own repository are equally trusted —
      // that is where the large routing databases actually live.
      const trustedBases = [trustedBase, this.releaseDownloadBase()].filter(
        (b): b is string => b !== null,
      );
      try {
        // Compare the *parsed* href, not the raw string: dot segments and
        // percent-encoding are normalized away first, so a URL that merely
        // starts with the trusted prefix but resolves elsewhere
        // (…/main/../../other/evil.sqlite) is rejected.
        const normalized = new URL(url).href;
        if (!trustedBases.some((b) => normalized.startsWith(b))) {
          res.status(400).json({
            error: `Download URL must be under the configured catalog path (${trustedBases.join(" or ")})`,
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
      // Hashes the bytes exactly as downloaded -- i.e. still gzip-compressed
      // for a .sqlite.gz -- because that is what generate_index.py and
      // deploy_to_data_repo.py hash when they compute the catalog's sha256.
      // Spliced into the pipeline before decompression, so it observes every
      // byte without buffering the file. NOT crypto.createHash() directly:
      // that Hash object is only writable-then-drain -- piped downstream it
      // emits just the final digest, not the data written to it, silently
      // truncating the file to 32 bytes. This wrapper forwards each chunk
      // unchanged in addition to hashing it.
      const hasher = new HashingPassThrough();
      try {
        const src = Readable.fromWeb(response.body as any);
        if (isGzip) {
          await pipeline(
            src,
            hasher,
            zlib.createGunzip(),
            fs.createWriteStream(tmpPath),
          );
          console.log(`[routeiq] Decompressed ${filename} -> ${saveFilename}`);
        } else {
          await pipeline(src, hasher, fs.createWriteStream(tmpPath));
        }
        if (sha256) {
          const actual = hasher.digestHex();
          if (actual.toLowerCase() !== sha256.toLowerCase()) {
            await fs.promises.unlink(tmpPath);
            console.error(
              `[routeiq] SHA-256 mismatch for ${filename}: expected ${sha256}, got ${actual}`,
            );
            res.status(502).json({
              error: `Downloaded file failed integrity check (SHA-256 mismatch) -- the transfer may have been corrupted or interrupted. Try again.`,
            });
            return;
          }
          console.log(`[routeiq] SHA-256 verified for ${filename}`);
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
      // A database is addressed by its plain .sqlite name in both states, so
      // the file actually on disk may carry the .disabled suffix — delete
      // whichever form(s) exist. Removing both when both are present is the
      // unambiguous reading of "delete this database" (unlike the autoload
      // switch, which has to ask which one the user meant to keep).
      let removedActive = false;
      let removedDisabled = false;
      for (const [candidate, wasActive] of [
        [targetPath, true],
        [targetPath + DISABLED_SUFFIX, false],
      ] as Array<[string, boolean]>) {
        try {
          await fs.promises.unlink(candidate);
          if (wasActive) removedActive = true;
          else removedDisabled = true;
        } catch (e: any) {
          if (e && e.code === "ENOENT") continue;
          throw e;
        }
      }
      if (!removedActive && !removedDisabled) {
        res.status(404).json({ error: `Database not found: ${filename}` });
        return;
      }
      console.log(`[routeiq] Database deleted: ${filename}`);

      try {
        if (this.db) await this.db.reloadMetadata();
      } catch (e) {
        console.warn(`[routeiq] Metadata refresh failed after delete: ${e}`);
      }
      // Deleting a file that was only ever disabled cannot have changed the
      // graph, so the full close+reinit is pure cost — on a large installed
      // region that is tens of seconds of stall to remove something the
      // engine never had in memory. The metadata refresh above is enough to
      // drop it from the catalog.
      if (removedActive && this.onReloadRequested) {
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

  /**
   * Switch an installed database between autoload and disabled by renaming it
   * to/from `<name>.sqlite.disabled` — the same on-disk convention the data
   * directory already used by hand, now driven from the Data Manager.
   *
   * Disabling drops the region from the in-memory graph first, preferring
   * RoutingDatabase.unloadDatabaseGraph (cheap, no re-init) and falling back
   * to a full hot reload only when that path refuses. The rename happens
   * after the unload so a failure leaves the file where the engine still
   * expects it.
   *
   * POST /signalk/v1/api/router/databases/enabled  body: { filename, enabled }
   */
  private async handleSetDatabaseEnabled(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    if (!this.requireAuth(req, res)) return;
    try {
      const { filename, enabled } = req.body ?? {};
      if (!filename || typeof filename !== "string") {
        res.status(400).json({ error: "Missing required field: filename" });
        return;
      }
      if (typeof enabled !== "boolean") {
        res
          .status(400)
          .json({ error: "Missing required boolean field: enabled" });
        return;
      }
      // Always addressed by the plain .sqlite identity, in either state — the
      // suffix is derived here, never accepted from the caller. Same guard as
      // handleDeleteDatabase/handleDownloadDatabase.
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
      const resolvedDataDir = path.resolve(dataDir);
      const activePath = path.resolve(dataDir, filename);
      const disabledPath = activePath + DISABLED_SUFFIX;
      if (
        !activePath.startsWith(resolvedDataDir + path.sep) &&
        activePath !== resolvedDataDir
      ) {
        res
          .status(400)
          .json({ error: "Invalid filename: path escapes data directory" });
        return;
      }

      const hasActive = fs.existsSync(activePath);
      const hasDisabled = fs.existsSync(disabledPath);
      if (!hasActive && !hasDisabled) {
        res.status(404).json({ error: `Database not found: ${filename}` });
        return;
      }
      // Reachable in practice: handleDownloadDatabase writes <name>.sqlite
      // unconditionally, so re-downloading a disabled region leaves both. Ask
      // rather than guess which one the user meant to keep.
      if (hasActive && hasDisabled) {
        res.status(409).json({
          error:
            `Both ${filename} and ${filename}${DISABLED_SUFFIX} exist — ` +
            `remove one before switching this database`,
        });
        return;
      }
      if (enabled === hasActive) {
        res.json({
          success: true,
          filename,
          enabled,
          unchanged: true,
          databases: this.db ? this.db.getCoverageStatus() : [],
        });
        return;
      }

      // Free the graph data before the file moves out from under it.
      let needsHotReload = !this.db || !this.db.isDynamicLoadingEnabled();
      if (!enabled && this.db && this.db.isDynamicLoadingEnabled()) {
        const loaded = this.db
          .getCoverageStatus()
          .some((d) => d.filename === filename && d.state === "loaded");
        if (loaded) {
          try {
            await this.db.unloadDatabaseGraph(filename);
          } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            // A route mid-flight is a genuine conflict — the caller should
            // retry. "Only loaded database" is not: disabling the last region
            // is exactly what a user swapping coverage does, so fall through
            // to the full reload, which ends with an empty graph.
            if (/route calculation is in progress/i.test(message)) {
              res.status(409).json({ error: message });
              return;
            }
            needsHotReload = true;
          }
        }
      }

      try {
        await fs.promises.rename(
          enabled ? disabledPath : activePath,
          enabled ? activePath : disabledPath,
        );
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        res
          .status(500)
          .json({ error: `Could not switch ${filename}: ${message}` });
        return;
      }
      console.log(
        `[routeiq] Database ${enabled ? "enabled" : "disabled"}: ${filename}`,
      );

      try {
        if (this.db) await this.db.reloadMetadata();
      } catch (e) {
        console.warn(`[routeiq] Metadata refresh failed after switch: ${e}`);
      }

      // Dynamic mode needs nothing further on enable: eager-load-at-position
      // and route-time selection pick the region up on their own, and a
      // blanket re-init would re-peek every installed database for nothing.
      if (needsHotReload && this.onReloadRequested) {
        try {
          await this.onReloadRequested(dataDir);
          console.log("[routeiq] Routing engine hot-reloaded after switch");
        } catch (e) {
          console.error(`[routeiq] Hot-reload failed after switch: ${e}`);
          res.status(500).json({
            error: `Database ${enabled ? "enabled" : "disabled"} but hot-reload failed: ${e}`,
          });
          return;
        }
      }

      res.json({
        success: true,
        filename,
        enabled,
        databases: this.db ? this.db.getCoverageStatus() : [],
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error("[routeiq] Database enable/disable error:", error);
      res.status(500).json({ error: `Switch failed: ${message}` });
      next(error);
    }
  }
}
