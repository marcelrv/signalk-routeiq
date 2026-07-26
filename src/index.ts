/**
 * SignalK RouteIQ Nautical Route Planner Plugin - Main Entry Point
 *
 * A SignalK server plugin that provides offline-first nautical route planning
 * with vessel-aware A* pathfinding on a pre-computed routing graph.
 */

import { ServerAPI } from "@signalk/server-api";
import * as express from "express";
import * as fs from "fs";
import * as path from "path";

import { ApiHandler } from "./api.js";
import { RoutingDatabase } from "./database.js";
import {
  registerPlotterExtension,
  setPlotterExtensionRunning,
} from "./plotterext.js";
import { RoutingEngine } from "./routing.js";
import { CurrentsClient, TidesClient } from "./tides.js";
import { DEFAULT_CONFIG, PluginConfig } from "./types.js";

/**
 * Narrow surface of the Signal K server API this plugin actually calls.
 * The real `ServerAPI` type doesn't declare these members (they vary across
 * server versions / are augmented at runtime), so callers cast into this
 * shape once at each boundary instead of reaching for `any`.
 */
interface SkAppSurface {
  getSelfPath?(path: string): unknown;
  getPath?(path: string): unknown;
  subscriptionmanager?: {
    subscribe(
      command: unknown,
      unsubscribes: (() => void)[],
      errorCallback: (err: unknown) => void,
      callback: (update: unknown) => void,
    ): void;
  };
  subscribe?(
    subscription: unknown,
    callback: (update: unknown) => void,
  ): () => void;
}

// Plugin state
let database: RoutingDatabase | null = null;
let routingEngine: RoutingEngine | null = null;
let apiHandler: ApiHandler | null = null;

/**
 * Plugin constructor factory for SignalK
 */
export function pluginConstructor(app: ServerAPI) {
  let config: PluginConfig = { ...DEFAULT_CONFIG };
  let vesselDimensions = { draft: 0, beam: 4, airDraft: 0 };
  let subscriptionCancelled: (() => void) | null = null;
  let positionSubscriptionCancelled: (() => void) | null = null;
  // Last position we ran an eager-load for; used to throttle so a moving
  // vessel doesn't re-evaluate coverage on every position delta.
  let lastEagerLoadPos: { lat: number; lon: number } | null = null;

  const pluginId = "signalk-routeiq";
  const __filename = new URL(import.meta.url).pathname;
  const __plugindir = path.dirname(path.dirname(__filename)); // dist/.. → plugin root

  return {
    id: pluginId,
    name: "SignalK RouteIQ Nautical Route Planner",

    /**
     * Start the plugin
     */
    start(options: any, _restart?: () => void) {
      console.log(
        "[routeiq] Starting SignalK RouteIQ Nautical Route Planner Plugin...",
      );

      // Merge received configuration with defaults.
      // routingBBoxMargin/routingBBoxMaxExtent are internal search tuning,
      // removed from the settings schema (2026-07-18) — strip them from any
      // previously-persisted config so a stale saved value (e.g. the old
      // 0.1° default frozen into plugin-config-data) can never override the
      // engine's current defaults.
      const {
        routingBBoxMargin: _ignoredMargin,
        routingBBoxMaxExtent: _ignoredExtent,
        ...userOptions
      } = (options ?? {}) as Record<string, unknown>;
      config = { ...DEFAULT_CONFIG, ...userOptions };

      // Migrate legacy routingDatabase config to routingDataDir
      if (!config.routingDataDir && (options as any).routingDatabase) {
        config.routingDataDir = path.dirname((options as any).routingDatabase);
        console.log(
          `[routeiq] Migrated legacy routingDatabase → routingDataDir: ${config.routingDataDir}`,
        );
      }

      // Nothing configured (fresh install) → the plugin's own Signal K data dir
      if (
        typeof config.routingDataDir !== "string" ||
        !config.routingDataDir.trim()
      ) {
        config.routingDataDir = defaultDataDir();
        console.log(
          `[routeiq] No routing data directory configured, using ${config.routingDataDir}`,
        );
      }

      // Resolve data directory relative to plugin directory
      if (config.routingDataDir && !path.isAbsolute(config.routingDataDir)) {
        config.routingDataDir = path.resolve(
          __plugindir,
          config.routingDataDir,
        );
      }

      // Ensure the data directory exists
      if (config.routingDataDir) {
        try {
          fs.mkdirSync(config.routingDataDir, { recursive: true });
        } catch {
          /* ignore */
        }
      }
      console.log(`[routeiq] Configuration loaded: ${JSON.stringify(config)}`);

      // The handler is created once per server run — here on the first start,
      // or already in registerWithRouter() when the plugin was installed but
      // not yet enabled. start() rebuilds the config object on every config
      // save and the handler keeps a reference, so hand it the fresh one.
      const handler = ensureApiHandler();
      handler.updateConfig(config);

      // Freeboard-SK / chartplotter integration (plotterExtensions manifest + iframe assets)
      registerPlotterExtension(app, __plugindir);
      setPlotterExtensionRunning(true);

      // Set hot-reload callback: when a new database is downloaded, re-init everything
      handler.onReloadRequested = async (dataDir: string) => {
        const currentDims = routingEngine?.vesselDims;
        if (database) {
          await database.close();
          database = null;
        }
        routingEngine = null;

        try {
          database = new RoutingDatabase(
            dataDir,
            config.dynamicLoading,
            config.maxLoadedRegions,
          );
          await database.init();
          await database.loadGraph();
          const stats = await database.getStats();
          console.log(
            `[routeiq] Database hot-reloaded: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.pois} POIs`,
          );

          routingEngine = new RoutingEngine(database, config, currentDims);
          routingEngine.setTidesClient(
            new TidesClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase),
          );
          routingEngine.setCurrentsClient(
            new CurrentsClient(
              config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase,
            ),
          );
          if (apiHandler) {
            apiHandler.setComponents(database, routingEngine);
          }
          console.log(
            "[routeiq] Routing engine hot-reloaded after database download",
          );
        } catch (error) {
          const message =
            error instanceof Error ? error.message : "Unknown error";
          console.error(`[routeiq] Hot-reload failed: ${message}`);
          if (apiHandler) apiHandler.setInitError(message);
        }
      };

      // Re-initialize database/routing engine with (possibly updated) config
      initPluginAsync(app);
    },

    /**
     * Stop the plugin
     */
    async stop() {
      console.log(
        "[routeiq] Stopping SignalK RouteIQ Nautical Route Planner Plugin...",
      );

      // Remove the extension from the plotterExtensions collection so hosts
      // stop offering it (presence == enabled per the extensions spec)
      setPlotterExtensionRunning(false);

      // Unsubscribe from vessel dimensions
      if (subscriptionCancelled) {
        subscriptionCancelled();
        subscriptionCancelled = null;
      }
      // Unsubscribe from navigation.position
      if (positionSubscriptionCancelled) {
        positionSubscriptionCancelled();
        positionSubscriptionCancelled = null;
      }
      lastEagerLoadPos = null;

      // Close database connection
      if (database) {
        await database.close();
        database = null;
      }

      // Detach engine/db from apiHandler, but keep apiHandler alive
      // so Express routes stay registered across stop/start cycles
      if (apiHandler) {
        (apiHandler as any).db = null;
        (apiHandler as any).routingEngine = null;
      }
      routingEngine = null;

      console.log("[routeiq] Plugin stopped");
    },

    /**
     * Get plugin configuration schema
     */
    schema(_app: any) {
      return {
        type: "object",
        properties: {
          routingDataDir: {
            type: "string",
            title: "Routing Data Directory",
            description:
              "Directory containing .sqlite routing graph files. Leave empty to keep them in the plugin's own data directory, which survives plugin updates.",
            default: defaultDataDir(),
          },
          safetyMarginDraft: {
            type: "number",
            title: "Draft Safety Margin (m)",
            description: "Under-keel clearance added to design draft",
            default: DEFAULT_CONFIG.safetyMarginDraft,
            minimum: 0,
            multipleOf: 0.1,
          },
          safetyMarginAirDraft: {
            type: "number",
            title: "Air Draft Safety Margin (m)",
            description: "Mast clearance added to design air draft",
            default: DEFAULT_CONFIG.safetyMarginAirDraft,
            minimum: 0,
            multipleOf: 0.1,
          },
          safetyMarginBeam: {
            type: "number",
            title: "Beam Safety Margin (m)",
            description: "Width clearance added to design beam",
            default: DEFAULT_CONFIG.safetyMarginBeam,
            minimum: 0,
            multipleOf: 0.1,
          },
          defaultCoastDistance: {
            type: "number",
            title: "Default Min Coast Distance (NM)",
            description:
              "Default minimum distance from coastline in nautical miles",
            default: DEFAULT_CONFIG.defaultCoastDistance,
          },
          averageSpeedKnots: {
            type: "number",
            title: "Average Speed (kn)",
            description: "Cruising speed used to estimate route duration / ETA",
            default: DEFAULT_CONFIG.averageSpeedKnots,
            minimum: 0.5,
            multipleOf: 0.1,
          },
          considerTides: {
            type: "boolean",
            title: "Consider Tides by Default",
            description:
              "Factor tidal currents into route calculation. Needs a tide data plugin: signalk-tidal-currents (real current stations, preferred) and/or signalk-tides (height-derived estimate). With neither installed, routes fall back to plain distance. Clients can override per request.",
            default: DEFAULT_CONFIG.considerTides,
          },
          maxTidalCurrentKnots: {
            type: "number",
            title: "Max Tidal Current (kn)",
            description:
              "Spring-tide current at full flood/ebb used to scale the estimated tidal flow",
            default: DEFAULT_CONFIG.maxTidalCurrentKnots,
            minimum: 0,
            multipleOf: 0.1,
          },
          tidesApiBase: {
            type: "string",
            title: "Tides API Base URL",
            description:
              "Server hosting the tide/current data plugins (default: this server)",
            default: DEFAULT_CONFIG.tidesApiBase,
          },
          waypointTolerance: {
            type: "number",
            title: "Waypoint Simplification Tolerance (m)",
            description:
              "Max deviation from the computed path when reducing it to route waypoints (0 = keep every graph node)",
            default: DEFAULT_CONFIG.waypointTolerance,
            minimum: 0,
          },
          wrongWayPenalty: {
            type: "number",
            title: "Wrong Way Penalty",
            description:
              "Penalty multiplier for traveling against traffic flow",
            default: DEFAULT_CONFIG.wrongWayPenalty,
          },
          lineOfSightSampleInterval: {
            type: "number",
            title: "Line-of-Sight Sample Interval (m)",
            description:
              "Spacing between samples when checking line-of-sight for smoothing",
            default: DEFAULT_CONFIG.lineOfSightSampleInterval,
          },
          lineOfSightSearchRadius: {
            type: "number",
            title: "Line-of-Sight Search Radius (m)",
            description:
              "Radius to search for graph nodes when verifying line-of-sight",
            default: DEFAULT_CONFIG.lineOfSightSearchRadius,
          },
          catalogUrl: {
            type: "string",
            title: "Database Catalog URL",
            description:
              "URL to the routing-index.json catalog for downloading routing databases",
            default: DEFAULT_CONFIG.catalogUrl,
          },
          dynamicLoading: {
            type: "boolean",
            title: "Dynamic Database Loading",
            description:
              "Peek installed databases at startup instead of loading all of them; load each region into memory only when a route actually needs it. Leave off for a single-region deployment — there is nothing to gain and startup behavior is unchanged.",
            default: DEFAULT_CONFIG.dynamicLoading,
          },
          eagerLoadAtPosition: {
            type: "boolean",
            title: "Eager-load region at vessel position",
            description:
              "With dynamic loading on, load the region under the vessel at startup and as it moves (via navigation.position), so a positioned vessel boots ready-to-route instead of empty. No effect when dynamic loading is off.",
            default: DEFAULT_CONFIG.eagerLoadAtPosition,
          },
          loadRadiusNm: {
            type: "number",
            title: "Proactive load radius (nm)",
            description:
              "Load a region when the vessel is within this many nautical miles of it, before it actually crosses in. 0 = only load the region the vessel is inside.",
            default: DEFAULT_CONFIG.loadRadiusNm,
          },
          maxLoadedRegions: {
            type: "number",
            title: "Max loaded regions (dynamic loading)",
            description:
              "Only applies with dynamic loading on. Keep at most this many regions loaded in memory, evicting the least-recently-used region once a route finishes and none is in progress. 0 = unlimited (keep every region ever loaded) — uncapped memory growth on long passages.",
            default: DEFAULT_CONFIG.maxLoadedRegions,
          },
        },
      };
    },

    /**
     * Register routes via Signal K's plugin router (mounted at /plugins/<pluginId>/)
     *
     * API only — deliberately no UI here. The server gates all of /plugins
     * behind admin auth, so anything served from this router is invisible to
     * read-only users. The webapp is published instead by the
     * `signalk-webapp` keyword, which mounts public/ at /<package-name>/
     * (i.e. /signalk-routeiq/) with no auth.
     *
     * This used to also serve public/ here, which produced a second copy of
     * the UI that nobody could actually use: 401 for read-only users, and
     * broken even for admins. The page derives its API base from its own URL,
     * so when served from /plugins/signalk-routeiq/ it called
     * /plugins/signalk-routeiq/signalk/v1/api/router/... — which is not where
     * this router mounts the API (that is ./router) and returned 404.
     */
    registerWithRouter(router: express.IRouter) {
      // Always attach routes — ensureApiHandler() covers the case where the
      // plugin is registered while still disabled and start() hasn't run.
      // If the DB isn't loaded yet, routes return 503 Service Unavailable.
      router.use("/router", ensureApiHandler().getRouter());
      console.log("[routeiq] API routes attached");

      console.log("[routeiq] Router registered, awaiting initialization...");
    },

    /**
     * Register routes under Signal K API path (/signalk/v1/api/router/)
     */
    signalKApiRoutes(router: express.IRouter) {
      router.use("/router", ensureApiHandler().getRouter());
      return router;
    },
  };

  /**
   * Where routing databases go when the user hasn't named a directory: a
   * `routing-data` subdirectory of the plugin's own Signal K data dir, i.e.
   * `<config>/plugin-config-data/signalk-routeiq/routing-data`. That location
   * survives plugin updates, unlike the plugin-relative `./data/` this used to
   * default to (npm replaces node_modules/signalk-routeiq wholesale on update,
   * taking any downloaded region databases with it).
   *
   * Only safe to call from start()/schema() — the server assigns
   * getDataDirPath onto the app object after calling pluginConstructor. Older
   * servers that don't provide it at all fall back to the legacy `./data/`
   * path, which is deliberately left un-renamed so those installs keep
   * finding the databases they already downloaded.
   */
  function defaultDataDir(): string {
    try {
      const dir = (
        app as unknown as { getDataDirPath?: () => string }
      ).getDataDirPath?.();
      if (dir) return path.join(dir, "routing-data");
    } catch (error) {
      console.warn(
        "[routeiq] getDataDirPath() failed, falling back to the plugin directory:",
        error,
      );
    }
    return path.join(__plugindir, "data");
  }

  /**
   * Create the API handler if it doesn't exist yet.
   *
   * Signal K calls registerWithRouter()/signalKApiRoutes() for every installed
   * plugin, enabled or not, and only mounts the plugin router once that call
   * returns. On a fresh install the plugin is still disabled, so start() has
   * not run yet and the handler has to be created from here — otherwise
   * registerWithRouter() throws, the server never mounts the router, and the
   * server's own POST /plugins/<id>/config route goes down with it, so the
   * first config save answers 404.
   */
  function ensureApiHandler(): ApiHandler {
    if (!apiHandler) {
      apiHandler = new ApiHandler(config, app);
      console.log("[routeiq] API handler created (awaiting database init)");
    }
    return apiHandler;
  }

  /**
   * Initialize plugin components asynchronously
   */
  async function initPluginAsync(app: ServerAPI) {
    try {
      if (!config.routingDataDir) {
        throw new Error("routingDataDir is not configured");
      }
      database = new RoutingDatabase(
        config.routingDataDir,
        config.dynamicLoading,
        config.maxLoadedRegions,
      );
      await database.init();
      await database.loadGraph();
      const stats = await database.getStats();
      console.log(
        `[routeiq] Database loaded: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.pois} POIs`,
      );

      routingEngine = new RoutingEngine(database, config);
      routingEngine.setTidesClient(
        new TidesClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase),
      );
      routingEngine.setCurrentsClient(
        new CurrentsClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase),
      );
      apiHandler!.setComponents(database, routingEngine);
      console.log("[routeiq] API handler ready");

      // Fetch initial vessel dimensions synchronously (subscription may not fire for static values)
      await fetchInitialVesselDimensions(app);

      // Subscribe to future vessel dimension changes
      await subscribeToVesselDimensions(app);

      // §4a: with dynamic loading on, boot the region under the vessel (and,
      // for a single-region install, the sole database) rather than an empty
      // graph, then keep it current via a navigation.position subscription.
      if (config.dynamicLoading) {
        await database.eagerLoadIfSingle();
        if (config.eagerLoadAtPosition) {
          await fetchInitialPosition(app);
          await subscribeToPosition(app);
        }
      }
      console.log("[routeiq] Plugin started successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[routeiq] Failed to initialize: ${message}`);
      // Surface the error through the API so the frontend can show it rather
      // than polling forever on a 503. The app (map, data manager) stays usable.
      apiHandler!.setInitError(message);
    }
  }

  /**
   * Fetch initial vessel dimensions from Signal K path API
   */
  async function fetchInitialVesselDimensions(app: ServerAPI) {
    try {
      const app_ = app as unknown as SkAppSurface;
      let draft: number | undefined;
      let beam: number | undefined;
      let airDraft: number | undefined;

      // Try getSelfPath (preferred)
      if (typeof app_.getSelfPath === "function") {
        const draftPath = app_.getSelfPath("design.draft");
        draft = extractNumberValue(draftPath);
        const beamPath = app_.getSelfPath("design.beam");
        beam = extractNumberValue(beamPath);
        const airDraftPath = app_.getSelfPath("design.airHeight");
        airDraft = extractNumberValue(airDraftPath);
      } else if (typeof app_.getPath === "function") {
        // Fallback: full path
        const draftPath = app_.getPath("vessels.self.design.draft");
        draft = extractNumberValue(draftPath);
        const beamPath = app_.getPath("vessels.self.design.beam");
        beam = extractNumberValue(beamPath);
        const airDraftPath = app_.getPath("vessels.self.design.airHeight");
        airDraft = extractNumberValue(airDraftPath);
      }

      if (draft !== undefined || beam !== undefined || airDraft !== undefined) {
        const newDimensions: Partial<typeof vesselDimensions> = {};
        if (draft !== undefined) newDimensions.draft = draft;
        if (beam !== undefined) newDimensions.beam = beam;
        if (airDraft !== undefined) newDimensions.airDraft = airDraft;
        vesselDimensions = { ...vesselDimensions, ...newDimensions };
        routingEngine!.setVesselDimensions(vesselDimensions);
        console.log(
          `[routeiq] Vessel dimensions (from path API): ${JSON.stringify(vesselDimensions)}`,
        );
      }
    } catch (error) {
      console.warn(
        "[routeiq] Failed to fetch initial vessel dimensions:",
        error,
      );
    }
  }

  /**
   * Extract a numeric value from a Signal K path value (handles nested formats)
   */
  function extractNumberValue(v: any): number | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === "number") return v;
    if (typeof v.value === "number") return v.value;
    if (v.value && typeof v.value.maximum === "number") return v.value.maximum;
    if (typeof v.maximum === "number") return v.maximum;
    if (typeof v.current === "number") return v.current;
    return undefined;
  }

  /**
   * Subscribe to vessel dimensions from Signal K delta tree
   */
  async function subscribeToVesselDimensions(app: ServerAPI) {
    try {
      const app_ = app as unknown as SkAppSurface;
      if (typeof app_.subscriptionmanager?.subscribe === "function") {
        const command = {
          context: "vessels.self",
          subscribe: [
            { path: "design.draft", period: 1000, format: "delta" },
            { path: "design.beam", period: 1000, format: "delta" },
            { path: "design.airHeight", period: 1000, format: "delta" },
          ],
        };
        const unsubscribeFns: (() => void)[] = [];
        app_.subscriptionmanager.subscribe(
          command,
          unsubscribeFns, // collect unsubscribe callbacks
          () => {}, // errorCallback
          (update: any) => {
            // callback
            handleVesselUpdate(update);
          },
        );
        subscriptionCancelled = () => {
          unsubscribeFns.forEach((fn) => fn());
        };
      } else if (typeof app_.subscribe === "function") {
        // fallback: older API
        const subscription = {
          context: "vessels.self",
          subscribe: [
            { path: "design.draft" },
            { path: "design.beam" },
            { path: "design.airHeight" },
          ],
        };
        subscriptionCancelled = app_.subscribe(subscription, (update: any) => {
          handleVesselUpdate(update);
        });
      }
    } catch (error) {
      console.warn(
        "[routeiq] Failed to subscribe to vessel dimensions:",
        error,
      );
    }
  }

  /**
   * Fetch the current vessel position from the SK path API and eager-load the
   * region under it (a subscription may not fire for an already-known position).
   */
  async function fetchInitialPosition(app: ServerAPI) {
    try {
      const app_ = app as unknown as SkAppSurface;
      let pos: any;
      if (typeof app_.getSelfPath === "function") {
        pos = app_.getSelfPath("navigation.position");
      } else if (typeof app_.getPath === "function") {
        pos = app_.getPath("vessels.self.navigation.position");
      }
      const ll = extractLatLon(pos);
      if (ll) await maybeEagerLoad(ll.lat, ll.lon);
      else
        console.log(
          "[routeiq] No vessel position yet — regions will load on movement or on the first route request",
        );
    } catch (error) {
      console.warn("[routeiq] Failed to fetch initial vessel position:", error);
    }
  }

  /**
   * Subscribe to navigation.position and eager-load the covering region as the
   * vessel moves (throttled via maybeEagerLoad).
   */
  async function subscribeToPosition(app: ServerAPI) {
    try {
      const app_ = app as unknown as SkAppSurface;
      if (typeof app_.subscriptionmanager?.subscribe === "function") {
        const command = {
          context: "vessels.self",
          subscribe: [
            { path: "navigation.position", period: 10000, format: "delta" },
          ],
        };
        const unsubscribeFns: (() => void)[] = [];
        app_.subscriptionmanager.subscribe(
          command,
          unsubscribeFns,
          () => {},
          (update: any) => {
            handlePositionUpdate(update);
          },
        );
        positionSubscriptionCancelled = () => {
          unsubscribeFns.forEach((fn) => fn());
        };
      } else if (typeof app_.subscribe === "function") {
        const subscription = {
          context: "vessels.self",
          subscribe: [{ path: "navigation.position" }],
        };
        positionSubscriptionCancelled = app_.subscribe(
          subscription,
          (update: any) => {
            handlePositionUpdate(update);
          },
        );
      }
    } catch (error) {
      console.warn(
        "[routeiq] Failed to subscribe to navigation.position:",
        error,
      );
    }
  }

  /** Extract {lat, lon} from a Signal K position value (handles {value:{latitude,longitude}} and plain shapes). */
  function extractLatLon(v: any): { lat: number; lon: number } | null {
    if (!v) return null;
    const p = v.value && typeof v.value === "object" ? v.value : v;
    const lat = typeof p.latitude === "number" ? p.latitude : undefined;
    const lon = typeof p.longitude === "number" ? p.longitude : undefined;
    if (typeof lat === "number" && typeof lon === "number") return { lat, lon };
    return null;
  }

  /** Handle a navigation.position delta: pull lat/lon and eager-load. */
  function handlePositionUpdate(delta: any) {
    if (!database) return;
    let ll: { lat: number; lon: number } | null = null;
    const updates = delta.updates || [];
    for (const update of updates) {
      const values = update.values || [];
      for (const entry of values) {
        if ((entry.path || "") === "navigation.position")
          ll = extractLatLon(entry.value) || ll;
      }
    }
    if (!ll && delta.vessels) {
      for (const vessel of Object.values(delta.vessels) as any[]) {
        ll =
          extractLatLon(vessel.navigation && vessel.navigation.position) || ll;
      }
    }
    if (ll) void maybeEagerLoad(ll.lat, ll.lon);
  }

  /** Throttled eager-load: only re-evaluate coverage once the vessel has moved
   *  ~1nm from the last position loaded for, to avoid churning per delta. */
  async function maybeEagerLoad(lat: number, lon: number) {
    if (!database || !config.dynamicLoading || !config.eagerLoadAtPosition)
      return;
    if (lastEagerLoadPos) {
      const dLat = (lat - lastEagerLoadPos.lat) * 60;
      const dLon =
        (lon - lastEagerLoadPos.lon) * 60 * Math.cos((lat * Math.PI) / 180);
      if (Math.sqrt(dLat * dLat + dLon * dLon) < 1.0) return;
    }
    lastEagerLoadPos = { lat, lon };
    try {
      await database.eagerLoadForPosition(lat, lon, config.loadRadiusNm);
    } catch (e) {
      console.warn("[routeiq] Eager position load failed:", e);
    }
  }

  /**
   * Handle vessel dimension updates from Signal K
   */
  function handleVesselUpdate(delta: any) {
    if (!routingEngine) return;
    const newDimensions: Partial<typeof vesselDimensions> = {};

    // Extract values from delta updates array
    const updates = delta.updates || [];
    for (const update of updates) {
      const values = update.values || [];
      for (const entry of values) {
        const p = entry.path || "";
        const value = entry.value;
        const numValue =
          typeof value === "number"
            ? value
            : typeof value?.value === "number"
              ? value.value
              : (value?.value?.maximum ??
                value?.maximum ??
                value?.current ??
                value);
        if (typeof numValue === "number") {
          if (p === "design.draft" || p === "design.draft.value")
            newDimensions.draft = numValue;
          if (p === "design.beam" || p === "design.beam.value")
            newDimensions.beam = numValue;
          if (p === "design.airHeight" || p === "design.airHeight.value")
            newDimensions.airDraft = numValue;
        }
      }
    }

    // Also try full-tree format (from app.getPath or similar)
    if (delta.vessels) {
      const vessels = delta.vessels || {};
      for (const vessel of Object.values(vessels) as any[]) {
        const design = vessel.design || {};
        if (design.draft !== undefined && typeof design.draft !== "string") {
          const extracted = extractNumberValue(design.draft);
          if (extracted !== undefined) newDimensions.draft = extracted;
        }
        if (design.beam !== undefined && typeof design.beam !== "string") {
          const extracted = extractNumberValue(design.beam);
          if (extracted !== undefined) newDimensions.beam = extracted;
        }
        if (
          design.airHeight !== undefined &&
          typeof design.airHeight !== "string"
        ) {
          const extracted = extractNumberValue(design.airHeight);
          if (extracted !== undefined) newDimensions.airDraft = extracted;
        }
      }
    }

    // Update vessel dimensions if we got any values
    if (Object.keys(newDimensions).length > 0) {
      vesselDimensions = { ...vesselDimensions, ...newDimensions };
      routingEngine.setVesselDimensions(vesselDimensions);
      console.log(
        `[routeiq] Vessel dimensions updated: ${JSON.stringify(vesselDimensions)}`,
      );
    }
  }
}

// Default export for Signal K server's ESM loader (returns module.default)
export { pluginConstructor as default };
