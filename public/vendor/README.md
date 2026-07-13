Vendored third-party frontend assets, bundled locally so the webapp works offline (no CDN dependency).

- `leaflet.vectorgrid.min.js` — [Leaflet.VectorGrid](https://github.com/Leaflet/Leaflet.VectorGrid) v1.3.0, bundled build. Beerware license. Renders the S-57 vector chart tiles (see `../index.html`, "chart sources" section). Fetched from `https://unpkg.com/leaflet.vectorgrid@1.3.0/dist/Leaflet.VectorGrid.bundled.min.js`; re-vendor by re-downloading that URL if it needs an upgrade.
