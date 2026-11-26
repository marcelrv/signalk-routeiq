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
  type HostReply,
  type HostRequest,
  type HostTestHooks,
  type WireError,
} from "./protocol.js";
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

/** The last route results, oldest first, by result id. */
const results = new Map<number, RouteResult>();
let nextResultId = 1;

/** The job being processed, if any, and the aborts of jobs by id. */
let busy = false;
const controllers = new Map<number, AbortController>();

function retain(result: RouteResult): number {
  const id = nextResultId++;
  results.set(id, result);
  while (results.size > maxRetained) {
    results.delete(results.keys().next().value as number);
  }
  return id;
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
  maxRetained = Math.max(1, msg.retainedResults ?? MAX_RETAINED_RESULTS);
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
  db = database;
  engine = new RoutingEngine(database, { ...msg.engine, logger: hostLogger });
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
      if (testHooks.hangOnRoute) {
        // Blocks this thread for good (no CPU used): only a terminate ends it.
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      }
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
