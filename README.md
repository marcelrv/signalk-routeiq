<!-- Markdown, not an <img> tag: the App Store's README renderer does not allow
     inline HTML and printed the tag as literal text. Absolute raw URL for the
     same reason the screenshots below use one — a relative path does not
     resolve on npmjs.com. -->

![RouteIQ icon](https://raw.githubusercontent.com/marcelrv/signalk-routeiq/main/public/icon.svg)

# SignalK RouteIQ Nautical Route Planner

> ⚠️ **Alpha release.** RouteIQ is under active development. Routing data currently only
> covers a small set of test regions (parts of the Netherlands and the US East Coast) —
> it is **not yet suitable for real-world passage planning**. Use it for testing and
> feedback only, always verify routes against official charts, and do not rely on it
> for actual navigation.

An offline-first, vessel-aware nautical route planner designed to run natively as a webapp and plugin within the Signal K ecosystem. Optimized for inland waterways and coastal navigation, it dynamically calculates safe routes based on a vessel's physical dimensions (draft, beam, air draft) and user safety preferences.

![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D22.5.0-brightgreen.svg)

## Features

- **Offline-First Routing**: Pre-computed routing graph enables instant route calculation without internet connectivity
- **Vessel-Aware**: Considers draft, beam, and air draft (with configurable safety margins) to ensure safe navigation
- **Tide-Aware (optional)**: Can factor in tidal currents — needs a tide data plugin installed and running: [`signalk-tidal-currents`](https://github.com/marcelrv/signalk-tidal-currents) for real harmonic current stations (preferred), and/or [`signalk-tides`](https://github.com/openwatersio/signalk-tides) for a height-derived estimate. Without either, routes fall back to plain distance
- **Interactive Web UI**: Leaflet-based map interface with click-and-drag route planning
- **Freeboard-SK Integration**: Runs as a [Freeboard-SK](https://github.com/SignalK/freeboard-sk) Plotter Extension panel, so you can plan routes without leaving Freeboard-SK's own charting UI
- **GPX Export**: Export routes for use in OpenCPN, WilhelmSK, and other navigation software
- **POI Search**: Offline search for ports, marinas, locks, and other points of interest
- **Chart Selection**: Nautical charts via Signal K's `resources/charts` API (raster and S-57 vector), plus built-in OpenStreetMap / OpenSeaMap
- **Downloadable Routing Data**: Fetch pre-compiled regional routing databases on demand from within the app — no manual data prep required

## Screenshots

<!-- Absolute raw URLs, not relative paths, so these also render on npmjs.com. -->

| | |
|---|---|
| ![Route planning in the RouteIQ web app](https://raw.githubusercontent.com/marcelrv/signalk-routeiq/main/img/webapp-route.jpg)<br>Planning a route through the Zeeland delta | ![RouteIQ panel inside Freeboard-SK](https://raw.githubusercontent.com/marcelrv/signalk-routeiq/main/img/freeboard-plugin.jpg)<br>Running as a Freeboard-SK plotter extension |
| ![Tide-aware planning with a departure scan](https://raw.githubusercontent.com/marcelrv/signalk-routeiq/main/img/freeboard-tides.jpg)<br>Tide-aware routing with a 24 h departure scan | ![Routing Data Manager](https://raw.githubusercontent.com/marcelrv/signalk-routeiq/main/img/download-manager.jpg)<br>Downloading and managing regional routing data |
| ![The departure planner filling in as it scans](https://raw.githubusercontent.com/marcelrv/signalk-routeiq/main/img/webapp-departures.jpg)<br>The departure planner mid-scan — every hour of the window is listed at once and fills in coarse to fine, so the best departure shows up long before the scan ends | |

## How It Works

RouteIQ is made up of three pieces:

1. **A cloud data pipeline** (separate repo, [signalk-router-pipeline](https://github.com/marcelrv/signalk-router-pipeline)) that processes nautical charts into compiled routing databases.
2. **This Signal K plugin**, which runs on your Signal K server, loads one or more of those databases, and calculates routes.
3. **A web app**, served by the plugin, for planning routes on a chart and exporting them.

Compiled routing databases are published to [signalk-router-data](https://github.com/marcelrv/signalk-router-data) and can be downloaded directly from the plugin's "Manage Routing Data" screen — you don't need to run the pipeline yourself.

RouteIQ can be used two ways: as its own standalone web app (served by the plugin), or embedded directly inside [Freeboard-SK](https://github.com/SignalK/freeboard-sk) as a Plotter Extension panel, so you can plan routes on top of the chart you're already viewing there.

## Installation

1. Install **RouteIQ** from the Signal K App Store (Server → Appstore, in your Signal K server's admin UI), or manually by placing this plugin in your Signal K server's `node_modules`.
2. Restart your Signal K server and enable the plugin under Server → Plugin Config.
3. Open the RouteIQ web app (linked from the Signal K webapps list), or open it as a panel inside Freeboard-SK if you use that.
4. Click the ☰ menu icon in the top-right corner of the screen to open the Routing / Charts / View settings, and use **Manage Routing Data** there to download a routing database for your area.
5. Set your vessel dimensions (or let RouteIQ auto-detect them from `design.draft` etc. if your Signal K server provides them) and start planning routes.

Want tide-aware routing? Install and enable a tide data plugin first — [`signalk-tidal-currents`](https://github.com/marcelrv/signalk-tidal-currents) for real harmonic current stations, and/or [`signalk-tides`](https://github.com/openwatersio/signalk-tides) for a height-derived estimate — then turn on "Consider Tides" in RouteIQ's settings (☰ menu → Routing) or per request. When both are available RouteIQ prefers the current stations and falls back to the height estimate outside their range.

## Configuration

These settings are available under Server → Plugin Config → RouteIQ:

| Setting | Default | Description |
|---|---|---|
| Routing Data Directory | the plugin's data directory | Directory containing the `.sqlite` routing graph files RouteIQ loads. Empty means `<Signal K config>/plugin-config-data/signalk-routeiq/routing-data`, which survives plugin updates; a relative path is resolved against the plugin install directory |
| Draft Safety Margin (m) | 0.3 | Under-keel clearance added to the vessel's design draft |
| Air Draft Safety Margin (m) | 1.5 | Mast clearance added to the vessel's design air draft |
| Beam Safety Margin (m) | 2.0 | Width clearance added to the vessel's design beam |
| Default Min Coast Distance (NM) | 0.5 | Default minimum distance to keep from the coastline |
| Average Speed (kn) | 6.0 | Cruising speed used to estimate route duration / ETA |
| Consider Tides by Default | off | Factor in tidal currents when calculating routes (needs `signalk-tidal-currents` and/or `signalk-tides`); can be overridden per request |
| Max Tidal Current (kn) | 2.0 | Spring-tide current at full flood/ebb, used to scale the estimated tidal flow model |
| Tides API Base URL | this server | Server hosting the tide/current data plugins, if not this one |
| Waypoint Simplification Tolerance (m) | 30 | Max deviation allowed when simplifying the computed path down to route waypoints |
| Wrong Way Penalty | 5.0 | Cost penalty applied when routing against marked traffic flow |
| Line-of-Sight Sample Interval (m) | 500 | Spacing between samples when checking line-of-sight for route smoothing |
| Line-of-Sight Search Radius (m) | 0 | Radius to search for graph nodes when verifying line-of-sight |
| Database Catalog URL | signalk-router-data catalog | Where to look for downloadable routing databases |
| Dynamic Database Loading | on | Load each region into memory only when a route actually needs it, instead of loading everything at startup. Recommended when you have multiple regional databases installed |
| Eager-load Region at Vessel Position | on | With dynamic loading on, pre-load the region under the vessel so it's ready to route as soon as it's positioned |
| Proactive Load Radius (NM) | 0 | Load a region before the vessel actually enters it, once within this distance |
| Max Loaded Regions | 6 | Cap on how many regions stay loaded in memory at once when using dynamic loading |

## Safety Constraints & Routing

Routes avoid edges where:
- Water depth is insufficient for the vessel's draft (plus safety margin)
- Vertical clearance is insufficient for the vessel's air draft (plus safety margin)
- Channel width is insufficient for the vessel's beam (plus safety margin)
- Distance to land is below the configured minimum coast distance

Routing prefers marked fairways over open water and penalizes travel against marked traffic flow.

## License

Apache License 2.0 - see LICENSE file for details

## Contributing

This is an alpha-stage project. Bug reports and feedback are very welcome — please open an issue or pull request on GitHub.

## Acknowledgments

- Signal K team for the plugin framework
- Dutch Hydrographic Office and Rijkswaterstaat for reference data
- OpenStreetMap and OpenSeaMap contributors for map tiles
- [Freeboard-SK](https://github.com/SignalK/freeboard-sk) (Apache-2.0) — the webapp's chart-source handling (Signal K `resources/charts` normalisation, built-in OSM/OpenSeaMap sources) and its simplified S-52 chart styling are adapted from Freeboard-SK, which in turn derives its S-52 symbology rules from [OpenCPN](https://github.com/OpenCPN/OpenCPN)'s s52plib
