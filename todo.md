Here is a comprehensive code review of the SignalK Autoroute plugin codebase. The review is broken down into two parts: the **Top 10 Technical Issues** to fix, and the **Top 10 Suggestions for UI/UX & Smarter Routing**. 

Each item includes a clear description and a ready-to-use prompt you can feed into your AI agent (like GitHub Copilot, Cursor, or Claude) to implement the change.

---

### Part 1: Top 10 Most Important Technical Issues to Fix

#### 1. Node.js Event Loop Blocking (`node:sqlite`)
**Description**: The backend uses `node:sqlite`'s `DatabaseSync`. While the wrapper methods (e.g., `getNodesInBBox`) are marked `async`, the underlying database calls (like `.all()`) execute synchronously. When querying large bounding boxes or loading a 150k+ node graph, this completely freezes the Node.js main thread, causing the SignalK server to drop NMEA sensor data and become unresponsive.
**AI Prompt**:
> "Refactor `src/database.ts` to prevent blocking the Node.js event loop. Replace the synchronous `node:sqlite` calls with an asynchronous SQLite driver (like `sqlite3` or `better-sqlite3` with `worker_threads`). Ensure that `loadGraph()`, `getNodesInBBox()`, and other heavy queries yield to the event loop so the main SignalK server is not blocked."

#### 2. A* Heuristic Admissibility Violation
**Description**: For A* to guarantee the shortest path, the heuristic $h$ must never overestimate the actual cost. Currently, `h` is the raw distance. However, `calculateEdgeCost()` multiplies distance by `fairwayMultiplier` (default `0.8`). This means actual cost ($0.8 \times d$) is less than heuristic cost ($1.0 \times d$). This makes the A* algorithm inadmissible, leading to sub-optimal, zig-zagging routes.
**AI Prompt**:
> "In `src/routing.ts`, update the A* algorithm's heuristic calculation `haversineDistance(...)` to multiply the resulting distance by the lowest possible cost multiplier (e.g., `Math.min(this.config.fairwayMultiplier, 1.0)`). This ensures the heuristic never overestimates the actual edge cost, restoring A* admissibility and optimal pathing."

#### 3. Missing Spatial Indices in SQLite
**Description**: In `nautical_routing_pipeline.py`, you create indices for `source` and `target` edges. However, the Node.js backend frequently queries nodes by bounding box (`WHERE lat BETWEEN ? AND ? AND lon BETWEEN ? AND ?`). Without an index on `lat` and `lon`, SQLite performs a full table scan on 100k+ rows for every map pan/zoom.
**AI Prompt**:
> "In `backend/nautical_routing_pipeline.py`, update the `export_to_sqlite` function to include a composite index for node coordinates. Add the SQL statement: `CREATE INDEX idx_nodes_lat_lon ON nodes(lat, lon);`. Then, update `src/database.ts` to ensure `getNodesInBBox` takes advantage of this index."

#### 4. SQL Statement Limit Risk in `findNearestNodeInSet`
**Description**: In `src/database.ts`, `findNearestNodeInSet` converts a `Set` into a comma-separated string and injects it directly into an `IN (${placeholders})` clause. If the disconnected graph component has thousands of nodes, this creates a massively long query string that can exceed SQLite's max SQL length or max variables limit, crashing the query.
**AI Prompt**:
> "In `src/database.ts`, rewrite `findNearestNodeInSet`. Instead of injecting thousands of IDs into an `IN (...)` clause, utilize a temporary SQLite table, or iterate over the nodes in memory using the pre-loaded `this.nodes` map (similar to the fast path in `findNearestNode`), which is vastly faster and avoids SQL string limit errors."

#### 5. BBox Routing Edge Case Exception
**Description**: In `src/routing.ts` (`astarSearch`), there is a strict check: `if (!isInsideBBox(startCoords.lat, startCoords.lon, bbox)) throw Error`. Because `startNode` is the *nearest snapped graph node*, it might fall slightly outside the strict bounding box created around the user's click coordinate, instantly failing the route calculation.
**AI Prompt**:
> "In `src/routing.ts`, fix the bounding box initialisation in `astarSearch`. The bounding box should be dynamically expanded to explicitly encompass both the exact user click coordinates AND the snapped `startNode` and `endNode` coordinates, ensuring the snapped nodes are never accidentally outside the `bbox`."

#### 6. Memory Leak on Plugin Restart
**Description**: In `src/index.ts`, `stop()` sets `database = null`, but inside `src/database.ts`, the `close()` method does not clear `this.nodes`, `this.edgesBySource`, or `this.spatialGrid`. Since the graph is huge (~100MB+ in memory), restarting the plugin via the SignalK admin UI multiple times can cause V8 memory leaks if event listeners or old objects retain references.
**AI Prompt**:
> "In `src/database.ts`, update the `close()` method to explicitly clear all large in-memory data structures. Add `this.nodes.clear()`, `this.edgesBySource.clear()`, and `this.spatialGrid.clear()`. Also, clear the cached `waterGeoJson` and `landBBoxIndex` arrays to ensure memory is properly garbage collected on plugin stop."

#### 7. Invalid GPX Export Extensions
**Description**: In `src/gpx-export.ts`, custom elements like `<minDepth>` are injected directly inside `<extensions>`. According to the GPX 1.1 schema, custom extensions must belong to a defined XML namespace. Standard GPX parsers (like OpenCPN or Garmin) may reject the file as malformed XML.
**AI Prompt**:
> "In `src/gpx-export.ts`, fix the GPX XML generation. Add a custom namespace to the `<gpx>` tag (e.g., `xmlns:autoroute="http://signalk.org/autoroute"`). Then, prefix all elements inside the `<extensions>` block with that namespace (e.g., `<autoroute:minDepth>`)."

#### 8. Global Scope Bug in Python Multiprocessing
**Description**: In `backend/nautical_routing_pipeline.py`, the `_coarse_scan_worker` relies on a global `_COARSE_SCAN_GDF`. This works on Linux (which uses `fork`), but on Windows/macOS (which use `spawn`), global variables are not automatically shared with child processes, leading to crashes or massive memory duplication.
**AI Prompt**:
> "In `backend/nautical_routing_pipeline.py`, fix the multiprocessing context for `_coarse_scan_worker`. Ensure cross-platform compatibility by explicitly passing the required geometries to the worker, or use a shared memory architecture/manager, rather than relying on standard global variable inheritance which fails on 'spawn' multiprocessing contexts."

#### 9. Unhandled Promise Rejections in Express Routes
**Description**: In `src/api.ts`, errors inside the `handleRoute` try-catch block are handled, but if the internal `routingEngine.calculateRoute()` throws a completely unhandled exception (e.g., a memory error or deep undefined property), the Express request can hang.
**AI Prompt**:
> "In `src/api.ts`, review all Express endpoint handlers (like `handleRoute`, `handleExportGpx`). Ensure all async calls are properly wrapped in standard error handlers. Pass any unhandled `next(error)` to Express's default error middleware so that API requests do not hang indefinitely if an unexpected exception occurs."

#### 10. Desync in Leaflet Waypoint UI State
**Description**: In `public/index.html`, right-clicking the map toggles `state.waypointNext` between 'start' and 'dest'. If a user wants to set via-points, dragging existing points triggers `applyWaypoints()`, but the associated textual `state.startPoiName` doesn't reset or recalculate properly, resulting in UI text showing the old POI name while the marker is somewhere else.
**AI Prompt**:
> "In `public/index.html`, fix the Leaflet waypoint state management. When a user drags the `startMarker` or `destMarker`, automatically trigger `lookupNearestPoi()` for the new coordinates and update `state.startPoiName` / `state.destPoiName`. Also, provide a visual ghost line while dragging to improve UX."

---

### Part 2: Top 10 Suggestions for UI/UX & Smarter Routing

#### 1. Elevation/Depth Route Profile Graph
**Description**: When viewing a route, users want to visually understand where the shallow spots or low bridges are. A 2D profile graph charting Depth and Air Draft over Distance makes it instantly clear where the bottlenecks are.
**AI Prompt**:
> "In `public/index.html`, implement a route profile graph below the map using Chart.js or D3. When a route is calculated, plot the `minDepth` and `maxAirDraft` of the segments along the X-axis (cumulative distance). Add visual threshold lines for the current vessel's draft and air draft."

#### 2. Tidal Adjustments for Draft
**Description**: Signal K has access to live and forecasted tide data. A route that is currently "too shallow" might be perfectly safe in 3 hours. 
**AI Prompt**:
> "Create a feature in `src/routing.ts` to accept an 'estimated departure time' and average speed. Look up Signal K tidal height data along the route. Adjust the `min_depth` of coastal/estuary edges by adding the estimated tidal height at the time the vessel is expected to reach that specific segment."

#### 3. Dynamic Isochrones (Reachability Polygons)
**Description**: Instead of just routing point-to-point, show the user a polygon representing everywhere they can travel within 1, 2, or 4 hours based on their vessel speed and graph constraints.
**AI Prompt**:
> "Implement an Isochrone generation API in `src/routing.ts`. Use Dijkstra's algorithm originating from the vessel's location, expanding outward up to a specific time limit (cost). Return the boundary nodes as a GeoJSON Polygon. Display this layer in `public/index.html` to show reachability."

#### 4. Custom Avoidance Zones (No-Go Areas)
**Description**: Users might want to avoid specific areas due to temporary military exercises, regattas, or rough weather.
**AI Prompt**:
> "Add a feature to the web UI allowing users to draw GeoJSON polygons representing 'No-Go Zones'. Pass these polygons in the POST request to `/route`. In `src/routing.ts`, check if an edge intersects any No-Go Zone and apply a massive penalty (or remove it from the available A* nodes)."

#### 5. Turn-by-Turn Marine Instructions
**Description**: The current implementation just says "Start" and "Destination". It should provide actual marine instructions based on edge angles and fairway transitions.
**AI Prompt**:
> "Enhance `makeSimpleInstructions` in `public/index.html`. Iterate over the route nodes and calculate bearing changes. If the angle changes by more than 30 degrees, output 'Turn [Port/Starboard] heading [XXX°]'. If transitioning onto a fairway edge, output 'Enter fairway [POI Name if available]'."

#### 6. Energy / Fuel Consumption Estimation
**Description**: Electric vessels and motorboats need to know if they have enough range for a route.
**AI Prompt**:
> "Add 'fuel/battery capacity' and 'consumption rate per nautical mile' to the vessel settings in the UI. When displaying the route summary, calculate the estimated energy required. If it exceeds capacity, render a prominent warning in the `route-warnings` div."

#### 7. Marine Night Mode & High Contrast
**Description**: For a marine navigation app, blinding white panels at night are dangerous for night vision.
**AI Prompt**:
> "Implement a toggle for a true 'Night Mode' in `public/index.html`. Define CSS variables for deep reds and blacks (e.g., `#110000`, text `#ff5555`) to preserve night vision. Switch the Leaflet basemap to a dark or red-tinted tile layer when this mode is active."

#### 8. Bridge Opening Schedules & Wait Times
**Description**: A route taking 2 hours might actually take 5 hours if a bridge is closed. The router currently just knows if a bridge *can* open, not *when*.
**AI Prompt**:
> "Add a schedule metadata field to the Bridge POIs in the SQLite database. In the frontend, if a route passes through an 'opening' bridge, calculate the ETA to that bridge. If the ETA falls outside operating hours, add a specific `route-warning` indicating the required wait time."

#### 9. Undo/Redo Stack for Route Planning
**Description**: When users accidentally right-click and erase their carefully crafted 10-waypoint route, there is no way to get it back.
**AI Prompt**:
> "Implement an undo/redo stack in `public/index.html`. Whenever `applyWaypoints()` is called, push a deep copy of `state.startLatLng`, `state.destLatLng`, and `state.viaPoints` into a history array. Add Undo (Ctrl+Z) and Redo (Ctrl+Y) keyboard shortcuts and UI buttons to restore previous states."

#### 10. Weather Routing (Wind & Current Overlays)
**Description**: Nautical routing is heavily influenced by wind and water currents. Providing visual overlays helps users choose better via-points.
**AI Prompt**:
> "Integrate Leaflet-Velocity or a similar particle animation library into `public/index.html` to display GRIB data (wind/currents). Add an API endpoint to fetch the latest wind vectors from Signal K, and allow the user to toggle this weather overlay on the map while plotting routes."


### type ahead in POI
Better POI selection
#smaller search
#remove/simplify the config
#download UI for db files

#the segments (legs) vs the details in the leg seem to be very confusing for the UI.
We need to have this clarified. the frontend should be able to be dumb, so not too much logic in the frontend as other plugings much be able to use the endpoints and also provide the UI



supernodes architecture


Model 9:51 AM
ThinkingThoughts
Expand to view model thoughts

chevron_right
You have just identified one of the most complex challenges in modern constraint-based routing. You are 100% correct.
If the system only precalculates the absolute shortest path between Supernode A and Supernode B, a sailboat with a 2.0m draft will be completely trapped if that one precalculated macro-edge goes through a 1.0m deep shortcut.
The Solution: "Pareto-Optimal" Macro-Edges
Instead of storing one macro-edge between two Supernodes, the Python cloud pipeline must store a set of alternative macro-edges.
In graph theory, this is called finding the Pareto Front. The pipeline calculates and stores different variations of the path:
The Shortcut: 5 km long, Min Depth 1.0m, Max Air Draft 3.0m.
The Deep Channel: 8 km long, Min Depth 5.0m, Max Air Draft 3.0m.
The Mast-Up Route: 12 km long, Min Depth 5.0m, Max Air Draft 20.0m (no fixed bridges).
When the Signal K Node.js router runs, the A* algorithm looks at Supernode A and sees three macro-edges pointing to Supernode B.
If a small motorboat (draft 0.5m, air draft 2m) asks for a route, the router evaluates all three, sees they are all safe, and picks Edge 1 (the 5km shortcut).
If a sailboat (draft 1.8m, air draft 15m) asks for a route, the router evaluates all three. Edge 1 is too shallow. Edge 2 has a bridge that is too low. The router throws them out and seamlessly selects Edge 3.
How to implement this in the AI Prompts
We need to instruct the Python pipeline to find these alternative routes, and we need to ensure the Node.js backend knows how to filter them.
Phase 1: Python Precomputation (Cloud)
We will tell Python to use an algorithm (like Yen's k-shortest paths or bottleneck-removal) to find these alternative routes.
AI Prompt for Python:
"In backend/nautical_routing_pipeline.py, when generating the Hierarchical 'macro_edges' between Supernodes, we cannot just store the absolute shortest path. Different vessels have different dimensions, so a deep draft vessel cannot take a shallow shortcut.
Please update the Supernode macro-edge generation logic to store Pareto-optimal alternative paths.
Find the shortest path between Supernode A and B. Save it as a macro-edge.
Identify the bottleneck edge of that path (e.g., the edge with the lowest min_depth or max_air_draft).
Temporarily penalize or remove that bottleneck edge from the graph and run the shortest path algorithm again to find an alternative route (e.g., a longer route but with deeper water or higher clearance).
Repeat this until you have found the alternative paths (or up to a reasonable limit, like max 3 macro-edges between the same two supernodes).
Insert ALL of these alternative macro-edges into the macro_edges SQLite table. They will share the same source and target IDs, but have different distance, min_depth, max_air_draft, and path_json values."
Phase 2: Node.js Runtime (Signal K Plugin)
The Node.js logic barely has to change, we just need to ensure it evaluates all macro-edges between two nodes rather than just assuming there is only one.
AI Prompt for Node.js:
"In src/routing.ts and src/database.ts, the database now contains multiple alternative macro_edges between the same source and target Supernodes. These represent different physical routes (e.g., a shallow shortcut vs. a deep, longer channel).
Please update the astarSearch logic to handle this:
When expanding a Supernode, the algorithm must iterate over all available macro-edges to the target Supernodes.
For each macro-edge, strictly apply the dynamic vessel constraints (if edge.min_depth < vessel.draft + margin or edge.max_air_draft < vessel.airDraft + margin, discard that specific macro-edge).
Calculate the standard cost for the remaining valid macro-edges and push them to the A* Open Set.
Because A* naturally explores the lowest-cost path first, this will automatically result in the algorithm taking the fastest macro-edge that safely fits the specific vessel's dimensions."
Why this is the ultimate routing architecture
By doing this, you have effectively built the "Holy Grail" of marine routing.
The Python server does all the heavy lifting of figuring out the "shallow vs deep" topology of the Dutch waterways just once. The weak Raspberry Pi on the boat only does a few dozen calculations, instantly giving the perfect, vessel-specific route across the whole country.