Vendored third-party frontend assets, bundled locally so the webapp works offline (no CDN dependency).

A boat has no internet. Anything fetched from a CDN at page load is a hard
dependency on connectivity: the request does not fail fast, it hangs, and the
planner sits on its loading overlay forever. Keep this directory complete —
`../index.html` must not reference an external host.

- `leaflet.css`, `leaflet.js`, `images/` — [Leaflet](https://leafletjs.com/) v1.9.4. BSD-2-Clause. The map itself. `leaflet.css` references `images/marker-icon.png`, `images/marker-icon-2x.png`, `images/marker-shadow.png`, `images/layers.png` and `images/layers-2x.png` relative to itself, so that subdirectory has to travel with it.
- `leaflet-routing-machine.css`, `leaflet-routing-machine.min.js`, `leaflet.routing.icons.png`, `routing-icon.png` — [Leaflet Routing Machine](https://github.com/perliedman/leaflet-routing-machine) v3.2.12, bundled build. ISC license. The two PNGs are referenced from the CSS. Routing goes through this plugin's own API, not the OSRM demo server whose URL is baked into the bundle as the library default. Take the `.min.js` rather than the `.js`: it is the same bundle 274 kB smaller, which is 274 kB of parsing that a plotter or a cheap tablet does not have to do.
- `leaflet.vectorgrid.min.js` — [Leaflet.VectorGrid](https://github.com/Leaflet/Leaflet.VectorGrid) v1.3.0, bundled build. Beerware license. Renders the S-57 vector chart tiles (see `../index.html`, "chart sources" section).

All of the above came from `https://unpkg.com/<package>@<version>/dist/<file>`;
re-vendor by re-downloading those URLs if a version needs to change, and update
the versions listed here at the same time. `https://unpkg.com/<package>@<version>/dist/?meta`
lists a published `integrity` hash per file — check a fresh download against it
rather than trusting the transfer. These files are marked `-text` in
`.gitattributes` so they stay byte-identical to upstream and keep verifying.

Note that the base map tiles (OpenStreetMap, OpenSeaMap) are still fetched over
the network — those cannot be vendored. Offline use relies on charts served by a
Signal K chart provider instead.
