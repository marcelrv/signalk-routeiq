/**
 * `RoutingStore` + `OverlayStore` over SQLite files, with all SQLite I/O in a
 * worker thread (db-worker.ts) so a large load never blocks the main thread.
 *
 * The worker and its message protocol are the original ones; this class is the
 * client side of it: one request per call, replies matched by id, chunked
 * replies (the edge load) reassembled. The worker starts with the first call
 * and ends with `close()`; a closed store starts afresh on its next call.
 *
 * If the worker dies on its own (an uncaught error, an exit), every call still
 * waiting is rejected and the store refuses further calls until it is
 * re-initialised (`openAll`) or closed. It never restarts a worker silently:
 * the new one would know none of the open files or loaded indexes the callers
 * still hold.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { DescribeWorkerResult } from "./route-description.js";
import { LOG_LEVELS, resolveLogger, type Logger } from "./logger.js";
import {
  GraphEditError,
  type DescribePair,
  type LoadSelector,
  type OpenAllResult,
  type OpenedFile,
  type OverlayEdgeValues,
  type OverlayStats,
  type OverlayStore,
  type PeekedFile,
  type RefusedFile,
  type RegionMetadata,
  type RegionStats,
  type RoutePoiAnswer,
  type RoutePoiQuery,
  type RoutingStore,
  type StoreEdgeRow,
  type StoreNavmeshRow,
  type StoreNodeRow,
  type StorePoiRow,
} from "./routing-store.js";

/** What the read-only probe saw when it opened a file that does not exist
 *  with `{ readOnly: true }`. */
export interface ReadOnlyProbeOutcome {
  /** The open threw (a read-only open of a missing file must). */
  threw: boolean;
  /** A file appeared at the path (a read-write open creates it). */
  created: boolean;
}

/** Whether the probe outcome shows `readOnly` is honoured: the open refused
 *  and nothing was created. A node:sqlite that ignores the option (22.5.0)
 *  opens read-write and creates the file. */
export function readOnlyHonoured(outcome: ReadOnlyProbeOutcome): boolean {
  return outcome.threw && !outcome.created;
}

let readOnlySupport: boolean | null = null;

/** One-time probe, in a temporary directory, of whether this Node's
 *  node:sqlite honours `readOnly`. */
export function nodeSqliteSupportsReadOnly(): boolean {
  if (readOnlySupport !== null) return readOnlySupport;
  const dir = mkdtempSync(join(tmpdir(), "routeiq-ro-probe-"));
  const file = join(dir, "probe.sqlite");
  const outcome: ReadOnlyProbeOutcome = { threw: false, created: false };
  try {
    try {
      new DatabaseSync(file, { readOnly: true }).close();
    } catch {
      outcome.threw = true;
    }
    outcome.created = existsSync(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  readOnlySupport = readOnlyHonoured(outcome);
  return readOnlySupport;
}

export interface SqliteWorkerStoreOptions {
  /** Open region files read-only (node:sqlite `readOnly`), never open an
   *  overlay, and refuse every graph edit with a `GraphEditError`
   *  (`READ_ONLY`). Nothing is written anywhere. */
  readOnly?: boolean;
  /** Receives what the worker thread logs. Default: silent. */
  logger?: Logger;
}

export class SqliteWorkerStore implements RoutingStore, OverlayStore {
  private worker: Worker | null = null;
  /** The close in flight; overlapping `close()` calls share it, and calls
   *  made while it runs wait for it, then use a fresh worker. */
  private closing: Promise<void> | null = null;
  /** Set when the worker stopped without being closed: why. */
  private deadReason: Error | null = null;
  private messageIdCounter = 0;
  private readonly readOnly: boolean;
  private readonly log: Logger;
  private pending = new Map<
    number,
    {
      resolve: (value: any) => void;
      reject: (reason: any) => void;
      // Accumulated rows of a chunked reply; absent until the first chunk lands,
      // which is what distinguishes a zero-row final marker from a finished one.
      chunks?: unknown[][];
    }
  >();

  constructor(options: SqliteWorkerStoreOptions = {}) {
    this.readOnly = options.readOnly === true;
    this.log = resolveLogger(options.logger);
    if (this.readOnly && !nodeSqliteSupportsReadOnly()) {
      throw new Error(
        `Read-only mode is not available: this Node.js (${process.version}) opens SQLite files read-write even when asked for read-only. Use a newer Node.js.`,
      );
    }
  }

  private start(): Worker {
    if (this.worker) return this.worker;
    const workerPath = join(
      dirname(fileURLToPath(import.meta.url)),
      "db-worker.js",
    );
    const worker = new Worker(workerPath);
    this.worker = worker;

    worker.on(
      "message",
      (msg: {
        id: number;
        type: string;
        result?: any;
        error?: string;
        chunk?: boolean;
        chunkIndex?: number;
        totalChunks?: number;
        level?: string;
        message?: string;
        meta?: Record<string, unknown>;
      }) => {
        // A log line from the worker, not a reply: hand it to the logger.
        if (msg.type === "log") {
          const level = LOG_LEVELS.find((l) => l === msg.level) ?? "info";
          this.log[level](String(msg.message ?? ""), msg.meta);
          return;
        }
        const pending = this.pending.get(msg.id);
        if (!pending) return;

        if (msg.error) {
          this.pending.delete(msg.id);
          pending.reject(new Error(msg.error));
          return;
        }

        // Edge-loading chunked response
        if (msg.chunk === true && msg.totalChunks !== undefined) {
          // Initialize accumulator on first chunk
          if (!pending.chunks) {
            pending.chunks = [];
          }
          pending.chunks.push(msg.result);
          // Resolve when all chunks arrive
          if (pending.chunks.length === msg.totalChunks) {
            this.pending.delete(msg.id);
            pending.resolve(pending.chunks.flat());
          }
          return;
        }
        // Final marker (chunk=false) — normally already resolved by the last
        // chunk above. Exception: zero rows means the worker's chunk loop never
        // ran and this marker is the *only* message sent — resolve here with an
        // empty array, or this promise (and loadGraph() with it) hangs forever.
        if (msg.chunk === false) {
          if (!pending.chunks) {
            this.pending.delete(msg.id);
            pending.resolve([]);
          }
          return;
        }

        this.pending.delete(msg.id);
        pending.resolve(msg.result);
      },
    );

    // An uncaught error in the worker is followed by its exit; either one
    // ends it. A worker `close()` already let go of is not a failure.
    worker.on("error", (err) => this.workerStopped(worker, err));
    worker.on("exit", (code) =>
      this.workerStopped(
        worker,
        new Error(`The database worker exited unexpectedly (code ${code})`),
      ),
    );

    // The worker's own switch: every file it opens is opened read-only.
    worker.postMessage({
      id: 0,
      type: "configure",
      payload: { readOnly: this.readOnly },
    });
    return worker;
  }

  /** The worker stopped by itself: fail what waits on it and refuse more
   *  until the store is initialised again. */
  private workerStopped(worker: Worker, cause: Error): void {
    if (this.worker !== worker) return;
    this.worker = null;
    this.deadReason = cause;
    this.log.error(`[routeiq] ${cause.message}`);
    for (const [, p] of this.pending) p.reject(cause);
    this.pending.clear();
    worker.terminate().catch(() => undefined);
  }

  /** Whether the worker stopped on its own and the store has not been
   *  initialised or closed since. */
  get dead(): boolean {
    return this.deadReason !== null;
  }

  private send(type: string, payload?: any): Promise<any> {
    if (this.closing) {
      return this.closing.then(() => this.send(type, payload));
    }
    // `init` (openAll) is the re-initialisation: it forgets the dead worker
    // and starts a new one. Anything else would talk to state that is gone.
    if (this.deadReason) {
      if (type === "init") this.deadReason = null;
      else {
        return Promise.reject(
          new Error(
            `The database worker is not running (${this.deadReason.message}); the store must be initialised again`,
          ),
        );
      }
    }
    return this.sendToWorker(type, payload);
  }

  private sendToWorker(type: string, payload?: any): Promise<any> {
    const worker = this.start();
    return new Promise((resolve, reject) => {
      const id = ++this.messageIdCounter;
      this.pending.set(id, { resolve, reject });
      worker.postMessage({ id, type, payload });
    });
  }

  // --- RoutingStore -------------------------------------------------------

  openAll(paths: string[]): Promise<OpenAllResult> {
    return this.send("init", { dbPaths: paths });
  }

  peekMetadata(paths: string[]): Promise<PeekedFile[]> {
    return this.send("peekMetadata", { dbPaths: paths });
  }

  openDb(path: string): Promise<OpenedFile | RefusedFile> {
    return this.send("openDb", { dbPath: path });
  }

  async closeDb(dbIndex: number): Promise<void> {
    await this.send("closeDb", { dbIndex });
  }

  loadNodes(selector?: LoadSelector): Promise<StoreNodeRow[]> {
    return this.send("loadNodes", selector);
  }

  loadEdges(selector?: LoadSelector): Promise<StoreEdgeRow[]> {
    return this.send("loadEdges", selector);
  }

  loadPois(selector?: { dbIndexes?: number[] }): Promise<StorePoiRow[]> {
    return this.send("loadPois", selector);
  }

  loadNavmeshRegions(selector?: {
    dbIndexes?: number[];
  }): Promise<StoreNavmeshRow[]> {
    return this.send("loadNavmeshRegions", selector);
  }

  getMetadata(): Promise<Array<RegionMetadata & { stats: RegionStats }>> {
    return this.send("getMetadata");
  }

  describeRoute(
    pairs: DescribePair[],
    lang?: string,
  ): Promise<DescribeWorkerResult> {
    return this.send("describeRoute", { pairs, lang });
  }

  poiInfo(ids: number[]): Promise<Record<string, Record<string, unknown>>> {
    return this.send("poiInfo", { ids });
  }

  routePois(pairs: RoutePoiQuery[]): Promise<RoutePoiAnswer[]> {
    return this.send("routePois", { pairs });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    const closing = this.closeWorker().finally(() => {
      if (this.closing === closing) this.closing = null;
    });
    this.closing = closing;
    return closing;
  }

  private async closeWorker(): Promise<void> {
    // A dead store is closed: the next call starts afresh, as after any close.
    this.deadReason = null;
    const worker = this.worker;
    if (!worker) return;
    try {
      await Promise.race([
        this.sendToWorker("close"),
        new Promise((resolve) => setTimeout(resolve, 5000)),
      ]);
    } catch {
      /* worker may already be dead */
    }
    // Anything still waiting is answered with a failure rather than left
    // hanging on a worker that no longer exists.
    for (const [, p] of this.pending) p.reject(new Error("Store closed"));
    this.pending.clear();
    this.worker = null;
    worker.terminate();
    // Last, so a worker that exited while closing leaves no dead state.
    this.deadReason = null;
  }

  // --- OverlayStore -------------------------------------------------------

  private refuseWriteWhenReadOnly(): void {
    if (this.readOnly) throw new GraphEditError("READ_ONLY");
  }

  async openOverlay(path: string): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("openOverlay", { overlayPath: path });
  }

  async getDeletedNodeIds(): Promise<number[]> {
    // Without an open overlay the worker answers [] (nothing was deleted).
    return this.send("getDeletedNodeIds");
  }

  async getDeletedEdgePairs(): Promise<
    Array<{ source: number; target: number }>
  > {
    return this.send("getDeletedEdgePairs");
  }

  async getOverlayStats(): Promise<OverlayStats> {
    return this.send("getOverlayStats");
  }

  async updateNode(args: {
    dbIndex: number;
    nodeId: number;
    lat: number;
    lon: number;
    node_depth: number;
  }): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("updateNode", args);
  }

  async updateEdge(
    args: {
      dbIndex: number;
      source: number;
      target: number;
    } & OverlayEdgeValues,
  ): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("updateEdge", args);
  }

  async deleteNode(args: { dbIndex: number; nodeId: number }): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("deleteNode", args);
  }

  async deleteEdge(args: {
    dbIndex: number;
    source: number;
    target: number;
  }): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("deleteEdge", args);
  }

  async clearOverlayDeletedEdges(): Promise<{ restored: number }> {
    this.refuseWriteWhenReadOnly();
    return this.send("clearOverlayDeletedEdges");
  }

  async insertNode(args: {
    dbIndex: number;
    id: number;
    lat: number;
    lon: number;
    node_depth?: number;
  }): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("insertNode", args);
  }

  async insertEdge(
    args: {
      dbIndex: number;
      source: number;
      target: number;
      distance: number;
    } & OverlayEdgeValues,
  ): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("insertEdge", args);
  }
}
