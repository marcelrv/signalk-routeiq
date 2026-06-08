/**
 * SignalK Autoroute Plugin - Main Entry Point
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
import { RoutingEngine } from './routing.js';
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
  let vesselDimensions = { draft: 0, beam: 0, airDraft: 0 };
  let subscriptionCancelled: (() => void) | null = null;

  const pluginId = 'signalk-autoroute';
  const __filename = new URL(import.meta.url).pathname;
  const __plugindir = path.dirname(path.dirname(__filename)); // dist/.. → plugin root

  return {
    id: pluginId,
    name: 'SignalK Nautical Autoroute',

    /**
     * Start the plugin
     */
    start(options: any, _restart?: () => void) {
      console.log('[autoroute] Starting SignalK Autoroute Plugin...');

      // Merge received configuration with defaults
      config = { ...DEFAULT_CONFIG, ...options };

      // Resolve database path relative to plugin directory
      if (config.routingDatabase && !path.isAbsolute(config.routingDatabase)) {
        config.routingDatabase = path.resolve(__plugindir, config.routingDatabase);
      }
      console.log(`[autoroute] Configuration loaded: ${JSON.stringify(config)}`);

      // Create ApiHandler once; Express routes are registered against it on first start.
      // On subsequent starts (config save), only the routing engine is recreated.
      if (!apiHandler) {
        apiHandler = new ApiHandler(config, app);
        console.log('[autoroute] API handler created (awaiting database init)');
      }

      // Re-initialize database/routing engine with (possibly updated) config
      initPluginAsync(app);
    },

    /**
     * Stop the plugin
     */
    async stop() {
      console.log('[autoroute] Stopping SignalK Autoroute Plugin...');

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

      console.log('[autoroute] Plugin stopped');
    },

    /**
     * Get plugin configuration schema
     */
    schema(_app: any) {
      return {
        type: 'object',
        properties: {
          routingDatabase: {
            type: 'string',
            title: 'Routing Database Path',
            description: 'Path to the routing_graph.sqlite database',
            default: DEFAULT_CONFIG.routingDatabase,
          },
          defaultDraft: {
            type: 'number',
            title: 'Default Draft (m)',
            description: 'Default vessel draft in meters',
            default: DEFAULT_CONFIG.defaultDraft,
            multipleOf: 0.1,
          },
          defaultBeam: {
            type: 'number',
            title: 'Default Beam (m)',
            description: 'Default vessel beam in meters',
            default: DEFAULT_CONFIG.defaultBeam,
            multipleOf: 0.1,
          },
          defaultAirDraft: {
            type: 'number',
            title: 'Default Air Draft (m)',
            description: 'Default vessel air draft in meters',
            default: DEFAULT_CONFIG.defaultAirDraft,
            multipleOf: 0.1,
          },
          defaultCoastDistance: {
            type: 'number',
            title: 'Default Min Coast Distance (NM)',
            description: 'Default minimum distance from coastline in nautical miles',
            default: DEFAULT_CONFIG.defaultCoastDistance,
          },
          fairwayMultiplier: {
            type: 'number',
            title: 'Fairway Multiplier',
            description: 'Cost multiplier for fairway edges (lower = preferred)',
            default: DEFAULT_CONFIG.fairwayMultiplier,
          },
          openWaterMultiplier: {
            type: 'number',
            title: 'Open Water Multiplier',
            description: 'Cost multiplier for open water edges (higher = less preferred)',
            default: DEFAULT_CONFIG.openWaterMultiplier,
          },
          wrongWayPenalty: {
            type: 'number',
            title: 'Wrong Way Penalty',
            description: 'Penalty multiplier for traveling against traffic flow',
            default: DEFAULT_CONFIG.wrongWayPenalty,
          },
          routingBBoxMargin: {
            type: 'number',
            title: 'Routing BBox Margin (degrees)',
            description: 'Initial search bounding-box margin around start/end (default 0.1 ≈ 11km)',
            default: DEFAULT_CONFIG.routingBBoxMargin,
          },
          routingBBoxMaxExtent: {
            type: 'number',
            title: 'Routing BBox Max Extent (degrees)',
            description: 'Maximum bounding-box size before falling back to full graph',
            default: DEFAULT_CONFIG.routingBBoxMaxExtent,
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
        console.log(`[autoroute] Frontend served from: ${publicPath}`);
      }

      // Always attach routes — apiHandler was created synchronously in start()
      // so it's guaranteed to exist here. If the DB isn't loaded yet, routes
      // will return 503 Service Unavailable.
      router.use('/router', apiHandler!.getRouter());
      console.log('[autoroute] API routes attached');

      console.log('[autoroute] Router registered, awaiting initialization...');
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
      database = new RoutingDatabase(config.routingDatabase);
      await database.init();
      await database.loadGraph();
      const stats = await database.getStats();
      console.log(`[autoroute] Database loaded: ${stats.nodes} nodes, ${stats.edges} edges, ${stats.pois} POIs`);

      routingEngine = new RoutingEngine(database, config);
      apiHandler!.setComponents(database, routingEngine);
      console.log('[autoroute] API handler ready');

      await subscribeToVesselDimensions(app);
      console.log('[autoroute] Plugin started successfully');
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error(`[autoroute] Failed to initialize: ${message}`);
    }
  }

  /**
   * Load configuration from Signal K app
   */
  async function loadConfig(app: ServerAPI): Promise<PluginConfig> {
    const loadedConfig = { ...DEFAULT_CONFIG };

    try {
      // Try to get config from app.settings or app.config
      const appAny = app as any;
      if (appAny.settings && appAny.settings['signalk-autoroute']) {
        const pluginSettings = appAny.settings['signalk-autoroute'];
        Object.keys(DEFAULT_CONFIG).forEach((key) => {
          if (pluginSettings[key] !== undefined) {
            (loadedConfig as any)[key] = pluginSettings[key];
          }
        });
      }
    } catch {
      console.warn('[autoroute] Failed to load config from Signal K, using defaults');
    }

    return loadedConfig;
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
            { path: 'design.airDraft', period: 1000, format: 'delta' },
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
          { path: 'design.airDraft' },
        ]};
        subscriptionCancelled = appAny.subscribe(subscription, (update: any) => {
          handleVesselUpdate(update);
        });
      }
    } catch (error) {
      console.warn('[autoroute] Failed to subscribe to vessel dimensions:', error);
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
        const numValue = typeof value === 'number' ? value : value?.value ?? value;
        if (p === 'design.draft' || p === 'design.draft.value') {
          newDimensions.draft = numValue;
        }
        if (p === 'design.beam' || p === 'design.beam.value') {
          newDimensions.beam = numValue;
        }
        if (p === 'design.airDraft' || p === 'design.airDraft.value') {
          newDimensions.airDraft = numValue;
        }
      }
    }

    // Also try full-tree format (from app.getPath or similar)
    if (delta.vessels) {
      const vessels = delta.vessels || {};
      for (const vessel of Object.values(vessels) as any[]) {
        const design = vessel.design || {};
        const extractValue = (v: any) => typeof v === 'number' ? v : v?.value ?? v;
        if (design.draft !== undefined) newDimensions.draft = extractValue(design.draft);
        if (design.beam !== undefined) newDimensions.beam = extractValue(design.beam);
        if (design.airDraft !== undefined) newDimensions.airDraft = extractValue(design.airDraft);
      }
    }

    // Update vessel dimensions if we got any values
    if (Object.keys(newDimensions).length > 0) {
      vesselDimensions = { ...vesselDimensions, ...newDimensions };
      routingEngine.setVesselDimensions(vesselDimensions);
      console.log(`[autoroute] Vessel dimensions updated: ${JSON.stringify(vesselDimensions)}`);
    }
  }
}

// Default export for Signal K server's ESM loader (returns module.default)
export { pluginConstructor as default };
