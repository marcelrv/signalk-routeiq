/**
 * Budget and cancellation of one request.
 *
 * A request (a route, or a whole departure scan) gets one `RequestControl`. It
 * counts the A* node expansions and the wall time over the WHOLE request:
 * every bounding-box retry, every via leg, every step of a scan, line-of-sight
 * smoothing. The engine asks it at the A* loop's yield point and between
 * retries, legs and steps; when it says stop, the request ends with a
 * `RouteFailure` (`BUDGET_EXCEEDED` or `ABORTED`).
 *
 * Limits come from `EngineOptions.budget`; a request may pass its own through
 * `RouteCallOptions.budget`, which can only lower them. Unlimited is
 * `Infinity` (or absent).
 */

import type { FailureCode } from "./codes.js";
import { RouteFailure } from "./failure.js";

/** What one request may spend. Absent or `Infinity` = no limit. */
export interface SearchBudget {
  /** A* node expansions, summed over every search of the request. */
  maxIterations: number;
  /** Milliseconds of wall time since the request started. */
  maxWallMs: number;
}

/** The second argument of `calculateRoute`, `streamDepartures` and
 *  `scanDepartures`. */
export interface RouteCallOptions {
  /** Limits for this request; each can only lower the engine's own. */
  budget?: Partial<SearchBudget>;
  /** Aborts the request: it ends with `ABORTED` at the next check. */
  signal?: AbortSignal;
}

export type BudgetLimit = keyof SearchBudget;

export const UNLIMITED_BUDGET: SearchBudget = Object.freeze({
  maxIterations: Infinity,
  maxWallMs: Infinity,
});

function limitOf(v: number | undefined): number {
  return typeof v === "number" && !Number.isNaN(v) && v >= 0 ? v : Infinity;
}

/**
 * The effective budget: the engine's value, lowered by the request's when that
 * is lower. A missing, negative or NaN value is "no limit" and never raises
 * the other.
 */
export function effectiveBudget(
  engine: Partial<SearchBudget> | undefined,
  request: Partial<SearchBudget> | undefined,
): SearchBudget {
  return {
    maxIterations: Math.min(
      limitOf(engine?.maxIterations),
      limitOf(request?.maxIterations),
    ),
    maxWallMs: Math.min(
      limitOf(engine?.maxWallMs),
      limitOf(request?.maxWallMs),
    ),
  };
}

/** Why a request has to stop, before any text is made of it. */
export interface StopReason {
  code: Extract<FailureCode, "BUDGET_EXCEEDED" | "ABORTED">;
  params: Record<string, unknown>;
}

/** Thrown by `RequestControl.race` when the request has to stop. */
export class StopRequested extends Error {
  constructor(readonly stop: StopReason) {
    super(stop.code);
    this.name = "StopRequested";
  }
}

export class RequestControl {
  readonly budget: SearchBudget;
  readonly signal: AbortSignal | undefined;
  private readonly startedAt = performance.now();
  private expanded = 0;

  constructor(budget: SearchBudget, signal?: AbortSignal) {
    this.budget = budget;
    this.signal = signal;
  }

  /** Node expansions counted so far. */
  get iterations(): number {
    return this.expanded;
  }

  /** Milliseconds since the request started. */
  get elapsedMs(): number {
    return performance.now() - this.startedAt;
  }

  /** Counts one A* node expansion; a stop reason once the iteration limit is
   *  passed. Cheap enough for every iteration. */
  expand(): StopReason | null {
    if (++this.expanded > this.budget.maxIterations) {
      return this.over("maxIterations", this.expanded);
    }
    return null;
  }

  /** Abort and wall time. Not for every iteration. */
  check(): StopReason | null {
    if (this.signal?.aborted) return { code: "ABORTED", params: {} };
    if (this.expanded > this.budget.maxIterations) {
      return this.over("maxIterations", this.expanded);
    }
    const elapsed = this.elapsedMs;
    if (elapsed > this.budget.maxWallMs) {
      return this.over("maxWallMs", Math.round(elapsed));
    }
    return null;
  }

  /**
   * Waits for `work`, but no longer than the request may run: an abort or the
   * wall-time limit ends the wait by rejecting with a `StopRequested` (the
   * pending work is ignored, its late result or error dropped). Without a
   * signal and a finite wall limit this is `work` itself.
   */
  race<T>(work: Promise<T>): Promise<T> {
    const wallLimited = Number.isFinite(this.budget.maxWallMs);
    if (!this.signal && !wallLimited) return work;
    // A late settlement of the abandoned work must not be an unhandled rejection.
    work.catch(() => undefined);
    return new Promise<T>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const signal = this.signal;
      const finish = (): void => {
        if (timer) clearTimeout(timer);
        signal?.removeEventListener("abort", onStop);
      };
      const onStop = (): void => {
        finish();
        const stop =
          this.check() ?? this.over("maxWallMs", Math.round(this.elapsedMs));
        reject(new StopRequested(stop));
      };
      const early = this.check();
      if (early) {
        reject(new StopRequested(early));
        return;
      }
      signal?.addEventListener("abort", onStop, { once: true });
      if (wallLimited) {
        const remaining = Math.max(0, this.budget.maxWallMs - this.elapsedMs);
        timer = setTimeout(onStop, remaining + 1);
        timer.unref?.();
      }
      work.then(
        (v) => {
          finish();
          resolve(v);
        },
        (e) => {
          finish();
          reject(e);
        },
      );
    });
  }

  private over(limit: BudgetLimit, used: number): StopReason {
    return {
      code: "BUDGET_EXCEEDED",
      params: { limit, used, max: this.budget[limit] },
    };
  }
}

/** Whether `e` is a request stopped by its budget or an abort. Such a failure
 *  ends the whole request: nothing retries, widens or falls back on it. */
export function isStopFailure(e: unknown): e is RouteFailure {
  return (
    e instanceof RouteFailure &&
    (e.code === "BUDGET_EXCEEDED" || e.code === "ABORTED")
  );
}
