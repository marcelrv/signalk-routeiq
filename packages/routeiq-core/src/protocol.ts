/**
 * The message protocol between `EngineClient` (main thread) and the worker
 * host (`worker-host.ts`, in a `worker_thread`).
 *
 * Everything on the wire is plain structured-clone data: no functions, no
 * class instances, no logger. A failure crosses as a `WireError`
 * (`{ code, params, message, blocking? }`) and the client throws it again as a
 * `RouteFailure`.
 *
 * Versioning: `PROTOCOL_VERSION` is sent in `init`; a host built from another
 * revision refuses it (`PROTOCOL_MISMATCH`) and nothing else is processed.
 * Change the number whenever a message or a reply changes shape.
 *
 * The request set is closed on purpose (`HOST_REQUEST_TYPES`). There is no
 * message that lists or dumps the graph, all POIs or all edges: a client can
 * only route, ask for a bounded POI/search/nearest answer, read the coverage
 * and status summaries, build a GPX from a result the host still holds, abort
 * a job, or shut the host down.
 */

import type { FailureCode } from "./codes.js";
import type { BlockingCause } from "./failure.js";
import type { EngineOptions } from "./engine-options.js";
import type { RegionFileEntry } from "./routing-store.js";
import type { RoutingDatabaseOptions } from "./database.js";
import type { SearchBudget } from "./request-control.js";
import type { ProviderInfo, RoutingRequest } from "./types.js";

export const PROTOCOL_VERSION = 1;

/** Every request type the host understands, and nothing else. */
export const HOST_REQUEST_TYPES = [
  "init",
  "status",
  "route",
  "departures",
  "pois",
  "search",
  "nearestPoi",
  "coverage",
  "gpx",
  "abort",
  "shutdown",
] as const;

export type HostRequestType = (typeof HOST_REQUEST_TYPES)[number];

/** Engine options as they cross: all of them except the logger (the host
 *  logs through the client's, see `HostLogMessage`). */
export type HostEngineOptions = Omit<EngineOptions, "logger">;

/** Database options as they cross: an explicit file list instead of a
 *  function, and no store, overlay or logger. */
export type HostDatabaseOptions = Omit<
  RoutingDatabaseOptions,
  "files" | "store" | "overlay" | "logger"
> & {
  /** The region files, with their enabled flag. */
  files: RegionFileEntry[];
};

/** Switches that make the host misbehave on purpose, for tests. Ignored
 *  unless `init` carries them. */
export interface HostTestHooks {
  /** Every route or departures job blocks the host thread and never
   *  answers. */
  hangOnRoute?: boolean;
  /** Only the Nth route or departures job (counting from 1) does. */
  hangOnJobNumber?: number;
  /** A route job throws out of the host thread (an unexpected exit). */
  crashOnRoute?: boolean;
}

/**
 * A provider module the host loads inside the worker. `module` is an absolute
 * file path or a `file:` URL; the host `import()`s it and calls its default
 * export with `options` (async allowed). That export returns a
 * `TideHeightProvider` or `CurrentProvider`, which is handed to the engine.
 *
 * Trusted configuration: loading a module runs its code in the host. Only the
 * embedding application may supply these paths, never request data.
 */
export interface HostProviderSpec {
  module: string;
  options?: unknown;
}

export interface HostProviders {
  tideHeights?: HostProviderSpec;
  currents?: HostProviderSpec;
}

export interface InitRequest {
  type: "init";
  id: number;
  protocolVersion: number;
  engine: HostEngineOptions;
  database: HostDatabaseOptions;
  /** Tide and current providers to load in the worker (trusted paths). */
  providers?: HostProviders;
  /** Names this worker; result ids carry it, so an id from another worker
   *  (an earlier one, replaced) is never known here. Default: random. */
  generation?: string;
  /** How many route results the host keeps for `gpx`. Default
   *  `MAX_RETAINED_RESULTS`. */
  retainedResults?: number;
  testHooks?: HostTestHooks;
}

export interface StatusRequest {
  type: "status";
  id: number;
}

export interface RouteJobRequest {
  type: "route";
  id: number;
  request: RoutingRequest;
  /** Lowers the engine's budget for this request; never raises it. */
  budget?: Partial<SearchBudget>;
}

/** A whole departure scan, answered as the full step list (not streamed). */
export interface DeparturesRequest {
  type: "departures";
  id: number;
  request: RoutingRequest;
  hours?: number;
  stepMinutes?: number;
  /** Lowers the engine's budget; one budget for the whole scan. */
  budget?: Partial<SearchBudget>;
}

export interface PoisRequest {
  type: "pois";
  id: number;
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
  /** Lowers the database's cap; never raises it. */
  limit?: number;
}

export interface SearchRequest {
  type: "search";
  id: number;
  query: string;
  limit?: number;
}

export interface NearestPoiRequest {
  type: "nearestPoi";
  id: number;
  lat: number;
  lon: number;
  radiusM?: number;
}

export interface CoverageRequest {
  type: "coverage";
  id: number;
}

export interface GpxRequest {
  type: "gpx";
  id: number;
  /** A `resultId` of a route the host still holds. */
  resultId: string;
  name: string;
  provider: ProviderInfo;
  lang?: string | null;
}

/** Aborts job `jobId`. It has no reply of its own: the aborted job answers. */
export interface AbortRequest {
  type: "abort";
  jobId: number;
}

export interface ShutdownRequest {
  type: "shutdown";
  id: number;
}

export type HostRequest =
  | InitRequest
  | StatusRequest
  | RouteJobRequest
  | DeparturesRequest
  | PoisRequest
  | SearchRequest
  | NearestPoiRequest
  | CoverageRequest
  | GpxRequest
  | AbortRequest
  | ShutdownRequest;

/** Requests that are jobs: one is processed at a time and each has a reply. */
export type HostJobRequest = Exclude<HostRequest, AbortRequest | InitRequest>;

/** Codes of a failure that is not a `RouteFailure`. */
export type HostErrorCode =
  | "PROTOCOL_MISMATCH"
  | "NOT_INITIALISED"
  | "INIT_FAILED"
  | "UNKNOWN_RESULT"
  | "UNKNOWN_REQUEST"
  | "HOST_BUSY"
  | "HOST_ERROR";

/** A failure on the wire. `failure` is true for a `RouteFailure` (`code` is
 *  then a `FailureCode`), false for a host-level error (`code` is a
 *  `HostErrorCode`). */
export interface WireError {
  failure: boolean;
  code: FailureCode | HostErrorCode;
  params: Record<string, unknown>;
  message: string;
  blocking?: BlockingCause[];
  /** `RouteFailure.catalogued`. */
  catalogued?: boolean;
}

export interface HostResult {
  type: "result";
  /** The job's id (the request's `id`). */
  id: number;
  ok: boolean;
  value?: unknown;
  error?: WireError;
}

export interface HostLogMessage {
  type: "log";
  level: "debug" | "info" | "warn" | "error";
  message: string;
  meta?: Record<string, unknown>;
}

export type HostReply = HostResult | HostLogMessage;

/** The most route results a host keeps for `gpx` unless `init` says
 *  otherwise. */
export const MAX_RETAINED_RESULTS = 32;
