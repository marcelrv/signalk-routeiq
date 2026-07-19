/**
 * SignalK RouteIQ Nautical Route Planner Plugin - Main Entry Point
 * 
 * A SignalK server plugin that provides offline-first nautical route planning
 * with vessel-aware A* pathfinding on a pre-computed routing graph.
 */

import { ServerAPI } from '@signalk/server-api';
import * as express from 'express';
import * as fs from 'fs';
import * as path from 'path';

import { ApiHandler } from './api.js';
import { RoutingDatabase } from './database.js';
import { registerPlotterExtension, setPlotterExtensionRunning } from './plotterext.js';
import { RoutingEngine } from './routing.js';
import { CurrentsClient, TidesClient } from './tides.js';
import { DEFAULT_CONFIG, PluginConfig } from './types.js';

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

  const pluginId = 'signalk-routeiq';
  const __filename = new URL(import.meta.url).pathname;
  const __plugindir = path.dirname(path.dirname(__filename)); // dist/.. → plugin root

  return {
    id: pluginId,
    name: 'SignalK RouteIQ Nautical Route Planner',

    /**
     * Start the plugin
     */
    start(options: any, _restart?: () => void) {
      console.log('[routeiq] Starting SignalK RouteIQ Nautical Route Planner Plugin...');

      // Merge received configuration with defaults.
      // routingBBoxMargin/routingBBoxMaxExtent are internal search tuning,
      // removed from the settings schema (2026-07-18) — strip them from any
      // previously-persisted config so a stale saved value (e.g. the old
      // 0.1° default frozen into plugin-config-data) can never override the
      // engine's current defaults.
      const { routingBBoxMargin: _ignoredMargin, routingBBoxMaxExtent: _ignoredExtent,
        ...userOptions } = (options ?? {}) as Record<string, unknown>;
      config = { ...DEFAULT_CONFIG, ...userOptions };

      // Migrate legacy routingDatabase config to routingDataDir
      if (!config.routingDataDir && (options as any).routingDatabase) {
        config.routingDataDir = path.dirname((options as any).routingDatabase);
        console.log(`[routeiq] Migrated legacy routingDatabase → routingDataDir: ${config.routingDataDir}`);
      }

      // Resolve data directory relative to plugin directory
      if (config.routingDataDir && !path.isAbsolute(config.routingDataDir)) {
        config.routingDataDir = path.resolve(__plugindir, config.routingDataDir);
      }

      // Ensure the data directory exists
      if (config.routingDataDir) {
        try { fs.mkdirSync(config.routingDataDir, { recursive: true }); } catch { /* ignore */ }
      }
      console.log(`[routeiq] Configuration loaded: ${JSON.stringify(config)}`);

      // Create ApiHandler once; Express routes are registered against it on first start.
      // On subsequent starts (config save), only the routing engine is recreated.
      if (!apiHandler) {
        apiHandler = new ApiHandler(config, app);
        console.log('[routeiq] API handler created (awaiting database init)');
      } else {
        // start() rebuilds the config object on every config save; the
        // handler keeps a reference, so hand it the fresh one.
        apiHandler.updateConfig(config);
      }

      // Freeboard-SK / chartplotter integration (plotterExtensions manifest + iframe assets)
      registerPlotterExtension(app, __plugindir);
      setPlotterExtensionRunning(true);

      // Set hot-reload callback: when a new database is downloaded, re-init everything
      apiHandler.onReloadRequested = async (dataDir: string) => {
        const currentDims = routingEngine?.vesselDims;
        if (database) {
          await database.close();
          database = null;
        }
        routingEngine = null;

        try {
          database = new RoutingDatabase(dataDir, config.dynamicLoading);
          await database.init();
          await database.loadGraph();
          const stats = await database.getStats();
          console.log(`[routeiq] Database hot-reloaded: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.pois} POIs`);

          routingEngine = new RoutingEngine(database, config, currentDims);
          routingEngine.setTidesClient(new TidesClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase));
          routingEngine.setCurrentsClient(new CurrentsClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase));
          if (apiHandler) {
            apiHandler.setComponents(database, routingEngine);
          }
          console.log('[routeiq] Routing engine hot-reloaded after database download');
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Unknown error';
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
      console.log('[routeiq] Stopping SignalK RouteIQ Nautical Route Planner Plugin...');

      // Remove the extension from the plotterExtensions collection so hosts
      // stop offering it (presence == enabled per the extensions spec)
      setPlotterExtensionRunning(false);

      // Unsubscribe from vessel dimensions
      if (subscriptionCancelled) {
        subscriptionCancelled();
        subscriptionCancelled = null;
      }

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

      console.log('[routeiq] Plugin stopped');
    },

    /**
     * Get plugin configuration schema
     */
    schema(_app: any) {
      return {
        type: 'object',
        properties: {
          routingDataDir: {
            type: 'string',
            title: 'Routing Data Directory',
            description: 'Directory containing .sqlite routing graph files',
            default: DEFAULT_CONFIG.routingDataDir,
          },
          safetyMarginDraft: {
            type: 'number',
            title: 'Draft Safety Margin (m)',
            description: 'Under-keel clearance added to design draft',
            default: DEFAULT_CONFIG.safetyMarginDraft,
            minimum: 0,
            multipleOf: 0.1,
          },
          safetyMarginAirDraft: {
            type: 'number',
            title: 'Air Draft Safety Margin (m)',
            description: 'Mast clearance added to design air draft',
            default: DEFAULT_CONFIG.safetyMarginAirDraft,
            minimum: 0,
            multipleOf: 0.1,
          },
          safetyMarginBeam: {
            type: 'number',
            title: 'Beam Safety Margin (m)',
            description: 'Width clearance added to design beam',
            default: DEFAULT_CONFIG.safetyMarginBeam,
            minimum: 0,
            multipleOf: 0.1,
          },
          defaultCoastDistance: {
            type: 'number',
            title: 'Default Min Coast Distance (NM)',
            description: 'Default minimum distance from coastline in nautical miles',
            default: DEFAULT_CONFIG.defaultCoastDistance,
          },
          averageSpeedKnots: {
            type: 'number',
            title: 'Average Speed (kn)',
            description: 'Cruising speed used to estimate route duration / ETA',
            default: DEFAULT_CONFIG.averageSpeedKnots,
            minimum: 0.5,
            multipleOf: 0.1,
          },
          considerTides: {
            type: 'boolean',
            title: 'Consider Tides by Default',
            description: 'Use estimated tidal currents in route calculation (requires the signalk-tides plugin). Clients can override per request.',
            default: DEFAULT_CONFIG.considerTides,
          },
          maxTidalCurrentKnots: {
            type: 'number',
            title: 'Max Tidal Current (kn)',
            description: 'Spring-tide current at full flood/ebb used to scale the estimated tidal flow',
            default: DEFAULT_CONFIG.maxTidalCurrentKnots,
            minimum: 0,
            multipleOf: 0.1,
          },
          tidesApiBase: {
            type: 'string',
            title: 'Tides API Base URL',
            description: 'Server hosting the signalk-tides plugin (default: this server)',
            default: DEFAULT_CONFIG.tidesApiBase,
          },
          waypointTolerance: {
            type: 'number',
            title: 'Waypoint Simplification Tolerance (m)',
            description: 'Max deviation from the computed path when reducing it to route waypoints (0 = keep every graph node)',
            default: DEFAULT_CONFIG.waypointTolerance,
            minimum: 0,
          },
          wrongWayPenalty: {
            type: 'number',
            title: 'Wrong Way Penalty',
            description: 'Penalty multiplier for traveling against traffic flow',
            default: DEFAULT_CONFIG.wrongWayPenalty,
          },
          lineOfSightSampleInterval: {
            type: 'number',
            title: 'Line-of-Sight Sample Interval (m)',
            description: 'Spacing between samples when checking line-of-sight for smoothing',
            default: DEFAULT_CONFIG.lineOfSightSampleInterval,
          },
          lineOfSightSearchRadius: {
            type: 'number',
            title: 'Line-of-Sight Search Radius (m)',
            description: 'Radius to search for graph nodes when verifying line-of-sight',
            default: DEFAULT_CONFIG.lineOfSightSearchRadius,
          },
          catalogUrl: {
            type: 'string',
            title: 'Database Catalog URL',
            description: 'URL to the index.json catalog for downloading routing databases',
            default: DEFAULT_CONFIG.catalogUrl,
          },
          dynamicLoading: {
            type: 'boolean',
            title: 'Dynamic Database Loading',
            description: 'Peek installed databases at startup instead of loading all of them; load each region into memory only when a route actually needs it. Leave off for a single-region deployment — there is nothing to gain and startup behavior is unchanged.',
            default: DEFAULT_CONFIG.dynamicLoading,
          },
        },
      };
    },

    /**
     * Register routes via Signal K's plugin router (mounted at /plugins/<pluginId>/)
     */
    registerWithRouter(router: express.IRouter) {

      // Serve frontend static files
      const publicPath = path.join(__plugindir, 'public');
      if (fs.existsSync(publicPath)) {
        // Serve index.html at the root explicitly (SK may intercept /plugins/<id>)
        router.get('/', (_req, res) => {
          res.sendFile(path.join(publicPath, 'index.html'));
        });
        router.use(express.static(publicPath));
        console.log(`[routeiq] Frontend served from: ${publicPath}`);
      }

      // Always attach routes — apiHandler was created synchronously in start()
      // so it's guaranteed to exist here. If the DB isn't loaded yet, routes
      // will return 503 Service Unavailable.
      router.use('/router', apiHandler!.getRouter());
      console.log('[routeiq] API routes attached');

      console.log('[routeiq] Router registered, awaiting initialization...');
    },

    /**
     * Register routes under Signal K API path (/signalk/v1/api/router/)
     */
    signalKApiRoutes(router: express.IRouter) {
      if (apiHandler) {
      router.use('/router', apiHandler!.getRouter());
      }
      return router;
    },
  };

  /**
   * Initialize plugin components asynchronously
   */
  async function initPluginAsync(app: ServerAPI) {
    try {
      if (!config.routingDataDir) {
        throw new Error('routingDataDir is not configured');
      }
      database = new RoutingDatabase(config.routingDataDir, config.dynamicLoading);
      await database.init();
      await database.loadGraph();
      const stats = await database.getStats();
      console.log(`[routeiq] Database loaded: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.pois} POIs`);

      routingEngine = new RoutingEngine(database, config);
      routingEngine.setTidesClient(new TidesClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase));
      routingEngine.setCurrentsClient(new CurrentsClient(config.tidesApiBase || DEFAULT_CONFIG.tidesApiBase));
      apiHandler!.setComponents(database, routingEngine);
      console.log('[routeiq] API handler ready');

      // Fetch initial vessel dimensions synchronously (subscription may not fire for static values)
      await fetchInitialVesselDimensions(app);

      // Subscribe to future vessel dimension changes
      await subscribeToVesselDimensions(app);
      console.log('[routeiq] Plugin started successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
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
      const appAny = app as any;
      let draft: number | undefined;
      let beam: number | undefined;
      let airDraft: number | undefined;

      // Try getSelfPath (preferred)
      if (typeof appAny.getSelfPath === 'function') {
        const draftPath = appAny.getSelfPath('design.draft');
        draft = extractNumberValue(draftPath);
        const beamPath = appAny.getSelfPath('design.beam');
        beam = extractNumberValue(beamPath);
        const airDraftPath = appAny.getSelfPath('design.airHeight');
        airDraft = extractNumberValue(airDraftPath);
      } else if (typeof appAny.getPath === 'function') {
        // Fallback: full path
        const draftPath = appAny.getPath('vessels.self.design.draft');
        draft = extractNumberValue(draftPath);
        const beamPath = appAny.getPath('vessels.self.design.beam');
        beam = extractNumberValue(beamPath);
        const airDraftPath = appAny.getPath('vessels.self.design.airHeight');
        airDraft = extractNumberValue(airDraftPath);
      }

      if (draft !== undefined || beam !== undefined || airDraft !== undefined) {
        const newDimensions: Partial<typeof vesselDimensions> = {};
        if (draft !== undefined) newDimensions.draft = draft;
        if (beam !== undefined) newDimensions.beam = beam;
        if (airDraft !== undefined) newDimensions.airDraft = airDraft;
        vesselDimensions = { ...vesselDimensions, ...newDimensions };
        routingEngine!.setVesselDimensions(vesselDimensions);
        console.log(`[routeiq] Vessel dimensions (from path API): ${JSON.stringify(vesselDimensions)}`);
      }
    } catch (error) {
      console.warn('[routeiq] Failed to fetch initial vessel dimensions:', error);
    }
  }

  /**
   * Extract a numeric value from a Signal K path value (handles nested formats)
   */
  function extractNumberValue(v: any): number | undefined {
    if (v === undefined || v === null) return undefined;
    if (typeof v === 'number') return v;
    if (typeof v.value === 'number') return v.value;
    if (v.value && typeof v.value.maximum === 'number') return v.value.maximum;
    if (typeof v.maximum === 'number') return v.maximum;
    if (typeof v.current === 'number') return v.current;
    return undefined;
  }

  /**
   * Subscribe to vessel dimensions from Signal K delta tree
   */
  async function subscribeToVesselDimensions(app: ServerAPI) {
    try {
      const appAny = app as any;
      if (typeof appAny.subscriptionmanager?.subscribe === 'function') {
        const command = {
          context: 'vessels.self',
          subscribe: [
            { path: 'design.draft', period: 1000, format: 'delta' },
            { path: 'design.beam', period: 1000, format: 'delta' },
            { path: 'design.airHeight', period: 1000, format: 'delta' },
          ],
        };
        const unsubscribeFns: (() => void)[] = [];
        appAny.subscriptionmanager.subscribe(
          command,
          unsubscribeFns,     // collect unsubscribe callbacks
          () => {},           // errorCallback
          (update: any) => {  // callback
            handleVesselUpdate(update);
          },
        );
        subscriptionCancelled = () => {
          unsubscribeFns.forEach(fn => fn());
        };
      } else if (typeof appAny.subscribe === 'function') {
        // fallback: older API
        const subscription = { context: 'vessels.self', subscribe: [
          { path: 'design.draft' },
          { path: 'design.beam' },
          { path: 'design.airHeight' },
        ]};
        subscriptionCancelled = appAny.subscribe(subscription, (update: any) => {
          handleVesselUpdate(update);
        });
      }
    } catch (error) {
      console.warn('[routeiq] Failed to subscribe to vessel dimensions:', error);
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
        const p = entry.path || '';
        const value = entry.value;
        const numValue = typeof value === 'number' ? value 
          : typeof value?.value === 'number' ? value.value
          : value?.value?.maximum ?? value?.maximum ?? value?.current ?? value;
        if (typeof numValue === 'number') {
          if (p === 'design.draft' || p === 'design.draft.value') newDimensions.draft = numValue;
          if (p === 'design.beam' || p === 'design.beam.value') newDimensions.beam = numValue;
          if (p === 'design.airHeight' || p === 'design.airHeight.value') newDimensions.airDraft = numValue;
        }
      }
    }

    // Also try full-tree format (from app.getPath or similar)
    if (delta.vessels) {
      const vessels = delta.vessels || {};
      for (const vessel of Object.values(vessels) as any[]) {
        const design = vessel.design || {};
        if (design.draft !== undefined && typeof design.draft !== 'string') {
          const extracted = extractNumberValue(design.draft);
          if (extracted !== undefined) newDimensions.draft = extracted;
        }
        if (design.beam !== undefined && typeof design.beam !== 'string') {
          const extracted = extractNumberValue(design.beam);
          if (extracted !== undefined) newDimensions.beam = extracted;
        }
        if (design.airHeight !== undefined && typeof design.airHeight !== 'string') {
          const extracted = extractNumberValue(design.airHeight);
          if (extracted !== undefined) newDimensions.airDraft = extracted;
        }
      }
    }

    // Update vessel dimensions if we got any values
    if (Object.keys(newDimensions).length > 0) {
      vesselDimensions = { ...vesselDimensions, ...newDimensions };
      routingEngine.setVesselDimensions(vesselDimensions);
      console.log(`[routeiq] Vessel dimensions updated: ${JSON.stringify(vesselDimensions)}`);
    }
  }
}

// Default export for Signal K server's ESM loader (returns module.default)
export { pluginConstructor as default };
