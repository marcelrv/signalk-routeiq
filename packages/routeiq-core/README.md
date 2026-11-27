# routeiq-core

The routing engine of `signalk-routeiq`: A* search over a compiled routing graph
(SQLite files), vessel constraints (draft, beam, air draft), locks and bridges
with waits, tides, route descriptions, itineraries and GPX / Signal K route
export. It runs inside the Signal K plugin and equally well in any other Node.js
program, in the same thread or in a worker thread, so it can be embedded and
tested without a Signal K server.

The package has no runtime dependencies and imports only `node:*` modules.

- [Requirements](#requirements)
- [Install](#install)
- [Quick start (in-process)](#quick-start-in-process)
- [Worker host](#worker-host)
- [Strict mode and request validation](#strict-mode-and-request-validation)
- [Errors, codes and translations](#errors-codes-and-translations)
- [Logging and counters](#logging-and-counters)
- [The route result](#the-route-result)
- [Import boundary](#import-boundary)
- [Versioning](#versioning)
- [Build and test](#build-and-test)

## Requirements

Node.js `>=22.5.0`, because the engine reads the routing files with `node:sqlite`.

- Node 22.5.0 up to 22.12 (and 23.0 to 23.3): `node:sqlite` exists only behind a
  flag. Start Node with `--experimental-sqlite`, and for tests
  `node --test --experimental-sqlite`. The flag has to be on the process that
  opens the data, which for the worker host means the process that creates the
  `EngineClient` (worker threads inherit it).
- Node 22.13 and later, 23.4 and later, and 24: no flag is needed.
- Read-only mode (`readOnly: true`) needs Node.js 22.12 or later: it needs a
  `node:sqlite` that honours the `readOnly` open option. Node 22.5.0 ignores it and would open the file
  read-write, so each region file is checked when it is opened read-only: a
  write is tried inside a transaction that is always rolled back, and a
  connection that accepts it is refused with an error, rather than writing
  anything. Nothing is created beside the data for the check. Use a newer
  Node.js in that case.

## Install

The package is not published to npm. Each release is a tarball attached to a
GitHub release (`core-vX.Y.Z`), together with a `.sha256` file:

```
npm install https://github.com/marcelrv/signalk-routeiq/releases/download/core-v1.0.0/routeiq-core-1.0.0.tgz
```

npm records the tarball's integrity hash in `package-lock.json`; later installs
fail if the file at that URL changes. You can also compare the downloaded file
with the `.sha256` asset yourself.

The plugin does not install it: the plugin build bundles the engine into
`dist/index.js` and `dist/db-worker.js`, so the plugin has no dependency on this
package at runtime.

## Quick start (in-process)

The engine and the database run in the calling thread (the SQLite reads happen in
the store's own worker thread, the search itself runs on your event loop and
yields regularly).

- `RoutingDatabase` takes an explicit list of files. It never lists a directory
  itself. `init()` reads the files' metadata; `loadGraph()` then loads the
  routing graph. `policy: "pinned"` loads every listed region there and keeps it
  in memory; the default `"dynamic"` loads regions on demand and evicts them.
- `readOnly: true` opens the files read-only, opens no overlay (graph edits are
  refused with `GraphEditError` `READ_ONLY`) and writes nothing anywhere, so the
  data directory may be on a read-only file system.
- The engine keeps no vessel state. Draft, beam, air draft, speed, margins, waits
  and the tide choice come with each request; the engine options only supply the
  defaults for what a request leaves out.
- The second argument of `calculateRoute` (also of `streamDepartures` and
  `scanDepartures`) is `{ budget, signal }`. `budget` limits `maxIterations`
  (A* node expansions) and `maxWallMs` over the whole request, including every
  retry, via leg and smoothing pass; it can only lower the budget in the engine
  options. `signal` is an `AbortSignal`. An overrun fails with
  `BUDGET_EXCEEDED`, an abort with `ABORTED`.

```ts example:imports
import {
  DEFAULT_ENGINE_OPTIONS,
  DEFAULT_REQUEST_LIMITS,
  EngineClient,
  RouteFailure,
  RoutingDatabase,
  RoutingEngine,
  format,
  validateRouteRequest,
  type EngineClientOptions,
  type Logger,
  type RouteResult,
  type RoutingRequest,
} from 'routeiq-core';
```

```ts example:quick-start
async function quickStart(dataFile: string): Promise<RouteResult> {
  const database = new RoutingDatabase({
    files: [{ path: dataFile, enabled: true }],
    policy: 'pinned',
    readOnly: true,
  });
  try {
    await database.init();
    await database.loadGraph(); // `pinned`: loads every listed region
    const engine = new RoutingEngine(database, DEFAULT_ENGINE_OPTIONS);
    const controller = new AbortController();
    return await engine.calculateRoute(
      {
        start: { latitude: 51.613, longitude: 3.885 },
        end: { latitude: 51.609, longitude: 3.896 },
        draft: 1.6,
        beam: 4.2,
        airDraft: 12,
        speedKnots: 6,
      },
      { budget: { maxWallMs: 30_000 }, signal: controller.signal },
    );
  } finally {
    await database.close();
  }
}
```

Tide heights and current stations are optional providers set on the engine
(`setTidesClient`, `setCurrentsClient`); without them tides are not used.

## Worker host

`EngineClient` runs the database and the engine in a `worker_thread` behind a
versioned protocol (`PROTOCOL_VERSION`), so a long search, the data and a crash
stay off the caller's thread.

- **Init options.** `engine` (the `EngineOptions` without a logger), `database`
  (`RoutingDatabaseOptions` without `store`, `overlay`, `logger`, and with an
  explicit `files` array), `logger` (receives what the host logs), `hardStopGraceMs`
  (default 5000), `retainedResults` (how many results are kept for `gpx`,
  default 32), `providers`, `hostPath` (default: `worker-host.js` next to the
  package's entry file).
- **Providers.** Tide-height and current providers are modules loaded inside the
  worker: an absolute path or a `file:` URL whose default export is called with
  `options` and returns the provider. They run code in the worker, so they are
  trusted configuration of the embedding program, never request data.
- **Jobs.** `route`, `departures` (a whole scan as a step list under one budget),
  `status`, `pois`, `search`, `nearestPoi`, `coverage` and `gpx`. The host runs
  one job at a time; the client queues the rest in order. Each call returns a
  promise that also has a `jobId`.
- **Abort.** `client.abort(jobId)`, or `{ signal }` in the job options. A queued
  job is rejected at once, a running one is rejected with `ABORTED` and the host
  is told to stop it.
- **Restart.** A running job that outlives its `maxWallMs` by `hardStopGraceMs`
  (or an aborted job that does not end within it) means the host is hung: the
  client terminates the worker, rejects that job with `EngineWorkerError`
  `WORKER_RESTARTED`, starts a new worker and initialises it again. A worker that
  exits on its own fails the running job with `WORKER_EXITED` and is replaced on
  the next call. Jobs still queued were never sent and run on the new worker.
  `client.ready` is a promise of the current worker being initialised (a new one
  after each restart), `client.onReady(fn)` fires after every initialisation, and
  data the old worker had loaded is read again from the files.
- **Result ids.** `route` resolves to `{ resultId, result }`. The id (a string)
  names the result inside the worker that made it, and the host keeps the last
  `retainedResults` of them. `client.gpx(resultId, name, provider, lang?)` builds
  the GPX from a held result; any other id, including one from a replaced worker,
  rejects with `UNKNOWN_RESULT`.
- **Errors.** A failed route rejects with `RouteFailure` (same `code`, `params`,
  `message`, `blocking`); a worker or protocol problem rejects with
  `EngineWorkerError` and its own code (`PROTOCOL_MISMATCH`, `INIT_FAILED`,
  `WORKER_RESTARTED`, `WORKER_EXITED`, `HOST_ERROR`, `UNKNOWN_RESULT`, `CLOSED`,
  and the like). `close()` stops the worker; jobs still queued reject with
  `CLOSED`.

```ts example:worker-host
async function inWorker(dataFile: string): Promise<string> {
  const client = new EngineClient({
    engine: { ...DEFAULT_ENGINE_OPTIONS, requireVesselInRequest: true },
    database: {
      files: [{ path: dataFile, enabled: true }],
      policy: 'pinned',
      readOnly: true,
    },
    hardStopGraceMs: 5000,
  });
  try {
    await client.ready;
    const job = client.route(
      {
        start: { latitude: 51.613, longitude: 3.885 },
        end: { latitude: 51.609, longitude: 3.896 },
        draft: 1.6,
        beam: 4.2,
        airDraft: 12,
        speedKnots: 6,
      },
      { budget: { maxWallMs: 30_000 } },
    );
    // client.abort(job.jobId) would cancel it; so would a signal in the options.
    const { resultId, result } = await job;
    if (result.features.length === 0) throw new Error('empty route');
    return await client.gpx(resultId, 'Example route', {
      name: 'my-app',
      version: '1.0.0',
    });
  } finally {
    await client.close();
  }
}
```

```ts example:providers
function withTideProviders(
  base: EngineClientOptions,
  tideModule: string,
): EngineClientOptions {
  return {
    ...base,
    providers: {
      // An absolute path or a file: URL; the module's default export is
      // called with `options` and returns the provider.
      tideHeights: { module: tideModule, options: { region: 'north-sea' } },
    },
  };
}
```

## Strict mode and request validation

Two separate checks, for two kinds of caller.

**Strict mode** (`EngineOptions.requireVesselInRequest: true`) is for a caller
that has no vessel of its own to fall back on. A request without `draft`, `beam`,
`airDraft` and `speedKnots` is refused with `RouteRequestError` (a `RouteFailure`
with code `VESSEL_INCOMPLETE` and `params.missing`) instead of being routed with
`defaultVessel` and `defaultSpeedKnots`. The values actually used are echoed in
`RouteResult.inputs`.

**The request validator** (`validateRouteRequest(body, limits)`) turns an
untrusted JSON body into a clean `RoutingRequest`. It checks, in this order, that
the body is an object, that start and end are coordinates in range, the via list
(count, coordinates, `auto`/`manual` modes), `endMode`, `departureTime`, the
vessel dimensions, coast distance, waits, speed, safety margins, boolean flags
and `lang`, and the straight-line length. It returns
`{ ok: true, request, warnings, unknownFields }` or
`{ ok: false, error: { code, field, message, messageKey, params } }`; `messageKey` is the catalogue key the message was rendered from, so errors that share a `code` (a wrong type and an out-of-range number are both `INVALID_VALUE`) can be told apart, and `params` carries `max` and, where the text applies, `received` (the kind of a value of the wrong type) or `value` (a number out of range). A fresh request object
is built from known fields only; unknown top-level fields are reported, not
copied.

`RequestLimits` sets what is accepted: `maxVias` (default 25),
`maxStraightLineNm` (default none), `allowManualLegs`, `acceptCoordinateAliases`
(`lat`/`lng`/`lon`), `maxDimensionM`, `maxCoastDistanceNm` (100), `maxWaitMinutes`
(1440), `maxSpeedKnots` (60), `maxSafetyMarginM` (100), `maxLangLength` (35),
`ignoredDimensionFallback`, `messageLanguage`, and `strict`: when true an
unusable vessel dimension is an error, otherwise it is dropped and reported as a
`VESSEL_DIMENSION_IGNORED` warning. Start from `DEFAULT_REQUEST_LIMITS`.

```ts example:validation
function parseBody(body: unknown): RoutingRequest {
  const checked = validateRouteRequest(body, {
    ...DEFAULT_REQUEST_LIMITS,
    strict: true,
    maxVias: 10,
    maxStraightLineNm: 500,
  });
  if (!checked.ok) {
    // checked.error: { code, field, message, params }
    throw new Error(`${checked.error.field}: ${checked.error.message}`);
  }
  return checked.request;
}
```

## Errors, codes and translations

- **`RouteFailure`** is what a request that cannot be answered throws. It has a
  stable `code` (`NO_PATH`, `OUTSIDE_COVERAGE`, `NO_NODE_NEAR_POINT`,
  `BUDGET_EXCEEDED`, `ABORTED`, `VESSEL_INCOMPLETE`, `REGION_UNAVAILABLE`,
  `INVALID_REQUEST`; `FAILURE_CODES`), `params` (the values behind the text),
  an optional `blocking` list (what the search knew stood in the way: a
  structure, or the dimension that did not fit), and a `message` that never
  contains file paths, SQL or internal ids. `RouteSearchError` and
  `RouteRequestError` are subclasses.
- **Warnings** (`RouteResult.warnings`, itinerary leg warnings, description
  warnings, crossing notes, departure scan errors, passage-profile warnings) carry
  a `code` and `params` next to the human text. Match on the code; the text is
  only a rendering of it. The code lists are in `codes.ts` and exported
  (`ROUTE_WARNING_CODES`, `LEG_WARNING_CODES`, and so on). Codes are never reused
  for a different meaning.
- **Messages.** Every text the engine writes is a catalogue entry keyed by code
  (`messages.ts`), in English (`en`) and Dutch (`nl`).
  `format(key, params, lang)` and `formatFailure(code, params, lang)` render one;
  `resolveMessageLanguage(tag)` maps a language tag to a catalogue language
  (`nl-BE` reads as `nl`, anything unknown as `en`). A client that wants its own
  wording renders from `code` and `params` instead.
- **`messageLanguage`** (engine option, also on `RequestLimits`): `"request"`
  (default) writes each result in the request's `lang`; any other value is a
  language tag every request is answered in. The request's `lang` still selects
  the language of water names.

```ts example:errors
async function describeOutcome(
  engine: RoutingEngine,
  request: RoutingRequest,
): Promise<string> {
  try {
    const route = await engine.calculateRoute(request);
    // Warnings carry a stable code and the values behind the text.
    return (route.warnings ?? []).map((w) => `${w.code} ${w.message}`).join('; ');
  } catch (error) {
    if (error instanceof RouteFailure) {
      // error.code is one of NO_PATH, OUTSIDE_COVERAGE, BUDGET_EXCEEDED, ...
      // error.params and error.message are safe to show.
      return `${error.code}: ${error.message}`;
    }
    throw error;
  }
}
```

## Logging and counters

The engine never writes to the console. Pass a `Logger`
(`debug`/`info`/`warn`/`error`, each `(message, meta?)`) as
`EngineOptions.logger`, `RoutingDatabaseOptions.logger` or, for the worker host,
`EngineClientOptions.logger`; the default is silent. At `info` and above nothing
carries route coordinates, request bodies or user-typed names (file names, counts
and timings only); anything that locates a position is `debug`, so a host that
drops `debug` keeps coordinates out of its logs.

`RoutingEngine.getCounters()` returns a snapshot of numbers only: routes
calculated and failed, failures by code, budget hits, A* iterations and time
(sum and count) and the regions loaded with an estimated size each.
`EngineClient.status()` returns the same counters from the worker.

```ts example:logging
function onlyProblems(lines: string[]): Logger {
  return {
    debug: () => {},
    info: () => {},
    warn: (message) => lines.push(message),
    error: (message) => lines.push(message),
  };
}
```

## The route result

`calculateRoute` resolves to a `RouteResult`: a GeoJSON `FeatureCollection` with
one feature per segment, totals (distance, seconds, waiting time, arrival),
`warnings`, `crossings` (locks and bridges passed), simplified `waypoints`, an
`itinerary` with per-leg aggregates, and a `description` of the waters passed
(see the type definitions in `src/types.ts`).

Two parts say what a result rests on:

- `inputs` echoes the values used: the vessel dimensions, speed, margins, waits,
  tide choice, language and `coreVersion`, where the request gave a value or the
  engine option supplied one.
- `inputs.data` lists the routing files in memory (file name, the metadata's
  `lastUpdateDate`, a build id when the file has one), as provenance hints.

## Import boundary

The compiled package imports only `node:*` modules and its own files. There is
no Signal K, Express or other runtime dependency. An ESLint rule and a test on the
compiled output enforce this.

## Versioning

The package follows semver. A **breaking change** is any change to:

- the exported API (a removed or renamed export, a changed signature or option,
  a changed error code);
- the route result shape (`RouteResult` and what it contains);
- the worker protocol (`PROTOCOL_VERSION` is bumped with it).

New optional fields, new exports, new codes and new catalogue languages are
minor changes; fixes that do not alter shapes are patch changes. Releases are
listed in [CHANGELOG.md](CHANGELOG.md).

## Build and test

From the repository root:

```
npm run build        # builds this package first, then the plugin
npm test             # plugin tests, then this package's tests
npm run test:packed  # installs the packed plugin into an empty directory
npm run test:pack-core  # checks the contents of this package's tarball
```

Or only this package: `npm run build -w routeiq-core` and
`npm test -w routeiq-core`. The examples above are compiled and run by
`test/readme-examples.test.ts`.
