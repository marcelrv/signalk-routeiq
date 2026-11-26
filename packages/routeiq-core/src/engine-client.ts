/**
 * `EngineClient`: the main-thread side of the worker host (worker-host.ts).
 *
 * It starts the host in a `worker_thread`, sends `init`, and exposes the
 * engine as promise methods, so a long search never runs on the caller's event
 * loop. The plugin does not use it (it calls the engine in-process); it is for
 * a host process that wants the search, the data and a crash off its own
 * thread.
 *
 * Jobs: the host runs one job at a time and the client queues the rest in
 * order. Every job method returns a promise with a `jobId`; `abort(jobId)` (or
 * an `AbortSignal` in the call options) cancels a queued job at once and asks
 * the host to stop a running one. A running job is rejected with `ABORTED` as
 * soon as it is aborted; the host's late answer is dropped.
 *
 * Hard stop and restart: when a running job outlives its wall budget
 * (`maxWallMs`, from the engine options or the call's budget) by
 * `hardStopGraceMs`, or an aborted job does not end within `hardStopGraceMs`,
 * the host is hung or buggy, not slow: the client terminates the worker,
 * rejects that job with `EngineWorkerError` `WORKER_RESTARTED`, starts a new
 * worker and sends the same `init` again. The same happens, lazily on the next
 * call when nothing is queued, after the worker exits on its own (`WORKER_EXITED`
 * for the job that was running). Jobs still queued were never sent, so they are
 * kept and run on the new worker. `ready` is a promise of the current worker
 * being initialised (a new one after each restart); `onReady` fires after every
 * initialisation. The data the old worker had loaded is read again from the
 * files.
 */

import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type {
  DatabaseStatus,
  PoiBBoxResult,
  RoutingDatabase,
} from "./database.js";
import type { DatabaseCoverageEntry } from "./database.js";
import type { EngineCounters } from "./counters.js";
import { RouteRequestError } from "./engine-options.js";
import { RouteFailure } from "./failure.js";
import { LOG_LEVELS, resolveLogger, type Logger } from "./logger.js";
import {
  PROTOCOL_VERSION,
  type HostDatabaseOptions,
  type HostEngineOptions,
  type HostProviders,
  type HostReply,
  type HostRequest,
  type HostTestHooks,
  type InitRequest,
  type WireError,
} from "./protocol.js";
import { effectiveBudget, type SearchBudget } from "./request-control.js";
import type {
  DataVersionEntry,
  DepartureScanStep,
  ProviderInfo,
  RouteResult,
  RoutingRequest,
} from "./types.js";

export type EngineWorkerErrorCode =
  /** The host refused `init`: another protocol version. */
  | "PROTOCOL_MISMATCH"
  /** The host could not open the routing data, or never started. */
  | "INIT_FAILED"
  /** The worker was terminated and replaced (hard stop). */
  | "WORKER_RESTARTED"
  /** The worker exited on its own while the job was running. */
  | "WORKER_EXITED"
  /** The host failed the job for a reason it keeps to its log. */
  | "HOST_ERROR"
  /** `gpx` was asked for a result the host does not hold. */
  | "UNKNOWN_RESULT"
  /** The client was closed. */
  | "CLOSED"
  | "UNKNOWN_REQUEST"
  | "HOST_BUSY"
  | "NOT_INITIALISED";

/** A failure of the worker or the protocol, as opposed to a `RouteFailure`
 *  (a route that could not be found or a request that was refused). */
export class EngineWorkerError extends Error {
  readonly code: EngineWorkerErrorCode;

  constructor(code: EngineWorkerErrorCode, message: string) {
    super(message);
    this.name = "EngineWorkerError";
    this.code = code;
  }
}

export interface EngineClientOptions {
  /** Engine options for the host (without a logger). */
  engine: HostEngineOptions;
  /** The routing data to open: an explicit file list, policy and paths. */
  database: HostDatabaseOptions;
  /** Receives what the host and its engine log. Default: silent. */
  logger?: Logger;
  /** Milliseconds a running job may exceed its `maxWallMs` before the worker
   *  is terminated and replaced; also how long an aborted job may take to end.
   *  Default 5000. */
  hardStopGraceMs?: number;
  /** How many route results the host keeps for `gpx`. */
  retainedResults?: number;
  /** Tide and current provider modules the host loads in the worker. Trusted
   *  configuration of the embedding application (they run code in the host),
   *  never request data. See `HostProviderSpec`. */
  providers?: HostProviders;
  /** The protocol version sent in `init`. Default `PROTOCOL_VERSION`; another
   *  value makes the host refuse (for tests). */
  protocolVersion?: number;
  /** Test switches, ignored by the host unless given here. */
  testHooks?: HostTestHooks;
  /** The host file. Default: `worker-host.js` next to this module. */
  hostPath?: string;
}

/** A job's promise, with its id for `abort`. */
export type EngineJob<T> = Promise<T> & { readonly jobId: number };

export interface JobOptions {
  /** Aborts the job (queued or running) with `ABORTED`. */
  signal?: AbortSignal;
}

export interface RouteJobOptions extends JobOptions {
  /** Lowers the engine's budget for this request; never raises it. */
  budget?: Partial<SearchBudget>;
}

export interface RouteResponse {
  /** Names this result in `gpx`, for as long as the host keeps it. Carries
   *  the worker's generation: after a worker is replaced it is unknown. */
  resultId: string;
  result: RouteResult;
}

export interface EngineStatus {
  status: DatabaseStatus;
  dataVersion: DataVersionEntry[];
  counters: EngineCounters;
}

export interface PoiBBox {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** A name-search hit. */
export type PoiSearchResult = Awaited<
  ReturnType<RoutingDatabase["searchPois"]>
>[number];

/** Nearest POI answer; null when none is within the radius. */
export type NearestPoiResult = Awaited<
  ReturnType<RoutingDatabase["getNearestPoi"]>
>;

const DEFAULT_HARD_STOP_GRACE_MS = 5000;
const SHUTDOWN_WAIT_MS = 5000;

type JobBody =
  Exclude<HostRequest, { type: "abort" | "init" }> extends infer R
    ? R extends { id: number }
      ? Omit<R, "id">
      : never
    : never;

interface Job {
  id: number;
  body: JobBody;
  /** Wall limit of a route job: the budget's `maxWallMs`. */
  maxWallMs: number;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  settled: boolean;
  /** Removes the caller's abort listener. */
  detach?: () => void;
  timer?: NodeJS.Timeout;
}

export class EngineClient {
  private readonly options: EngineClientOptions;
  private readonly log: Logger;
  private readonly hardStopGraceMs: number;
  private readonly hostPath: string;
  private worker: Worker | null = null;
  private initialised = false;
  private closed = false;
  private idCounter = 0;
  private queue: Job[] = [];
  private running: Job | null = null;
  private readyPromise: Promise<void> | null = null;
  private readyListeners: Array<() => void> = [];
  private restarts = 0;
  private started = false;
  /** Rejects the readiness promise of a worker still starting. */
  private startReject: ((e: EngineWorkerError) => void) | null = null;

  constructor(options: EngineClientOptions) {
    this.options = options;
    this.log = resolveLogger(options.logger);
    this.hardStopGraceMs =
      options.hardStopGraceMs ?? DEFAULT_HARD_STOP_GRACE_MS;
    this.hostPath =
      options.hostPath ??
      join(dirname(fileURLToPath(import.meta.url)), "worker-host.js");
  }

  /** How many times the worker was replaced since the client was made. */
  get restartCount(): number {
    return this.restarts;
  }

  /** A promise of the current worker being initialised. Starts the worker if
   *  none is running. After a restart it is a new promise. */
  get ready(): Promise<void> {
    return this.ensureWorker();
  }

  /** Calls `listener` after every successful initialisation (the first and
   *  each restart). Returns a function that removes it. */
  onReady(listener: () => void): () => void {
    this.readyListeners.push(listener);
    return () => {
      this.readyListeners = this.readyListeners.filter((l) => l !== listener);
    };
  }

  // --- the engine ----------------------------------------------------------

  status(options?: JobOptions): EngineJob<EngineStatus> {
    return this.submit({ type: "status" }, options) as EngineJob<EngineStatus>;
  }

  route(
    request: RoutingRequest,
    options: RouteJobOptions = {},
  ): EngineJob<RouteResponse> {
    // One copy, for the watchdog and the posted payload alike.
    const budget = options.budget ? { ...options.budget } : undefined;
    const maxWallMs = effectiveBudget(
      this.options.engine.budget,
      budget,
    ).maxWallMs;
    return this.submit(
      { type: "route", request, budget },
      options,
      maxWallMs,
    ) as EngineJob<RouteResponse>;
  }

  /** A whole departure scan, as the full step list (not streamed). One budget
   *  covers all its steps; the hard stop works as for `route`. */
  departures(
    request: RoutingRequest,
    scan: { hours?: number; stepMinutes?: number } = {},
    options: RouteJobOptions = {},
  ): EngineJob<DepartureScanStep[]> {
    const budget = options.budget ? { ...options.budget } : undefined;
    const maxWallMs = effectiveBudget(
      this.options.engine.budget,
      budget,
    ).maxWallMs;
    return this.submit(
      {
        type: "departures",
        request,
        hours: scan.hours,
        stepMinutes: scan.stepMinutes,
        budget,
      },
      options,
      maxWallMs,
    ) as EngineJob<DepartureScanStep[]>;
  }

  pois(
    bbox: PoiBBox,
    limit?: number,
    options?: JobOptions,
  ): EngineJob<PoiBBoxResult[]> {
    return this.submit({ type: "pois", ...bbox, limit }, options) as EngineJob<
      PoiBBoxResult[]
    >;
  }

  search(
    query: string,
    limit?: number,
    options?: JobOptions,
  ): EngineJob<PoiSearchResult[]> {
    return this.submit({ type: "search", query, limit }, options) as EngineJob<
      PoiSearchResult[]
    >;
  }

  nearestPoi(
    lat: number,
    lon: number,
    radiusM?: number,
    options?: JobOptions,
  ): EngineJob<NearestPoiResult> {
    return this.submit(
      { type: "nearestPoi", lat, lon, radiusM },
      options,
    ) as EngineJob<NearestPoiResult>;
  }

  coverage(options?: JobOptions): EngineJob<
    Array<{
      filename: string;
      state: DatabaseCoverageEntry["state"];
      coverage: DatabaseCoverageEntry["bbox"];
      nodes?: number;
      stats: DatabaseCoverageEntry["stats"];
    }>
  > {
    return this.submit({ type: "coverage" }, options) as EngineJob<never>;
  }

  /** GPX of a route the host still holds (by the `resultId` of `route`).
   *  Rejects with `UNKNOWN_RESULT` for any other id. */
  gpx(
    resultId: string,
    name: string,
    provider: ProviderInfo,
    lang?: string | null,
    options?: JobOptions,
  ): EngineJob<string> {
    return this.submit(
      { type: "gpx", resultId, name, provider, lang },
      options,
    ) as EngineJob<string>;
  }

  /** Aborts a job: at once when it is queued; a running one is rejected with
   *  `ABORTED` and the host is told to stop it. A job that is already settled
   *  is left alone. */
  abort(jobId: number): void {
    const queued = this.queue.findIndex((j) => j.id === jobId);
    if (queued >= 0) {
      const [job] = this.queue.splice(queued, 1);
      this.settle(job, undefined, abortedFailure());
      return;
    }
    const job = this.running;
    if (job && job.id === jobId && !job.settled) {
      this.settle(job, undefined, abortedFailure());
      this.worker?.postMessage({ type: "abort", jobId } satisfies HostRequest);
      // The host's slot stays taken until it answers. If it does not, it is
      // hung: replace it.
      this.armHardStop(job, this.hardStopGraceMs);
    }
  }

  /** Stops the host. Jobs still queued are rejected with `CLOSED`. The client
   *  cannot be used afterwards. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const job of this.queue.splice(0)) {
      this.settle(
        job,
        undefined,
        new EngineWorkerError("CLOSED", "The engine client is closed"),
      );
    }
    const worker = this.worker;
    this.worker = null;
    // A worker still starting: whoever waits on `ready` hears it is closed.
    if (this.startReject) {
      const reject = this.startReject;
      this.startReject = null;
      this.readyPromise = null;
      reject(new EngineWorkerError("CLOSED", "The engine client is closed"));
    }
    if (this.running) {
      this.settle(
        this.running,
        undefined,
        new EngineWorkerError("CLOSED", "The engine client is closed"),
      );
      this.clearTimer(this.running);
      this.running = null;
    }
    if (!worker) return;
    if (this.initialised) {
      await Promise.race([
        new Promise<void>((resolve) => {
          const id = ++this.idCounter;
          const onMessage = (m: HostReply): void => {
            if (m.type === "result" && m.id === id) {
              worker.off("message", onMessage);
              resolve();
            }
          };
          worker.on("message", onMessage);
          worker.postMessage({ type: "shutdown", id } satisfies HostRequest);
        }),
        new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_WAIT_MS)),
      ]);
    }
    worker.removeAllListeners();
    await worker.terminate();
  }

  // --- queue ---------------------------------------------------------------

  private submit(
    body: JobBody,
    options: JobOptions | undefined,
    maxWallMs = Infinity,
  ): EngineJob<unknown> {
    const id = ++this.idCounter;
    let job!: Job;
    const promise = new Promise<unknown>((resolve, reject) => {
      job = { id, body, maxWallMs, resolve, reject, settled: false };
    });
    const handle = Object.assign(promise, { jobId: id });
    if (this.closed) {
      this.settle(
        job,
        undefined,
        new EngineWorkerError("CLOSED", "The engine client is closed"),
      );
      return handle;
    }
    const signal = options?.signal;
    if (signal?.aborted) {
      this.settle(job, undefined, abortedFailure());
      return handle;
    }
    if (signal) {
      const onAbort = (): void => this.abort(id);
      signal.addEventListener("abort", onAbort, { once: true });
      job.detach = () => signal.removeEventListener("abort", onAbort);
    }
    this.queue.push(job);
    this.ensureWorker().then(
      () => this.pump(),
      () => undefined, // the failed start rejected the queue itself
    );
    return handle;
  }

  /** Sends the next queued job when the worker is up and idle. */
  private pump(): void {
    const worker = this.worker;
    if (!worker || !this.initialised || this.running || this.closed) return;
    const job = this.queue.shift();
    if (!job) return;
    this.running = job;
    worker.postMessage({ ...job.body, id: job.id } as HostRequest);
    if (Number.isFinite(job.maxWallMs)) {
      this.armHardStop(job, job.maxWallMs + this.hardStopGraceMs);
    }
  }

  private armHardStop(job: Job, afterMs: number): void {
    this.clearTimer(job);
    job.timer = setTimeout(() => {
      if (this.running === job) {
        this.log.error(
          `[routeiq] The engine host did not finish job ${job.id} in time; replacing it`,
        );
        this.replaceWorker(
          new EngineWorkerError(
            "WORKER_RESTARTED",
            "The engine worker was stopped and replaced because a job did not finish in time",
          ),
        );
      }
    }, afterMs);
    job.timer.unref?.();
  }

  private clearTimer(job: Job): void {
    if (job.timer) clearTimeout(job.timer);
    job.timer = undefined;
  }

  /** Settles a job once; later settlements are ignored. */
  private settle(job: Job, value: unknown, error?: unknown): void {
    if (job.settled) return;
    job.settled = true;
    job.detach?.();
    if (error !== undefined) job.reject(error);
    else job.resolve(value);
  }

  // --- worker --------------------------------------------------------------

  /** The current worker's readiness, starting one when there is none. */
  private ensureWorker(): Promise<void> {
    if (this.closed) {
      return Promise.reject(
        new EngineWorkerError("CLOSED", "The engine client is closed"),
      );
    }
    if (!this.readyPromise) this.readyPromise = this.startWorker();
    return this.readyPromise;
  }

  private startWorker(): Promise<void> {
    const worker = new Worker(this.hostPath);
    if (this.started) this.restarts++;
    this.started = true;
    this.worker = worker;
    this.initialised = false;
    const initId = ++this.idCounter;
    const init: InitRequest = {
      type: "init",
      id: initId,
      protocolVersion: this.options.protocolVersion ?? PROTOCOL_VERSION,
      engine: this.options.engine,
      database: this.options.database,
      generation: randomBytes(8).toString("hex"),
      ...(this.options.providers ? { providers: this.options.providers } : {}),
      ...(this.options.retainedResults !== undefined
        ? { retainedResults: this.options.retainedResults }
        : {}),
      ...(this.options.testHooks ? { testHooks: this.options.testHooks } : {}),
    };

    return new Promise<void>((resolve, reject) => {
      this.startReject = reject;
      const failStart = (error: EngineWorkerError): void => {
        if (this.worker !== worker) return;
        this.worker = null;
        this.readyPromise = null;
        this.startReject = null;
        worker.removeAllListeners();
        worker.terminate().catch(() => undefined);
        // Nobody can be served: queued jobs get the reason, the next call
        // tries again.
        for (const job of this.queue.splice(0)) {
          this.settle(job, undefined, error);
        }
        reject(error);
      };

      worker.on("message", (msg: HostReply) => {
        if (this.worker !== worker) return;
        if (msg.type === "log") {
          const level = LOG_LEVELS.find((l) => l === msg.level) ?? "info";
          this.log[level](String(msg.message ?? ""), msg.meta);
          return;
        }
        if (msg.type !== "result") return;
        if (msg.id === initId) {
          if (msg.ok) {
            this.initialised = true;
            this.startReject = null;
            resolve();
            for (const listener of [...this.readyListeners]) listener();
            this.pump();
          } else {
            failStart(initError(msg.error));
          }
          return;
        }
        this.onResult(msg);
      });
      worker.on("error", (err) => {
        this.onWorkerGone(
          worker,
          new EngineWorkerError(
            "WORKER_EXITED",
            `The engine worker failed: ${err instanceof Error ? err.message : String(err)}`,
          ),
          failStart,
        );
      });
      worker.on("exit", (code) => {
        this.onWorkerGone(
          worker,
          new EngineWorkerError(
            "WORKER_EXITED",
            `The engine worker exited (code ${code})`,
          ),
          failStart,
        );
      });
      worker.postMessage(init);
    });
  }

  private onResult(msg: Extract<HostReply, { type: "result" }>): void {
    const job = this.running;
    if (!job || job.id !== msg.id) return;
    this.clearTimer(job);
    this.running = null;
    if (msg.ok) this.settle(job, msg.value);
    else this.settle(job, undefined, rethrow(msg.error));
    this.pump();
  }

  /** The worker ended without being asked to. */
  private onWorkerGone(
    worker: Worker,
    error: EngineWorkerError,
    failStart: (e: EngineWorkerError) => void,
  ): void {
    if (this.worker !== worker) return;
    if (!this.initialised) {
      failStart(
        new EngineWorkerError("INIT_FAILED", `${error.message} during start`),
      );
      return;
    }
    this.log.error(`[routeiq] ${error.message}`);
    this.dropWorker(worker, error);
    // Lazily: a fresh worker starts with the next call, or now when jobs wait.
    if (this.queue.length > 0 && !this.closed) {
      this.ensureWorker().then(
        () => this.pump(),
        () => undefined,
      );
    }
  }

  /** Ends the worker and rejects the job it was running. Queued jobs stay. */
  private dropWorker(worker: Worker, error: EngineWorkerError): void {
    this.worker = null;
    this.initialised = false;
    this.readyPromise = null;
    worker.removeAllListeners();
    worker.terminate().catch(() => undefined);
    const job = this.running;
    this.running = null;
    if (job) {
      this.clearTimer(job);
      this.settle(job, undefined, error);
    }
  }

  /** Hard stop: terminate, reject the running job, start and initialise a new
   *  worker (eagerly, so `ready` and `onReady` report it). */
  private replaceWorker(error: EngineWorkerError): void {
    const worker = this.worker;
    if (!worker) return;
    this.dropWorker(worker, error);
    if (this.closed) return;
    this.ensureWorker().then(
      () => this.pump(),
      () => undefined,
    );
  }
}

function abortedFailure(): RouteFailure {
  return RouteFailure.create("ABORTED", {});
}

function initError(error: WireError | undefined): EngineWorkerError {
  const code = error?.code;
  return new EngineWorkerError(
    code === "PROTOCOL_MISMATCH" ? "PROTOCOL_MISMATCH" : "INIT_FAILED",
    error?.message ?? "The engine host could not be initialised",
  );
}

/** The error a wire failure stands for. */
function rethrow(error: WireError | undefined): Error {
  if (!error) return new EngineWorkerError("HOST_ERROR", "The host failed");
  if (error.failure) {
    const code = error.code as ConstructorParameters<typeof RouteFailure>[0];
    if (code === "VESSEL_INCOMPLETE" || code === "INVALID_REQUEST") {
      return new RouteRequestError(code, error.params, error.message);
    }
    return new RouteFailure(
      code,
      error.params,
      error.message,
      error.blocking,
      error.catalogued === true,
    );
  }
  return new EngineWorkerError(
    error.code as EngineWorkerErrorCode,
    error.message,
  );
}
