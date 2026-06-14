/**
 * API Route Handlers
 * Express middleware for all router API endpoints
 */

import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'node:zlib';
import { ServerAPI } from '@signalk/server-api';
import { NextFunction, Request, Response, Router } from 'express';
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

    // GET /signalk/v1/api/router/poi/nearest?lat=X&lon=Y&radius=250
    this.router.get('/poi/nearest', this.handleNearestPoi.bind(this));

    // GET /signalk/v1/api/router/water?bbox=minLon,minLat,maxLon,maxLat
    this.router.get('/water', this.handleWater.bind(this));

    // GET /signalk/v1/api/router/waterways?bbox=minLon,minLat,maxLon,maxLat
    this.router.get('/waterways', this.handleWaterways.bind(this));

    // GET /signalk/v1/api/router/databases — list locally installed databases
    this.router.get('/databases', this.handleListDatabases.bind(this));

    // GET /signalk/v1/api/router/databases/available — fetch remote catalog
    this.router.get('/databases/available', this.handleAvailableDatabases.bind(this));

    // POST /signalk/v1/api/router/databases/download — download a database file
    this.router.post('/databases/download', this.handleDownloadDatabase.bind(this));
  }

  /**
   * Handle route calculation request
   * POST /signalk/v1/api/router/route
   */
  private async handleRoute(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      // Use 422 (Unprocessable Entity) so clients can distinguish a routing
      // failure (constraint/graph issue) from a server error (500).
      res.status(422).json({ error: message, code: 'ROUTE_NOT_FOUND' });
      next(error);
    }
  }

  /**
   * Handle POI search request
   * GET /signalk/v1/api/router/search?q=...
   */
  private async handleSearch(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Database not ready, still initializing' });
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
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle GPX export request
   * POST /signalk/v1/api/router/export/gpx
   */
  private async handleExportGpx(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      next(error);
    }
  }

  /**
   * Handle route push to Signal K resources
   * POST /signalk/v1/api/router/push
   */
  private async handlePushRoute(req: Request, res: Response, next: NextFunction): Promise<void> {
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

      // Generate a UUID and convert to v2 Route format
      const uuid = crypto.randomUUID();
      const skRoute = GpxExporter.toSignalKRoute(route, name, uuid);

      // Persist via the Resource API (goes through resources-provider plugin)
      await (this.app as any).resourcesApi.setResource('routes', uuid, skRoute);

      res.json({
        success: true,
        message: 'Route pushed to Signal K resources',
        routeId: uuid,
        path: `resources.routes.${uuid}`,
      });
    } catch (error) {
      const err = error as any;
      const message = err instanceof Error ? err.message : `NonError: ${JSON.stringify(err)}`;
      console.error('[autoroute] Push route error:', error);
      res.status(500).json({ error: `Failed to push route: ${message}` });
      next(error);
    }
  }

  /**
   * Handle database stats request
   * GET /signalk/v1/api/router/stats
   */
  private async handleStats(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      next(error);
    }
  }

  /**
   * Handle get vessel dimensions request
   * GET /signalk/v1/api/router/vessel
   */
  private async handleGetVessel(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.isReady()) {
      res.status(503).json({ error: 'Routing engine not ready, still initializing' });
      return;
    }
    try {
      const engine = this.routingEngine! as any;
      const vessel = engine.vesselDimensions as any;
      const cfg = engine.config as any;
      const effectiveDraft = Math.round(((vessel.draft || 2.0) + (cfg.safetyMarginDraft || 0.3)) * 10) / 10;
      const effectiveBeam = Math.round(((vessel.beam || 4.0) + (cfg.safetyMarginBeam || 2.0)) * 10) / 10;
      const effectiveAirDraft = Math.round(((vessel.airDraft || 10.0) + (cfg.safetyMarginAirDraft || 1.5)) * 10) / 10;
      res.json({ ...vessel, effectiveDraft, effectiveBeam, effectiveAirDraft });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle update vessel dimensions request
   * PUT /signalk/v1/api/router/vessel
   */
  private async handleUpdateVessel(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      next(error);
    }
  }

  /**
   * Handle graph nodes query
   * GET /signalk/v1/api/router/graph/nodes?bbox=minLon,minLat,maxLon,maxLat&limit=5000
   */
  private async handleGraphNodes(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      next(error);
    }
  }

  /**
   * Handle POIs query
   * GET /signalk/v1/api/router/pois?bbox=minLon,minLat,maxLon,maxLat&limit=2000
   */
  private async handlePois(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      next(error);
    }
  }

  /**
   * Handle nearest POI query
   * GET /signalk/v1/api/router/poi/nearest?lat=X&lon=Y&radius=250
   */
  private async handleNearestPoi(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.db) {
      res.status(503).json({ error: 'Database not ready' });
      return;
    }
    try {
      const lat = parseFloat(req.query.lat as string);
      const lon = parseFloat(req.query.lon as string);
      const radius = parseFloat(req.query.radius as string) || 250;
      if (isNaN(lat) || isNaN(lon)) {
        res.status(400).json({ error: 'Missing or invalid lat/lon parameters' });
        return;
      }
      const poi = await this.db!.getNearestPoi(lat, lon, radius);
      res.json({ poi });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle water polygon query
   * GET /signalk/v1/api/router/water?bbox=minLon,minLat,maxLon,maxLat
   */
  private async handleWater(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      next(error);
    }
  }

  /**
   * Handle waterway line query
   * GET /signalk/v1/api/router/waterways?bbox=minLon,minLat,maxLon,maxLat
   */
  private async handleWaterways(req: Request, res: Response, next: NextFunction): Promise<void> {
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
      next(error);
    }
  }

  /**
   * Handle list locally installed databases
   * GET /signalk/v1/api/router/databases
   */
  private async handleListDatabases(req: Request, res: Response, next: NextFunction): Promise<void> {
    if (!this.db) {
      res.status(503).json({ error: 'Database not ready' });
      return;
    }
    try {
      const info = await this.db.getDatabaseInfo();
      res.json({ databases: info });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      res.status(500).json({ error: message });
      next(error);
    }
  }

  /**
   * Handle fetch available databases from remote catalog
   * GET /signalk/v1/api/router/databases/available
   */
  private async handleAvailableDatabases(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const catalogUrl = this.config.catalogUrl;
      if (!catalogUrl) {
        res.status(400).json({ error: 'No catalog URL configured' });
        return;
      }
      const response = await fetch(catalogUrl, { signal: AbortSignal.timeout(15000) });
      if (!response.ok) {
        res.status(502).json({ error: `Catalog server returned ${response.status}` });
        return;
      }
      const catalog = await response.json() as any;
      // Derive the base URL from the catalog URL for constructing download links
      const catalogUrlStr = catalogUrl.toString();
      const baseUrl = catalogUrlStr.substring(0, catalogUrlStr.lastIndexOf('/') + 1);
      if (catalog.regions && Array.isArray(catalog.regions)) {
        for (const region of catalog.regions) {
          if (region.file) {
            region.downloadUrl = baseUrl + region.file;
          }
        }
      }
      res.json(catalog);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
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
  private async handleDownloadDatabase(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const { url, filename } = req.body;
      if (!url || !filename) {
        res.status(400).json({ error: 'Missing required fields: url, filename' });
        return;
      }

      const dataDir = this.config.routingDataDir;
      if (!dataDir) {
        res.status(400).json({ error: 'routingDataDir is not configured' });
        return;
      }

      // Ensure data directory exists
      try { fs.mkdirSync(dataDir, { recursive: true }); } catch { /* ignore */ }

      console.log(`[autoroute] Downloading database: ${url}`);
      const response = await fetch(url, { signal: AbortSignal.timeout(120000) });
      if (!response.ok) {
        res.status(502).json({ error: `Download failed: server returned ${response.status}` });
        return;
      }

      const buffer = Buffer.from(await response.arrayBuffer());

      // If the downloaded file is .sqlite.gz, decompress it
      let saveFilename = filename;
      let saveBuffer = buffer;
      if (filename.endsWith('.sqlite.gz')) {
        saveFilename = filename.slice(0, -3); // strip .gz
        saveBuffer = zlib.gunzipSync(buffer);
        console.log(`[autoroute] Decompressed ${filename} -> ${saveFilename} (${buffer.length} -> ${saveBuffer.length} bytes)`);
      }

      // Remove all old .sqlite files before writing the new one
      const oldFiles = fs.readdirSync(dataDir).filter(f => f.endsWith('.sqlite') && f !== saveFilename);
      for (const f of oldFiles) {
        try {
          fs.unlinkSync(path.join(dataDir, f));
          console.log(`[autoroute] Removed old database: ${f}`);
        } catch (e) {
          console.warn(`[autoroute] Failed to remove old database ${f}: ${e}`);
        }
      }

      const destPath = path.join(dataDir, saveFilename);
      fs.writeFileSync(destPath, saveBuffer);

      console.log(`[autoroute] Database saved: ${saveFilename} (${saveBuffer.length} bytes)`);

      // Refresh metadata cache so the new DB shows in the installed list
      try {
        await this.db!.reloadMetadata();
        console.log(`[autoroute] Metadata cache refreshed after download`);
      } catch (e) {
        console.warn(`[autoroute] Metadata refresh failed: ${e}`);
      }

      // Hot-reload the database and routing engine so the new DB is used immediately
      if (this.onReloadRequested) {
        try {
          await this.onReloadRequested(dataDir);
          console.log(`[autoroute] Routing engine hot-reloaded`);
        } catch (e) {
          console.error(`[autoroute] Hot-reload failed: ${e}`);
          res.status(500).json({ error: `Database saved but hot-reload failed: ${e}` });
          return;
        }
      }

      res.json({
        success: true,
        filename: saveFilename,
        sizeBytes: saveBuffer.length,
        message: `Downloaded and installed ${saveFilename} (${(saveBuffer.length / 1048576).toFixed(1)} MB)`,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      console.error('[autoroute] Database download error:', error);
      res.status(500).json({ error: `Download failed: ${message}` });
      next(error);
    }
  }
}
