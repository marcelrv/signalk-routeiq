# SignalK Autoroute - Nautical Route Planner

An offline-first, vessel-aware nautical route planner designed to run natively as a webapp and plugin within the Signal K ecosystem. Optimized for inland waterways and coastal navigation, it dynamically calculates safe routes based on a vessel's physical dimensions (draft, beam, air draft) and user safety preferences.

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![Node](https://img.shields.io/badge/node-%3E%3D18.0.0-brightgreen.svg)
![TypeScript](https://img.shields.io/badge/typescript-%3E%3D5.0.0-blue.svg)

## Features

- **Offline-First Routing**: Pre-computed routing graph enables instant route calculation without internet connectivity
- **Vessel-Aware**: Considers draft, beam, and air draft to ensure safe navigation
- **Directed A\* Algorithm**: Multi-layered cost function with fairway preferences and traffic flow penalties
- **Signal K Integration**: Native plugin for Signal K servers with real-time vessel data
- **Interactive Web UI**: Leaflet-based map interface with click-and-drag route planning
- **GPX Export**: Export routes for use in OpenCPN, WilhelmSK, and other navigation software
- **POI Search**: Offline search for ports, marinas, locks, and other points of interest

## Architecture

The project consists of three main parts:

### Part 1: Cloud Graph Generator (Data Pipeline)
Python pipeline that processes S-57 ENCs and generates a navigable routing graph.

**Location**: `backend/`

**Technology**: Python, GDAL/OGR, NetworkX, SQLite, Shapely

**Process**:
1. Parse S-57 ENC vector data (depth areas, bridges, locks, fairways)
2. Generate directed graph topology (inland centerlines + adaptive-resolution coastal navmesh via quadtree)
3. Calculate edge attributes (depth, clearance, penalties)
4. Export to compressed SQLite database

**Key improvement:** The coastal navmesh uses adaptive quadtree subdivision (0.005° in open sea → 0.0002° in narrow channels) so routes follow channels precisely while keeping open-water nodes sparse.

### Part 2: Signal K Backend Plugin
Node.js plugin running on the vessel's Signal K server.

**Location**: `src/`

**Technology**: Node.js, TypeScript, sqlite3, Express

**API Endpoints**:
- `POST /signalk/v1/api/router/route` - Calculate route
- `GET /signalk/v1/api/router/search?q=...` - Search POIs
- `POST /signalk/v1/api/router/export/gpx` - Export to GPX
- `POST /signalk/v1/api/router/push` - Push route to Signal K
- `GET /signalk/v1/api/router/stats` - Database statistics
- `GET/PUT /signalk/v1/api/router/vessel` - Vessel dimensions

### Part 3: Interactive WebApp
User-facing application hosted by Signal K server.

**Location**: `public/`

**Technology**: HTML, CSS, JavaScript, Leaflet.js

**Features**:
- Interactive map with click-and-drag route planning
- Real-time vessel dimension display and overrides
- POI search with map integration
- GPX download and Signal K route activation

## Getting Started

### Prerequisites

- Node.js >= 18.0.0
- Python >= 3.9 (for Part 1 data pipeline)
- Signal K Server (for plugin deployment)

### Installation

```bash
# Install Node.js dependencies
npm install

# Build TypeScript
npm run build

# Run tests
npm test
```

### Generating the Routing Database

1. Unpack S-57 ENCs to a directory
2. Run the ENC preprocessor:
   ```bash
   cd backend
   python enc_preprocessor.py
   ```
3. Run the routing pipeline:
   ```bash
   python nautical_routing_pipeline.py
   ```

This generates `routing_graph.sqlite` in the data directory.

### Running the Plugin

```bash
# Development mode with ts-node
npm run dev

# Production mode
npm start
```

### Deploying to Signal K

1. Install as a Signal K plugin via the App Store or manually
2. Configure the path to your `routing_graph.sqlite` database
3. Set default vessel dimensions (or let it auto-detect from Signal K)

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `routingDatabase` | `./routing_graph.sqlite` | Path to routing database |
| `defaultDraft` | 2.0 | Default vessel draft (meters) |
| `defaultBeam` | 4.0 | Default vessel beam (meters) |
| `defaultAirDraft` | 10.0 | Default vessel air draft (meters) |
| `defaultCoastDistance` | 0.5 | Default min coast distance (NM) |
| `fairwayMultiplier` | 0.8 | Cost multiplier for fairways |
| `openWaterMultiplier` | 1.2 | Cost multiplier for open water |
| `wrongWayPenalty` | 5.0 | Penalty for wrong-way travel |
| `routingBBoxMargin` | 0.1 | A* bounding-box margin (degrees, ~11km) |
| `routingBBoxMaxExtent` | 10.0 | Max bounding box before full-graph fallback |
| `lineOfSightSampleInterval` | 500 | Line-of-sight sample spacing (meters) |
| `lineOfSightSearchRadius` | 800 | Line-of-sight node search radius (meters) |

## Routing Algorithm

### Safety Constraints
Edges are discarded if:
- `min_depth <= vessel.draft`
- `max_air_draft <= vessel.airDraft`
- `min_width <= vessel.beam`
- `distance_to_land < min_coast_distance`

### Cost Function
```
Cost = Distance × FairwayMultiplier × DirectionalPenalty
```

- **Fairway Multiplier**: 0.8 for official waterways, 1.2 for open water
- **Directional Penalty**: 1.0 for correct direction, 5.0 for wrong-way

## Project Structure

```
autoroute/
├── backend/                 # Part 1: Python data pipeline
│   ├── enc_preprocessor.py  # S-57 to GeoJSON converter
│   └── nautical_routing_pipeline.py  # Adaptive quadtree graph generator
├── public/                  # Part 3: WebApp frontend
│   ├── index.html
│   ├── styles.css
│   └── app.js
├── src/                     # Part 2: SignalK plugin
│   ├── index.ts             # Plugin entry point
│   ├── database.ts          # SQLite database layer (spatial grid index)
│   ├── routing.ts           # A* routing engine with bbox pruning + string-pulling
│   ├── api.ts               # Express API handlers
│   ├── gpx-export.ts        # GPX export utilities
│   └── types.ts             # TypeScript definitions
├── test/                    # Test files
│   └── routing.test.ts
├── package.json
├── tsconfig.json
└── README.md
```

## Development

```bash
# Watch mode for development
npm run build:watch

# Lint code
npm run lint

# Format code
npm run format

# Run tests
npm test
```

## License

MIT License - see LICENSE file for details

## Contributing

Contributions are welcome! Please submit pull requests or open issues for bugs and feature requests.

## Acknowledgments

- Signal K team for the plugin framework
- Dutch Hydrographic Office and Rijkswaterstaat for reference data
- OpenStreetMap contributors for map tiles
