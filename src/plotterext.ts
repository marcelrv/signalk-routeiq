/**
 * Freeboard-SK Plotter Extension provider
 *
 * Registers the plugin as a "plotterExtensions" resource provider and serves
 * the extension iframe assets. This is what makes the autoroute engine usable
 * from inside Freeboard-SK (or any host chartplotter that implements the
 * Plotter Extensions API v1): a toolbar button opens the Autoroute panel,
 * which reshapes the route the user is editing via the host `routes`
 * capability. The host renders the chart — the extension has no map of its own.
 *
 * Spec: https://github.com/SignalK/freeboard-sk/blob/master/docs/api/plotter-extensions-api.md
 */

import { ServerAPI } from '@signalk/server-api';
import * as express from 'express';
import * as fs from 'fs';
import { createRequire } from 'node:module';
import * as path from 'path';

const PLUGIN_ID = 'signalk-autoroute';

/** Base URL for extension iframe assets. Top-level (not /plugins/*) so that
 * read-only users can load them — /plugins is admin-gated by the server. */
export const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;

// Module-level guards: start() runs again on every config save, but Express
// mounts and the resource provider registration must only happen once.
let assetsMounted = false;
let providerRegistered = false;
// Presence in the plotterExtensions collection is the "enabled" signal for
// hosts, so an empty list is returned while the plugin is stopped.
let running = false;

export function setPlotterExtensionRunning(state: boolean): void {
  running = state;
}

function readPluginVersion(plugindir: string): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(plugindir, 'package.json'), 'utf8'));
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function buildManifest(version: string) {
  return {
    name: 'Autoroute',
    description:
      'Offline vessel-aware auto-routing: reshape the route you are editing around land, shallows and bridges.',
    version,
    apiVersion: '1',
    // The panel drives the host's live route edit buffer; without these the
    // extension is pointless, so they are hard requirements.
    requires: ['panels.iframe', 'buttons', 'routes'],
    // Used when present, degraded gracefully when not.
    optional: ['map', 'units'],
    buttons: [
      {
        id: 'open-autoroute',
        title: 'Autoroute',
        slot: 'mapToolbar',
        icon: 'alt_route',
        action: { type: 'togglePanel', panel: 'autoroute-panel' },
      },
    ],
    panels: [
      {
        id: 'autoroute-panel',
        title: 'Autoroute',
        type: 'iframe',
        url: `${ASSET_BASE}/panel.html`,
        // keepAlive: route selection, last result and the revert buffer
        // survive closing/reopening the drawer.
        lifecycle: 'keepAlive',
      },
    ],
  };
}

/**
 * Register the plotterExtensions resource provider and mount the iframe
 * assets. Safe to call on every plugin start.
 */
export function registerPlotterExtension(app: ServerAPI, plugindir: string): void {
  const version = readPluginVersion(plugindir);

  if (!providerRegistered) {
    try {
      app.registerResourceProvider({
        type: 'plotterExtensions',
        methods: {
          listResources: async () => (running ? { [PLUGIN_ID]: buildManifest(version) } : {}),
          getResource: async (id: string) => {
            if (!running || id !== PLUGIN_ID) {
              throw new Error(`No such plotterExtensions resource: ${id}`);
            }
            return buildManifest(version);
          },
          // The manifest is code, not user data.
          setResource: async () => {
            throw new Error(`${PLUGIN_ID} is a read-only plotterExtensions provider`);
          },
          deleteResource: async () => {
            throw new Error(`${PLUGIN_ID} is a read-only plotterExtensions provider`);
          },
        },
      });
      providerRegistered = true;
      console.log('[autoroute] plotterExtensions manifest registered');
    } catch (error) {
      console.warn(`[autoroute] Failed to register plotterExtensions provider: ${error}`);
    }
  }

  if (!assetsMounted) {
    const appExpress = app as unknown as express.IRouter;

    // Extension iframe pages (panel.html, panel.js, …)
    const extAssetDir = path.join(plugindir, 'plotterext');
    if (fs.existsSync(extAssetDir)) {
      appExpress.use(ASSET_BASE, express.static(extAssetDir));
      console.log(`[autoroute] Plotter extension assets served from: ${extAssetDir}`);
    } else {
      console.warn(`[autoroute] Plotter extension asset dir missing: ${extAssetDir}`);
    }

    // The signalk-plotterext-bus client library (ESM build), imported by the
    // panel as ./bus/extension.js. Resolved through require so npm hoisting
    // of the dependency does not break the path.
    try {
      const require = createRequire(import.meta.url);
      const busDist = path.dirname(require.resolve('signalk-plotterext-bus/extension'));
      appExpress.use(`${ASSET_BASE}/bus`, express.static(busDist));
    } catch (error) {
      console.warn(`[autoroute] signalk-plotterext-bus not found, extension UI disabled: ${error}`);
    }

    assetsMounted = true;
  }
}
