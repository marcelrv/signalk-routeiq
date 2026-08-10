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

import { ApiHandler, coerceVesselDimension } from "./api.js";
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
  // Lifecycle serialization — see runLifecycle(). Every transition that tears
  // down or rebuilds the shared database/engine runs through it, one at a time,
  // tagged with a generation so a superseded transition can drop its work.
  let lifecycleGeneration = 0;
  let lifecycleChain: Promise<void> = Promise.resolve();

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

      // Migrate legacy routingDatabase config to routingDataDir. Read through
      // the normalized options above: the raw argument may be absent on a fresh
      // start, and a non-string value would throw in path.dirname().
      const legacyRoutingDatabase = userOptions.routingDatabase;
      if (!config.routingDataDir && typeof legacyRoutingDatabase === "string") {
        config.routingDataDir = path.dirname(legacyRoutingDatabase);
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

      // Set hot-reload callback: when a new database is downloaded, re-init
      // everything. Queued behind any in-flight transition, so a download that
      // lands while startup is still loading the graph waits for it rather
      // than racing it for the shared components.
      handler.onReloadRequested = (dataDir: string) =>
        runLifecycle("Hot reload", (generation) =>
          reloadPluginAsync(dataDir, generation),
        );

      // Re-initialize database/routing engine with (possibly updated) config
      void runLifecycle("Initialization", (generation) =>
        initPluginAsync(app, generation),
      );
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

      // Awaiting the transition means this resolves only once teardown is
      // really done, as the server-api docs ask, instead of leaving the rest of
      // the teardown to run after Signal K has already called start() again.
      await runLifecycle("Teardown", () => teardownComponents());

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
          coverageGapMeters: {
            type: "number",
            title: "Coverage Gap Warning (m)",
            description:
              "A start or destination further than this from any charted waterway is reported as a coverage gap rather than an ordinary connection. That leg is a straight line, not a routed path, and is not depth-checked — usually it means the routing data does not cover the water there. 0 turns the warning off.",
            default: DEFAULT_CONFIG.coverageGapMeters,
            minimum: 0,
          },
          lockWaitMinutes: {
            type: "number",
            title: "Typical Lock Wait (min)",
            description:
              "Time allowed for each lock on a route. Counts towards the estimated duration and arrival time only — it never changes which way a route goes. A routing database may carry its own figure for a specific lock, which takes precedence.",
            default: DEFAULT_CONFIG.lockWaitMinutes,
            minimum: 0,
          },
          bridgeWaitMinutes: {
            type: "number",
            title: "Typical Opening Bridge Wait (min)",
            description:
              "Time allowed for each opening bridge on a route. Fixed spans have no wait — you either fit under them or you do not. Counts towards the estimated duration and arrival time only.",
            default: DEFAULT_CONFIG.bridgeWaitMinutes,
            minimum: 0,
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
   * Run a lifecycle transition (initialization, teardown or hot reload) in
   * isolation from every other one.
   *
   * Signal K calls stop() then start() on every config save and does not
   * reliably await stop(), and the API fires hot reloads from Express handlers,
   * so these transitions do overlap. They all mutate the same module-level
   * database/engine/subscription state across awaits, which without
   * serialization interleaves: a teardown resuming after `await db.close()`
   * nulls out components a concurrent initialization has just published,
   * leaving routing dead until the server restarts, and each transition leaks
   * the other's worker thread.
   *
   * `fn` is queued behind whatever is already running, so only one transition
   * ever writes the shared state. The generation is bumped synchronously on
   * entry — before `fn` starts — so a transition already in flight can see it
   * has been superseded and discard its work instead of publishing components
   * that the queued transition would only have to undo.
   */
  function runLifecycle(
    label: string,
    fn: (generation: number) => Promise<void>,
  ): Promise<void> {
    const generation = ++lifecycleGeneration;
    const run = lifecycleChain.then(() => fn(generation));
    // Keep the chain usable after a failed transition and never leave an
    // unhandled rejection on it; callers that care still get `run` itself.
    lifecycleChain = run.then(
      () => undefined,
      (error) => {
        console.error(`[routeiq] ${label} failed:`, error);
      },
    );
    return run;
  }

  /**
   * Run an unsubscribe callback. These come from the Signal K subscription
   * manager, so a throw here must not abort the teardown that called it and
   * leave the database open.
   */
  function cancelSubscription(cancel: (() => void) | null, what: string) {
    if (!cancel) return;
    try {
      cancel();
    } catch (error) {
      console.warn(`[routeiq] Failed to unsubscribe from ${what}:`, error);
    }
  }

  /** Install a vessel-dimensions unsubscribe, cancelling any previous one. */
  function setDimensionsSubscription(cancel: (() => void) | null) {
    cancelSubscription(subscriptionCancelled, "vessel dimensions");
    subscriptionCancelled = cancel;
  }

  /** Install a navigation.position unsubscribe, cancelling any previous one. */
  function setPositionSubscription(cancel: (() => void) | null) {
    cancelSubscription(positionSubscriptionCancelled, "navigation.position");
    positionSubscriptionCancelled = cancel;
  }

  /**
   * Close a database that is being dropped, whether it was ever published or
   * not. Failures are logged rather than thrown: every caller is on a teardown
   * or swap path where propagating would leave the plugin unready with no
   * database at all, and nothing else holds a reference to close later.
   */
  async function discardDatabase(db: RoutingDatabase, reason: string) {
    console.log(`[routeiq] Closing database (${reason})`);
    try {
      await db.close();
    } catch (error) {
      console.warn("[routeiq] Failed to close database:", error);
    }
  }

  /**
   * Release and close whatever is currently published, if anything.
   *
   * The API handler is unpublished *before* the close, so requests answer a
   * clean 503 for the duration instead of reaching a closed database. The
   * handler itself stays alive so its Express routes remain registered across
   * stop/start cycles.
   */
  async function unpublishComponents(reason: string) {
    const previous = database;
    database = null;
    routingEngine = null;
    apiHandler?.clearComponents();
    if (previous) await discardDatabase(previous, reason);
  }

  /**
   * Drop all components and subscriptions. Only ever called inside
   * runLifecycle(), so no initialization can be midway through publishing.
   */
  async function teardownComponents() {
    setDimensionsSubscription(null);
    setPositionSubscription(null);
    lastEagerLoadPos = null;
    await unpublishComponents("plugin teardown");
  }

  /**
   * Initialize plugin components asynchronously.
   *
   * The database and engine are built into locals and published only while this
   * initialization is still the current one, so a superseded init closes what it
   * built rather than handing a stale database to the API handler.
   */
  async function initPluginAsync(app: ServerAPI, generation: number) {
    const isCurrent = () => generation === lifecycleGeneration;
    let db: RoutingDatabase | null = null;
    try {
      if (!config.routingDataDir) {
        throw new Error("routingDataDir is not configured");
      }
      db = new RoutingDatabase(
        config.routingDataDir,
        config.dynamicLoading,
        config.maxLoadedRegions,
      );
      await db.init();
      await db.loadGraph();
      if (!isCurrent()) {
        await discardDatabase(db, "superseded initialization");
        return;
      }
      const stats = await db.getStats();
      console.log(
        `[routeiq] Database loaded: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.pois} POIs`,
      );

      const engine = new RoutingEngine(db, config);
      engine.setTidesClient(
        new TidesClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase),
      );
      engine.setCurrentsClient(
        new CurrentsClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase),
      );

      // Release anything a previous initialization published. Signal K normally
      // calls stop() first, but two start()s without one would otherwise drop a
      // live database — and its worker thread — out of teardown's reach.
      await unpublishComponents("replaced by a new initialization");

      if (!isCurrent()) {
        await discardDatabase(db, "superseded initialization");
        return;
      }

      // Publish. Past this point the components are shared state and a queued
      // teardown owns closing them, so bailing out must not close them here.
      database = db;
      routingEngine = engine;
      apiHandler!.setComponents(db, engine);
      console.log("[routeiq] API handler ready");

      // Fetch initial vessel dimensions synchronously (subscription may not fire for static values)
      await fetchInitialVesselDimensions(app);

      // Subscribe to future vessel dimension changes
      const cancelDimensions = await subscribeToVesselDimensions(app);
      if (!isCurrent()) {
        cancelSubscription(cancelDimensions, "vessel dimensions");
        return;
      }
      setDimensionsSubscription(cancelDimensions);

      // §4a: with dynamic loading on, boot the region under the vessel (and,
      // for a single-region install, the sole database) rather than an empty
      // graph, then keep it current via a navigation.position subscription.
      if (config.dynamicLoading) {
        await db.eagerLoadIfSingle();
        if (config.eagerLoadAtPosition) {
          await fetchInitialPosition(app);
          const cancelPosition = await subscribeToPosition(app);
          if (!isCurrent()) {
            cancelSubscription(cancelPosition, "navigation.position");
            return;
          }
          setPositionSubscription(cancelPosition);
        }
      }
      console.log("[routeiq] Plugin started successfully");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[routeiq] Failed to initialize: ${message}`);
      if (db && database !== db) {
        await discardDatabase(db, "failed initialization");
      }
      // Surface the error through the API so the frontend can show it rather
      // than polling forever on a 503. The app (map, data manager) stays usable.
      // A superseded init must not overwrite the live one's state.
      if (isCurrent()) apiHandler!.setInitError(message);
    }
  }

  /**
   * Rebuild the database and engine against `dataDir` after a database download
   * or delete.
   *
   * Subscriptions are deliberately left in place: their callbacks read the
   * shared components, so re-pointing those is enough.
   */
  async function reloadPluginAsync(dataDir: string, generation: number) {
    const isCurrent = () => generation === lifecycleGeneration;
    if (!isCurrent()) {
      // A teardown or a fresh initialization is already queued behind us, and
      // `dataDir` is always config.routingDataDir, so that transition
      // establishes the correct state for this directory anyway.
      console.log("[routeiq] Skipping superseded hot reload");
      return;
    }

    const currentDims = routingEngine?.vesselDims;
    // Unpublishes the API handler too, so requests answer 503 for the duration
    // of the swap rather than reaching the database being closed. A failing
    // close is logged, not thrown: propagating here would leave the plugin with
    // no database and no attempt to load the new one.
    await unpublishComponents("replaced by hot reload");

    let db: RoutingDatabase | null = null;
    try {
      db = new RoutingDatabase(
        dataDir,
        config.dynamicLoading,
        config.maxLoadedRegions,
      );
      await db.init();
      await db.loadGraph();
      if (!isCurrent()) {
        await discardDatabase(db, "superseded hot reload");
        return;
      }
      const stats = await db.getStats();
      console.log(
        `[routeiq] Database hot-reloaded: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.pois} POIs`,
      );

      const engine = new RoutingEngine(db, config, currentDims);
      engine.setTidesClient(
        new TidesClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase),
      );
      engine.setCurrentsClient(
        new CurrentsClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase),
      );
      if (!isCurrent()) {
        await discardDatabase(db, "superseded hot reload");
        return;
      }

      database = db;
      routingEngine = engine;
      if (apiHandler) {
        apiHandler.setComponents(db, engine);
      }
      console.log(
        "[routeiq] Routing engine hot-reloaded after database download",
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "Unknown error";
      console.error(`[routeiq] Hot-reload failed: ${message}`);
      if (db && database !== db) {
        await discardDatabase(db, "failed hot reload");
      }
      if (apiHandler && isCurrent()) apiHandler.setInitError(message);
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
        draft = coerceVesselDimension(draftPath);
        const beamPath = app_.getSelfPath("design.beam");
        beam = coerceVesselDimension(beamPath);
        const airDraftPath = app_.getSelfPath("design.airHeight");
        airDraft = coerceVesselDimension(airDraftPath);
      } else if (typeof app_.getPath === "function") {
        // Fallback: full path
        const draftPath = app_.getPath("vessels.self.design.draft");
        draft = coerceVesselDimension(draftPath);
        const beamPath = app_.getPath("vessels.self.design.beam");
        beam = coerceVesselDimension(beamPath);
        const airDraftPath = app_.getPath("vessels.self.design.airHeight");
        airDraft = coerceVesselDimension(airDraftPath);
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
   * Subscribe to vessel dimensions from Signal K delta tree.
   *
   * Returns the unsubscribe callback rather than installing it, so the caller
   * can drop it if its initialization has meanwhile been superseded.
   */
  async function subscribeToVesselDimensions(
    app: ServerAPI,
  ): Promise<(() => void) | null> {
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
        return () => {
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
        return app_.subscribe(subscription, (update: any) => {
          handleVesselUpdate(update);
        });
      }
    } catch (error) {
      console.warn(
        "[routeiq] Failed to subscribe to vessel dimensions:",
        error,
      );
    }
    return null;
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
  async function subscribeToPosition(
    app: ServerAPI,
  ): Promise<(() => void) | null> {
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
        return () => {
          unsubscribeFns.forEach((fn) => fn());
        };
      } else if (typeof app_.subscribe === "function") {
        const subscription = {
          context: "vessels.self",
          subscribe: [{ path: "navigation.position" }],
        };
        return app_.subscribe(subscription, (update: any) => {
          handlePositionUpdate(update);
        });
      }
    } catch (error) {
      console.warn(
        "[routeiq] Failed to subscribe to navigation.position:",
        error,
      );
    }
    return null;
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
        const numValue = coerceVesselDimension(entry.value);
        if (numValue !== undefined) {
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
        const draft = coerceVesselDimension(design.draft);
        if (draft !== undefined) newDimensions.draft = draft;
        const beam = coerceVesselDimension(design.beam);
        if (beam !== undefined) newDimensions.beam = beam;
        const airHeight = coerceVesselDimension(design.airHeight);
        if (airHeight !== undefined) newDimensions.airDraft = airHeight;
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
