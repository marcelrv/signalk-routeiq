/**
 * Cumulative counters of what an engine has done, for observability.
 *
 * They hold numbers only: nothing per request, no coordinates, no names. A host
 * reads a snapshot with `RoutingEngine.getCounters()` whenever it likes (a
 * status page, a metrics scrape, a test). The counters start at zero with the
 * engine and only grow.
 */

import { FAILURE_CODES, type FailureCode } from "./codes.js";

/** A running total and how many things went into it. */
export interface SumCount {
  sum: number;
  count: number;
}

/** One loaded routing region, with what it costs to hold in memory. */
export interface RegionMemory {
  filename: string;
  nodes: number;
  edges: number;
  pois: number;
  /** A planning figure from the region's row counts, not a measurement. */
  estimatedBytes: number;
}

export interface EngineCounters {
  routes: {
    /** Route calculations that returned a route (a departure scan counts one
     *  per step). */
    calculated: number;
    /** Route calculations that threw. */
    failed: number;
  };
  /** Failures by `RouteFailure.code`; every code is present. */
  failuresByCode: Record<FailureCode, number>;
  /** Failures that were not a `RouteFailure` (a bug or an I/O error). */
  failuresOther: number;
  /** Calculations stopped by a budget. No budget exists yet, so always 0. */
  budgetHits: number;
  search: {
    /** A* iterations, summed over searches. */
    iterations: SumCount;
    /** Milliseconds spent in the A* loop, summed over searches. */
    timeMs: SumCount;
  };
  regions: {
    /** Regions loaded into memory since the database opened (a region
     *  evicted and loaded again counts twice). */
    loadsTotal: number;
    /** The regions in memory now. */
    loaded: RegionMemory[];
    /** Sum of `estimatedBytes` over `loaded`. */
    estimatedBytes: number;
  };
}

/** The mutable side of the counters, owned by one engine. */
export class CounterSet {
  private calculated = 0;
  private failed = 0;
  private readonly byCode: Record<FailureCode, number>;
  private other = 0;
  private budget = 0;
  private iterations: SumCount = { sum: 0, count: 0 };
  private timeMs: SumCount = { sum: 0, count: 0 };

  constructor() {
    this.byCode = Object.fromEntries(
      FAILURE_CODES.map((c) => [c, 0]),
    ) as Record<FailureCode, number>;
  }

  routeCalculated(): void {
    this.calculated++;
  }

  /** `code` is the failure's code, or undefined for any other error. */
  routeFailed(code: FailureCode | undefined): void {
    this.failed++;
    if (code === undefined) this.other++;
    else {
      this.byCode[code]++;
      if (code === "BUDGET_EXCEEDED") this.budget++;
    }
  }

  searchDone(iterations: number, ms: number): void {
    this.iterations.sum += iterations;
    this.iterations.count++;
    this.timeMs.sum += ms;
    this.timeMs.count++;
  }

  snapshot(regions: EngineCounters["regions"]): EngineCounters {
    return {
      routes: { calculated: this.calculated, failed: this.failed },
      failuresByCode: { ...this.byCode },
      failuresOther: this.other,
      budgetHits: this.budget,
      search: {
        iterations: { ...this.iterations },
        timeMs: { ...this.timeMs },
      },
      regions,
    };
  }
}
