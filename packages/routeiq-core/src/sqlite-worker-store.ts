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
  /** Handles (`dbIndex`) are numbered across the store's whole life: the next
   *  index the worker will hand out, and the first index of the current
   *  generation (a worker start or an `init`). A handle below `indexBase`
   *  belongs to a file set that is gone and is refused, so it can never
   *  select another file after a reopen. */
  private nextIndex = 0;
  private indexBase = 0;
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
    this.indexBase = this.nextIndex;
    worker.postMessage({
      id: 0,
      type: "configure",
      payload: { readOnly: this.readOnly, indexBase: this.indexBase },
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

  /** Refuses a handle from before the current generation. */
  private checkHandles(handles: Array<number | undefined> | undefined): void {
    for (const h of handles ?? []) {
      if (typeof h === "number" && h >= 0 && h < this.indexBase) {
        throw new Error(
          `Stale database handle ${h}: the store was closed or re-initialised since it was issued`,
        );
      }
    }
  }

  private send(
    type: string,
    payload?: any,
    handles?: Array<number | undefined>,
  ): Promise<any> {
    if (this.closing) {
      return this.closing.then(() => this.send(type, payload, handles));
    }
    try {
      this.checkHandles(handles);
    } catch (e) {
      return Promise.reject(e);
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

  async openAll(paths: string[]): Promise<OpenAllResult> {
    // Every earlier handle ends here: the new set is numbered from where the
    // old ones stopped.
    const indexBase = this.nextIndex;
    const result: OpenAllResult = await this.send("init", {
      dbPaths: paths,
      indexBase,
    });
    this.indexBase = Math.max(this.indexBase, indexBase);
    this.nextIndex = Math.max(
      this.nextIndex,
      indexBase + result.filenames.length,
    );
    return result;
  }

  peekMetadata(paths: string[]): Promise<PeekedFile[]> {
    return this.send("peekMetadata", { dbPaths: paths });
  }

  async openDb(path: string): Promise<OpenedFile | RefusedFile> {
    const result: OpenedFile | RefusedFile = await this.send("openDb", {
      dbPath: path,
    });
    if ("dbIndex" in result) {
      this.nextIndex = Math.max(this.nextIndex, result.dbIndex + 1);
    }
    return result;
  }

  async closeDb(dbIndex: number): Promise<void> {
    await this.send("closeDb", { dbIndex }, [dbIndex]);
  }

  loadNodes(selector?: LoadSelector): Promise<StoreNodeRow[]> {
    return this.send("loadNodes", selector, selector?.dbIndexes);
  }

  loadEdges(selector?: LoadSelector): Promise<StoreEdgeRow[]> {
    return this.send("loadEdges", selector, selector?.dbIndexes);
  }

  loadPois(selector?: { dbIndexes?: number[] }): Promise<StorePoiRow[]> {
    return this.send("loadPois", selector, selector?.dbIndexes);
  }

  loadNavmeshRegions(selector?: {
    dbIndexes?: number[];
  }): Promise<StoreNavmeshRow[]> {
    return this.send("loadNavmeshRegions", selector, selector?.dbIndexes);
  }

  getMetadata(): Promise<Array<RegionMetadata & { stats: RegionStats }>> {
    return this.send("getMetadata");
  }

  describeRoute(
    pairs: DescribePair[],
    lang?: string,
  ): Promise<DescribeWorkerResult> {
    return this.send(
      "describeRoute",
      { pairs, lang },
      pairs.map((p) => p.dbIndex),
    );
  }

  poiInfo(ids: number[]): Promise<Record<string, Record<string, unknown>>> {
    return this.send("poiInfo", { ids });
  }

  routePois(pairs: RoutePoiQuery[]): Promise<RoutePoiAnswer[]> {
    return this.send(
      "routePois",
      { pairs },
      pairs.flatMap((p) => p.dbIndexes ?? []),
    );
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
    // Every handle issued so far ends here, whether or not a worker ran.
    this.deadReason = null;
    this.indexBase = this.nextIndex;
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
    await this.send("updateNode", args, [args.dbIndex]);
  }

  async updateEdge(
    args: {
      dbIndex: number;
      source: number;
      target: number;
    } & OverlayEdgeValues,
  ): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("updateEdge", args, [args.dbIndex]);
  }

  async deleteNode(args: { dbIndex: number; nodeId: number }): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("deleteNode", args, [args.dbIndex]);
  }

  async deleteEdge(args: {
    dbIndex: number;
    source: number;
    target: number;
  }): Promise<void> {
    this.refuseWriteWhenReadOnly();
    await this.send("deleteEdge", args, [args.dbIndex]);
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
    await this.send("insertNode", args, [args.dbIndex]);
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
    await this.send("insertEdge", args, [args.dbIndex]);
  }
}
