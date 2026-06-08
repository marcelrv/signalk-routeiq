/**
 * API Route Handlers
 * Express middleware for all router API endpoints
 */

import { ServerAPI } from '@signalk/server-api';
import { Request, Response, Router } from 'express';
import { RoutingDatabase } from './database.js';
import { GpxExporter } from './gpx-export.js';
import { RoutingEngine } from './routing.js';
import { PluginConfig, RouteResult, RoutingRequest } from './types.js';

export class ApiHandler {
  private router: Router;
  private routingEngine: RoutingEngine | null;
  private db: RoutingDatabase | null;
  private config: PluginConfig;
  private app: ServerAPI;

  constructor(config: PluginConfig, app: ServerAPI) {
    this.routingEngine = null;
    this.db = null;
    this.config = config;
    this.app = app;
    this.router = Router();
    this.setupRoutes();
  }

  setComponents(db: RoutingDatabase, engine: RoutingEngine): void {
    this.db = db;
    this.routingEngine = engine;
    console.log('[autoroute] API handler components updated');
  }

  isReady(): boolean {
    return this.db !== null && this.routingEngine !== null;
  }

  getRouter(): Router {
    return this.router;
  }

  private setupRoutes(): void {
    // CORS headers for sandbox cross-origin requests
    this.router.use((_req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      if (_req.method === 'OPTIONS') { res.sendStatus(204); return; }
      next();
    });

    // POST /signalk/v1/api/router/route
    this.router.post('/route', this.handleRoute.bind(this));

    // GET /signalk/v1/api/router/search
    this.router.get('/search', this.handleSearch.bind(this));

    // POST /signalk/v1/api/router/export/gpx
    this.router.post('/export/gpx', this.handleExportGpx.bind(this));

    // POST /signalk/v1/api/router/push
    this.router.post('/push', this.handlePushRoute.bind(this));

    // GET /signalk/v1/api/router/stats
    this.router.get('/stats', this.handleStats.bind(this));

    // GET /signalk/v1/api/router/vessel
    this.router.get('/vessel', this.handleGetVessel.bind(this));

    // PUT /signalk/v1/api/router/vessel
    this.router.put('/vessel', this.handleUpdateVessel.bind(this));

    // GET /signalk/v1/api/router/graph/nodes?bbox=minLon,minLat,maxLon,maxLat
    this.router.get('/graph/nodes', this.handleGraphNodes.bind(this));

    // GET /signalk/v1/api/router/pois?bbox=minLon,minLat,maxLon,maxLat
    this.router.get('/pois', this.handlePois.bind(this));

    // GET /signalk/v1/api/router/water?bbox=minLon,minLat,maxLon,maxLat
    this.router.get('/water', this.handleWater.bind(this));

    // GET /signalk/v1/api/router/waterways?bbox=minLon,minLat,maxLon,maxLat
    this.router.get('/waterways', this.handleWaterways.bind(this));
  }

  /**
   * Handle route calculation request
   * POST /signalk/v1/api/router/route
   */
  private async handleRoute(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Routing engine not ready, still initializing' });
      return;
    }
    try {
      const request: RoutingRequest = req.body;

      if (!request.start || !request.end) {
        res.status(400).json({ error: 'Missing required fields: start and end coordinates' });
        return;
      }

      // Normalize leaflet {lat, lng} / {lat, lon} to {latitude, longitude}
      const norm = (p: any) => {
        if (typeof p.latitude !== 'number') p.latitude = p.lat;
        if (typeof p.longitude !== 'number') p.longitude = p.lng ?? p.lon;
      };
      norm(request.start);
      norm(request.end);

      if (
        typeof request.start.latitude !== 'number' ||
        typeof request.start.longitude !== 'number' ||
        typeof request.end.latitude !== 'number' ||
        typeof request.end.longitude !== 'number'
      ) {
        res.status(400).json({ error: 'Invalid coordinate format. Expected {latitude, longitude}' });
        return;
      }

      const route: RouteResult = await this.routingEngine!.calculateRoute(request);

      res.json(route);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(404).json({ error: message, code: 'ROUTE_NOT_FOUND' });
    }
  }

  /**
   * Handle POI search request
   * GET /signalk/v1/api/router/search?q=...
   */
  private async handleSearch(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Database not ready, still initializing' });
      return;
    }
    try {
      const query = req.query.q as string;
      const limit = parseInt(req.query.limit as string) || 20;

      if (!query || query.length < 2) {
        res.status(400).json({
          error: 'Search query parameter "q" is required (minimum 2 characters)',
        });
        return;
      }

      const results = await this.db!.searchPois(query, limit);
      res.json({ query, count: results.length, results });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle GPX export request
   * POST /signalk/v1/api/router/export/gpx
   */
  private async handleExportGpx(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Routing engine not ready, still initializing' });
      return;
    }
    try {
      const route: RouteResult = req.body.route;
      const name: string = req.body.name || 'Autoroute';

      if (!route) {
        res.status(400).json({ error: 'Missing route data in request body' });
        return;
      }

      const gpx = GpxExporter.toGpx(route, name);

      res.setHeader('Content-Type', 'application/gpx+xml');
      res.setHeader('Content-Disposition', `attachment; filename="${name.replace(/[^a-z0-9]/gi, '_')}.gpx"`);
      res.send(gpx);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle route push to Signal K resources
   * POST /signalk/v1/api/router/push
   */
  private async handlePushRoute(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Routing engine not ready, still initializing' });
      return;
    }
    try {
      const route: RouteResult = req.body.route;
      const name: string = req.body.name || 'Autoroute Route';

      if (!route) {
        res.status(400).json({ error: 'Missing route data in request body' });
        return;
      }

      // Convert to Signal K Route specification
      const skRoute = GpxExporter.toSignalKRoute(route, name);
      const routeId = skRoute.routeId || `autoroute-${Date.now()}`;
      const path = `vessels.self.resources.routes.${routeId}`;

      // Push route to Signal K resources via putSelfPath (callback-based API)
      const relPath = `resources.routes.${routeId}`;
      await new Promise<void>((resolve, reject) => {
        (this.app as any).putSelfPath(relPath, skRoute, (err: Error | null) => {
          if (err) reject(err);
          else resolve();
        });
      });

      res.json({
        success: true,
        message: 'Route pushed to Signal K resources',
        routeId,
        path,
      });
    } catch (error) {
      const err = error as any;
      const message = err instanceof Error ? err.message : `NonError: ${JSON.stringify(err)}`;
      console.error('[autoroute] Push route error:', error);
      res.status(500).json({ error: `Failed to push route: ${message}` });
    }
  }

  /**
   * Handle database stats request
   * GET /signalk/v1/api/router/stats
   */
  private async handleStats(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Database not ready, still initializing' });
      return;
    }
    try {
      const stats = await this.db!.getStats();
      res.json(stats);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle get vessel dimensions request
   * GET /signalk/v1/api/router/vessel
   */
  private async handleGetVessel(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Routing engine not ready, still initializing' });
      return;
    }
    try {
      const vessel = this.routingEngine!['vesselDimensions'];
      res.json(vessel);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle update vessel dimensions request
   * PUT /signalk/v1/api/router/vessel
   */
  private async handleUpdateVessel(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Routing engine not ready, still initializing' });
      return;
    }
    try {
      const dimensions = req.body;
      this.routingEngine!.setVesselDimensions(dimensions);
      res.json({ success: true, vessel: dimensions });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle graph nodes query
   * GET /signalk/v1/api/router/graph/nodes?bbox=minLon,minLat,maxLon,maxLat&limit=5000
   */
  private async handleGraphNodes(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Database not ready' });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      const limit = parseInt(req.query.limit as string) || 5000;
      if (!bbox) {
        res.status(400).json({ error: 'Missing bbox parameter (minLon,minLat,maxLon,maxLat)' });
        return;
      }
      const parts = bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({ error: 'Invalid bbox format, expected minLon,minLat,maxLon,maxLat' });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const nodes = await this.db!.getNodesInBBox(minLat, minLon, maxLat, maxLon, limit);
      res.json({ count: nodes.length, nodes });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[autoroute] graph/nodes error:', error);
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle POIs query
   * GET /signalk/v1/api/router/pois?bbox=minLon,minLat,maxLon,maxLat&limit=2000
   */
  private async handlePois(req: Request, res: Response): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Database not ready' });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      const limit = parseInt(req.query.limit as string) || 2000;
      if (!bbox) {
        res.status(400).json({ error: 'Missing bbox parameter (minLon,minLat,maxLon,maxLat)' });
        return;
      }
      const parts = bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({ error: 'Invalid bbox format, expected minLon,minLat,maxLon,maxLat' });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const pois = await this.db!.getPoisInBBox(minLat, minLon, maxLat, maxLon, limit);
      res.json({ count: pois.length, pois });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle water polygon query
   * GET /signalk/v1/api/router/water?bbox=minLon,minLat,maxLon,maxLat
   */
  private async handleWater(req: Request, res: Response): Promise<void> {
    if (!this.db) {
      res.status(503).json({ error: 'Database not ready' });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      if (!bbox) {
        res.status(400).json({ error: 'Missing bbox parameter (minLon,minLat,maxLon,maxLat)' });
        return;
      }
      const parts = bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({ error: 'Invalid bbox format, expected minLon,minLat,maxLon,maxLat' });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const features = await this.db!.getWaterPolygons(minLat, minLon, maxLat, maxLon);
      res.json({ type: 'FeatureCollection', features });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[autoroute] water error:', error);
      res.status(500).json({ error: message });
    }
  }

  /**
   * Handle waterway line query
   * GET /signalk/v1/api/router/waterways?bbox=minLon,minLat,maxLon,maxLat
   */
  private async handleWaterways(req: Request, res: Response): Promise<void> {
    if (!this.db) {
      res.status(503).json({ error: 'Database not ready' });
      return;
    }
    try {
      const bbox = req.query.bbox as string;
      if (!bbox) {
        res.status(400).json({ error: 'Missing bbox parameter (minLon,minLat,maxLon,maxLat)' });
        return;
      }
      const parts = bbox.split(',').map(Number);
      if (parts.length !== 4 || parts.some(isNaN)) {
        res.status(400).json({ error: 'Invalid bbox format, expected minLon,minLat,maxLon,maxLat' });
        return;
      }
      const [minLon, minLat, maxLon, maxLat] = parts;
      const features = await this.db!.getWaterways(minLat, minLon, maxLat, maxLon);
      res.json({ type: 'FeatureCollection', features });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[autoroute] waterways error:', error);
      res.status(500).json({ error: message });
    }
  }
}
