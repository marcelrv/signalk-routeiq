/**
 * Freeboard-SK Plotter Extension provider
 *
 * Registers the plugin as a "plotterExtensions" resource provider and serves
 * the extension iframe assets. This is what makes the RouteIQ engine usable
 * from inside Freeboard-SK (or any host chartplotter that implements the
 * Plotter Extensions API v1): a toolbar button opens the RouteIQ panel,
 * which reshapes the route the user is editing via the host `routes`
 * capability. The host renders the chart — the extension has no map of its own.
 *
 * Spec: https://github.com/SignalK/freeboard-sk/blob/master/docs/api/plotter-extensions-api.md
 */

import { ServerAPI } from "@signalk/server-api";
import * as express from "express";
import * as fs from "fs";
import { createRequire } from "node:module";
import * as path from "path";

const PLUGIN_ID = "signalk-routeiq";

/** Base URL for extension iframe assets. Top-level (not /plugins/*) so that
 * read-only users can load them — /plugins is admin-gated by the server. */
export const ASSET_BASE = `/plotterext/${PLUGIN_ID}`;

// Module-level guard: start() runs again on every config save, but the
// Express mounts must only happen once. The resource provider registration
// is NOT guarded this way — signalk-server unregisters a plugin's resource
// providers on every stop() (see onStopHandlers in its plugin host), so
// registerResourceProvider must be called again on every start(), per the
// documented plugin contract. It's a cheap Map.set server-side, safe to repeat.
let assetsMounted = false;
// Presence in the plotterExtensions collection is the "enabled" signal for
// hosts, so an empty list is returned while the plugin is stopped.
let running = false;

export function setPlotterExtensionRunning(state: boolean): void {
  running = state;
}

function readPluginVersion(plugindir: string): string {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(plugindir, "package.json"), "utf8"),
    );
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

// Every chart action opens (never toggles) the panel; the panel reads the
// chosen target from its handshake or the action.invoked event.
const OPEN_PANEL = { type: "openPanel", panel: "routeiq-panel" } as const;

export function buildManifest(version: string) {
  return {
    name: "RouteIQ",
    description:
      "Offline vessel-aware auto-routing: reshape the route you are editing around land, shallows and bridges.",
    version,
    apiVersion: "1",
    // The panel drives the host's live route edit buffer; without these the
    // extension is pointless, so they are hard requirements.
    requires: ["panels.iframe", "buttons", "routes"],
    // Used when present, degraded gracefully when not. Unknown ids here are
    // ignored by a host, whereas an unknown id in `requires` would make the
    // extension incompatible — so every newer capability belongs here.
    optional: ["map", "units", "actions", "map.pick"],
    buttons: [
      {
        id: "open-routeiq",
        title: "RouteIQ",
        slot: "mapToolbar",
        icon: "alt_route",
        action: { type: "togglePanel", panel: "routeiq-panel" },
      },
    ],
    panels: [
      {
        id: "routeiq-panel",
        title: "RouteIQ",
        type: "iframe",
        url: `${ASSET_BASE}/panel.html`,
        // keepAlive: route selection, last result and the revert buffer
        // survive closing/reopening the drawer.
        lifecycle: "keepAlive",
      },
    ],
    // Chart context-menu / popover commands (capability `actions`). They only
    // hand the panel a point or a route handle; the routing itself is still
    // the server's POST /router/route. add-via and set-dest only make sense
    // while a planning session runs, so they start hidden and the panel
    // reveals them with actions.setVisibility.
    actions: [
      {
        id: "route-to",
        title: "Route here",
        icon: "alt_route",
        targets: [
          "position",
          "waypoint",
          "note",
          {
            kind: "chartFeature",
            match: [{ path: "class", op: "in", value: ["HRBFAC", "SMCFAC"] }],
          },
        ],
        action: OPEN_PANEL,
      },
      {
        id: "route-from",
        title: "Route from here",
        icon: "trip_origin",
        targets: ["position", "waypoint"],
        action: OPEN_PANEL,
      },
      {
        id: "add-via",
        title: "Add via here",
        icon: "add_location_alt",
        targets: ["position", "waypoint"],
        action: OPEN_PANEL,
        visible: false,
      },
      {
        id: "set-dest",
        title: "Set destination here",
        icon: "flag",
        targets: ["position", "waypoint", "note"],
        action: OPEN_PANEL,
        visible: false,
      },
      {
        id: "optimise",
        title: "Optimise route",
        icon: "auto_fix_high",
        targets: ["route"],
        action: OPEN_PANEL,
      },
      {
        id: "best-departure",
        title: "Best departure time",
        icon: "schedule",
        targets: ["route"],
        action: OPEN_PANEL,
      },
    ],
  };
}

/**
 * Register the plotterExtensions resource provider and mount the iframe
 * assets. Safe to call on every plugin start: the resource provider
 * registration is re-done every time (the server unregisters it on every
 * stop), while the Express asset mounts are only ever mounted once.
 */
export function registerPlotterExtension(
  app: ServerAPI,
  plugindir: string,
): void {
  const version = readPluginVersion(plugindir);

  try {
    app.registerResourceProvider({
      type: "plotterExtensions",
      methods: {
        listResources: async () =>
          running ? { [PLUGIN_ID]: buildManifest(version) } : {},
        getResource: async (id: string) => {
          if (!running || id !== PLUGIN_ID) {
            throw new Error(`No such plotterExtensions resource: ${id}`);
          }
          return buildManifest(version);
        },
        // The manifest is code, not user data.
        setResource: async () => {
          throw new Error(
            `${PLUGIN_ID} is a read-only plotterExtensions provider`,
          );
        },
        deleteResource: async () => {
          throw new Error(
            `${PLUGIN_ID} is a read-only plotterExtensions provider`,
          );
        },
      },
    });
    console.log("[routeiq] plotterExtensions manifest registered");
  } catch (error) {
    console.warn(
      `[routeiq] Failed to register plotterExtensions provider: ${error}`,
    );
  }

  if (!assetsMounted) {
    const appExpress = app as unknown as express.IRouter;

    // Extension iframe pages (panel.html, panel.js, …)
    const extAssetDir = path.join(plugindir, "plotterext");
    if (fs.existsSync(extAssetDir)) {
      appExpress.use(ASSET_BASE, express.static(extAssetDir));
      console.log(
        `[routeiq] Plotter extension assets served from: ${extAssetDir}`,
      );
    } else {
      console.warn(
        `[routeiq] Plotter extension asset dir missing: ${extAssetDir}`,
      );
    }

    // The signalk-plotterext-bus client library (ESM build), imported by the
    // panel as ./bus/extension.js. Resolved through require so npm hoisting
    // of the dependency does not break the path.
    try {
      const require = createRequire(import.meta.url);
      const busDist = path.dirname(
        require.resolve("signalk-plotterext-bus/extension"),
      );
      appExpress.use(`${ASSET_BASE}/bus`, express.static(busDist));
    } catch (error) {
      console.warn(
        `[routeiq] signalk-plotterext-bus not found, extension UI disabled: ${error}`,
      );
    }

    assetsMounted = true;
  }
}
