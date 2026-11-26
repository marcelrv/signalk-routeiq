/**
 * Worker-thread host of the routing engine. Entry file: it runs inside a
 * `worker_thread` started by `EngineClient` and is never imported.
 *
 * It owns the store, the `RoutingDatabase` and the `RoutingEngine`, so a long
 * search runs off the caller's event loop. It speaks the protocol of
 * protocol.ts: one `init`, then jobs. The client sends one job at a time; a
 * second one arriving while a job runs is refused (`HOST_BUSY`). `abort` is
 * the only message handled during a job: the engine reaches an event-loop turn
 * every few thousand search iterations, which is where the message is read
 * and the job's `AbortSignal` takes effect.
 *
 * The host keeps the last few route results (`MAX_RETAINED_RESULTS`) by a
 * result id returned with each route; `gpx` builds GPX from one of those and
 * from nothing else. The nested db worker (SQLite reads) stays as it is.
 */

import { randomBytes } from "node:crypto";
import { isAbsolute } from "node:path";
import { pathToFileURL } from "node:url";
import { parentPort } from "node:worker_threads";
import { RoutingDatabase } from "./database.js";
import { RoutingEngine } from "./routing.js";
import { GpxExporter } from "./gpx-export.js";
import { RouteFailure } from "./failure.js";
import { LOG_LEVELS, type Logger } from "./logger.js";
import {
  HOST_REQUEST_TYPES,
  MAX_RETAINED_RESULTS,
  PROTOCOL_VERSION,
  type HostErrorCode,
  type HostJobRequest,
  type HostLogMessage,
  type HostProviderSpec,
  type HostReply,
  type HostRequest,
  type HostTestHooks,
  type WireError,
} from "./protocol.js";
import type { CurrentProvider, TideHeightProvider } from "./tides.js";
import type { RouteResult } from "./types.js";

if (!parentPort) {
  throw new Error("worker-host must be run as a worker thread");
}
const port = parentPort;

function post(reply: HostReply): void {
  port.postMessage(reply);
}

/** Forwards the engine's and the database's log lines to the client. */
const hostLogger: Logger = Object.fromEntries(
  LOG_LEVELS.map((level) => [
    level,
    (message: string, meta?: Record<string, unknown>) => {
      const line: HostLogMessage = { type: "log", level, message };
      if (meta) line.meta = meta;
      try {
        post(line);
      } catch {
        // A meta value that cannot be cloned: send the line without it.
        post({ type: "log", level, message });
      }
    },
  ]),
) as unknown as Logger;

let db: RoutingDatabase | null = null;
let engine: RoutingEngine | null = null;
let testHooks: HostTestHooks = {};
let maxRetained = MAX_RETAINED_RESULTS;
/** Route and departures jobs seen, for the test hooks. */
let searchJobs = 0;

/** Test hook: blocks this thread for good (no CPU used); only a terminate
 *  ends it. */
function maybeMisbehave(): void {
  searchJobs++;
  if (testHooks.hangOnRoute || testHooks.hangOnJobNumber === searchJobs) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
  }
}

/** The last route results, oldest first, by result id. */
const results = new Map<string, RouteResult>();
let nextResultId = 1;
/** Prefix of every result id this host hands out (see InitRequest). */
let generation = randomBytes(6).toString("hex");

/** The job being processed, if any, and the aborts of jobs by id. */
let busy = false;
const controllers = new Map<number, AbortController>();

function retain(result: RouteResult): string {
  const id = `${generation}:${nextResultId++}`;
  results.set(id, result);
  while (results.size > maxRetained) {
    results.delete(results.keys().next().value as string);
  }
  return id;
}

/** Loads a provider module named by the embedding application (trusted). */
async function loadProvider(spec: HostProviderSpec): Promise<unknown> {
  const location = spec.module;
  const url = location.startsWith("file:")
    ? location
    : isAbsolute(location)
      ? pathToFileURL(location).href
      : null;
  if (url === null) {
    throw new Error("a provider module must be an absolute path or file: URL");
  }
  const mod = (await import(url)) as { default?: unknown };
  if (typeof mod.default !== "function") {
    throw new Error("a provider module must export a function by default");
  }
  return (mod.default as (options: unknown) => unknown)(spec.options);
}

function hostError(code: HostErrorCode, message: string): WireError {
  return { failure: false, code, params: {}, message };
}

function toWireError(e: unknown): WireError {
  if (e instanceof RouteFailure) {
    return {
      failure: true,
      code: e.code,
      params: e.params,
      message: e.message,
      ...(e.blocking ? { blocking: e.blocking } : {}),
      catalogued: e.catalogued,
    };
  }
  if (e instanceof HostProtocolError) return hostError(e.code, e.message);
  // Anything else is a bug or an I/O error. Its own text may name paths or
  // SQL, so it goes to the log and the client gets a neutral message.
  hostLogger.error(
    `[worker-host] A job failed with an uncatalogued error: ${e instanceof Error ? e.message : String(e)}`,
  );
  return hostError("HOST_ERROR", "The routing engine host failed this request");
}

class HostProtocolError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
  }
}

function ready(): { db: RoutingDatabase; engine: RoutingEngine } {
  if (!db || !engine) {
    throw new HostProtocolError(
      "NOT_INITIALISED",
      "The host is not initialised",
    );
  }
  return { db, engine };
}

const PROVIDER_METHODS = ["findStations", "fetchTimeline", "probe"] as const;

const posInt = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v > 0;
const posOrInf = (v: unknown): boolean =>
  typeof v === "number" && !Number.isNaN(v) && v > 0;
const countOrZero = (v: unknown): boolean =>
  typeof v === "number" && Number.isInteger(v) && v >= 0;

/** Names the first init option that would switch a bound off (NaN, zero,
 *  negative, infinite), or null. */
function invalidInitOption(
  msg: Extract<HostRequest, { type: "init" }>,
): string | null {
  if (msg.retainedResults !== undefined && !posInt(msg.retainedResults)) {
    return "retainedResults";
  }
  const engineOptions = msg.engine as {
    maxSearchIterations?: unknown;
    budget?: { maxIterations?: unknown; maxWallMs?: unknown };
  };
  if (
    engineOptions.maxSearchIterations !== undefined &&
    !posInt(engineOptions.maxSearchIterations)
  ) {
    return "engine.maxSearchIterations";
  }
  for (const k of ["maxIterations", "maxWallMs"] as const) {
    const v = engineOptions.budget?.[k];
    if (v !== undefined && !posOrInf(v)) return `engine.budget.${k}`;
  }
  for (const k of ["maxLoadedRegions", "maxLoadedRegionEdges"] as const) {
    const v = (msg.database as Record<string, unknown>)[k];
    if (v !== undefined && !countOrZero(v)) return `database.${k}`;
  }
  return null;
}

function requireMethods(
  instance: unknown,
  methods: readonly string[],
  what: string,
): void {
  const o = instance as Record<string, unknown> | null | undefined;
  for (const m of methods) {
    if (!o || typeof o[m] !== "function") {
      throw new Error(`the ${what} provider has no ${m}() function`);
    }
  }
}

async function init(
  msg: Extract<HostRequest, { type: "init" }>,
): Promise<void> {
  if (msg.protocolVersion !== PROTOCOL_VERSION) {
    throw new HostProtocolError(
      "PROTOCOL_MISMATCH",
      `Protocol version ${msg.protocolVersion} is not supported by this host (it speaks ${PROTOCOL_VERSION})`,
    );
  }
  if (db)
    throw new HostProtocolError(
      "INIT_FAILED",
      "The host is already initialised",
    );
  testHooks = msg.testHooks ?? {};
  if (msg.generation) generation = msg.generation;
  const badOption = invalidInitOption(msg);
  if (badOption) {
    hostLogger.error(`[worker-host] Invalid init option: ${badOption}`);
    throw new HostProtocolError("INIT_FAILED", "An init option is invalid");
  }
  maxRetained = msg.retainedResults ?? MAX_RETAINED_RESULTS;
  const database = new RoutingDatabase({
    ...msg.database,
    files: msg.database.files,
    logger: hostLogger,
  });
  try {
    await database.init();
    await database.loadGraph();
  } catch (e) {
    await database.close().catch(() => undefined);
    hostLogger.error(
      `[worker-host] Opening the routing data failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw new HostProtocolError(
      "INIT_FAILED",
      "The routing data could not be opened",
    );
  }
  const hosted = new RoutingEngine(database, {
    ...msg.engine,
    logger: hostLogger,
  });
  try {
    if (msg.providers?.tideHeights) {
      const tides = await loadProvider(msg.providers.tideHeights);
      requireMethods(tides, PROVIDER_METHODS, "tide height");
      hosted.setTidesClient(tides as TideHeightProvider);
    }
    if (msg.providers?.currents) {
      const currents = await loadProvider(msg.providers.currents);
      requireMethods(currents, PROVIDER_METHODS, "current");
      hosted.setCurrentsClient(currents as CurrentProvider);
    }
  } catch (e) {
    await database.close().catch(() => undefined);
    hostLogger.error(
      `[worker-host] Loading a provider module failed: ${e instanceof Error ? e.message : String(e)}`,
    );
    throw new HostProtocolError(
      "INIT_FAILED",
      "A provider could not be loaded",
    );
  }
  db = database;
  engine = hosted;
}

async function runJob(
  msg: HostJobRequest,
  signal: AbortSignal,
): Promise<unknown> {
  switch (msg.type) {
    case "status": {
      const { db, engine } = ready();
      return {
        status: db.getStatus(),
        dataVersion: db.getDataVersion(),
        counters: engine.getCounters(),
      };
    }
    case "route": {
      const { engine } = ready();
      maybeMisbehave();
      if (testHooks.crashOnRoute) {
        setImmediate(() => {
          throw new Error("test hook: crash on route");
        });
        await new Promise(() => undefined);
      }
      const result = await engine.calculateRoute(msg.request, {
        budget: msg.budget,
        signal,
      });
      return { resultId: retain(result), result };
    }
    case "departures": {
      const { engine } = ready();
      maybeMisbehave();
      return engine.scanDepartures(msg.request, msg.hours, msg.stepMinutes, {
        budget: msg.budget,
        signal,
      });
    }
    case "pois": {
      const { db } = ready();
      return db.getPoisInBBox(
        msg.minLat,
        msg.minLon,
        msg.maxLat,
        msg.maxLon,
        db.clampBBoxLimit(msg.limit),
      );
    }
    case "search": {
      const { db } = ready();
      return db.searchPois(msg.query, msg.limit);
    }
    case "nearestPoi": {
      const { db } = ready();
      return db.getNearestPoi(msg.lat, msg.lon, msg.radiusM);
    }
    case "coverage": {
      const { db } = ready();
      return db.getCoverageStatus();
    }
    case "gpx": {
      ready();
      const route = results.get(msg.resultId);
      if (!route) {
        throw new HostProtocolError(
          "UNKNOWN_RESULT",
          "No route result with that id is held by the host",
        );
      }
      return GpxExporter.toGpx(route, msg.name, msg.provider, msg.lang);
    }
    case "shutdown": {
      const open = db;
      db = null;
      engine = null;
      results.clear();
      if (open) await open.close();
      return null;
    }
    default: {
      const unknown: never = msg;
      throw new HostProtocolError(
        "UNKNOWN_REQUEST",
        `Unknown request type ${String((unknown as { type?: unknown }).type)}`,
      );
    }
  }
}

async function handle(msg: HostRequest): Promise<void> {
  if (msg.type === "abort") {
    controllers.get(msg.jobId)?.abort();
    return;
  }
  const id = msg.id;
  if (busy) {
    post({
      type: "result",
      id,
      ok: false,
      error: hostError("HOST_BUSY", "The host is running another job"),
    });
    return;
  }
  busy = true;
  const controller = new AbortController();
  controllers.set(id, controller);
  try {
    const value =
      msg.type === "init"
        ? await init(msg).then(() => null)
        : await runJob(msg, controller.signal);
    post({ type: "result", id, ok: true, value });
  } catch (e) {
    post({ type: "result", id, ok: false, error: toWireError(e) });
  } finally {
    controllers.delete(id);
    busy = false;
  }
}

port.on("message", (raw: unknown) => {
  const msg = raw as Partial<HostRequest> | null;
  const type = msg?.type;
  if (
    typeof type !== "string" ||
    !(HOST_REQUEST_TYPES as readonly string[]).includes(type)
  ) {
    const id = (msg as { id?: unknown } | null)?.id;
    if (typeof id === "number") {
      post({
        type: "result",
        id,
        ok: false,
        error: hostError("UNKNOWN_REQUEST", "Unknown request type"),
      });
    }
    return;
  }
  void handle(msg as HostRequest);
});
