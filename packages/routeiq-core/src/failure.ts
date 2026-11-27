/**
 * Structured route failures.
 *
 * A route request that cannot be answered throws a `RouteFailure`: a stable
 * `code` (codes.ts: `FAILURE_CODES`), the `params` that word it, an optional
 * `blocking` list, and a `message` rendered from the catalogue (English unless
 * the engine's message language says otherwise). The message never carries a
 * file path, SQL, a stack trace or an internal id; that detail goes to the
 * logger.
 *
 * `RouteSearchError` (the A* search itself failed; the bounding-box loop widens
 * the box and retries on it) and `RouteRequestError` (the request is refused
 * before searching) are subclasses, so existing `instanceof` checks keep
 * working. A plain `RouteFailure` is a failure that ends the request.
 *
 * `name` is left as `"Error"` on a plain RouteFailure, as it was when these
 * were plain errors, so nothing that matches on it changes.
 */

import type { FailureCode } from "./codes.js";
import { formatFailure, type MessageParams } from "./messages.js";

/**
 * A cause the engine already knew when it gave up. Filled only from what the
 * search itself tallied; nothing is analysed afterwards to produce it.
 */
export interface BlockingCause {
  /** The structure (lock, bridge, harbour) in the way, as an opaque id. */
  poiId?: string;
  name?: string;
  position?: { latitude: number; longitude: number };
  /** Which vessel dimension the water or structure did not allow. */
  dimension?: "draft" | "beam" | "airDraft";
  /** The vessel's own value of it (m). */
  value?: number;
  /** What the route needed to be clear (m): the dimension plus its margin. */
  need?: number;
}

/** What a client gets of a failure, apart from the message. */
export interface FailureInfo {
  code: FailureCode;
  params: MessageParams;
  blocking?: BlockingCause[];
}

export class RouteFailure extends Error {
  readonly code: FailureCode;
  readonly params: MessageParams;
  readonly blocking?: BlockingCause[];
  /** Whether `message` is the catalogue's rendering of `code` + `params`
   *  (made by `create`), so a reader can render it again in its own language.
   *  False for a failure built from a ready-made message. */
  readonly catalogued: boolean;

  constructor(
    code: FailureCode,
    params: MessageParams,
    message: string,
    blocking?: BlockingCause[],
    catalogued = false,
  ) {
    super(message);
    this.code = code;
    this.params = params;
    this.catalogued = catalogued;
    if (blocking && blocking.length > 0) this.blocking = blocking;
  }

  /** A failure with its message rendered from the catalogue in `lang`. */
  static create(
    code: FailureCode,
    params: MessageParams,
    lang?: string | null,
    blocking?: BlockingCause[],
  ): RouteFailure {
    return new RouteFailure(
      code,
      params,
      formatFailure(code, params, lang),
      blocking,
      true,
    );
  }

  /** `code`, `params` and `blocking`, ready to put in a response body. */
  get failure(): FailureInfo {
    return {
      code: this.code,
      params: this.params,
      ...(this.blocking ? { blocking: this.blocking } : {}),
    };
  }
}

/**
 * A failure of the A* search itself (no routing node near a point, start
 * outside the box, no path found). calculateRouteImpl's bounding-box loop
 * retries with a wider box on this and keeps the last one for its final
 * message; any other error is a bug and propagates.
 *
 * `new RouteSearchError("text")` reads as a `NO_PATH` failure with that text.
 */
export class RouteSearchError extends RouteFailure {
  constructor(
    message: string,
    code: FailureCode = "NO_PATH",
    params: MessageParams = {},
    blocking?: BlockingCause[],
    catalogued = false,
  ) {
    super(code, params, message, blocking, catalogued);
    this.name = "RouteSearchError";
  }

  static override create(
    code: FailureCode,
    params: MessageParams,
    lang?: string | null,
    blocking?: BlockingCause[],
  ): RouteSearchError {
    return new RouteSearchError(
      formatFailure(code, params, lang),
      code,
      params,
      blocking,
      true,
    );
  }
}

/** The failure info of any thrown value: its own when it is a RouteFailure. */
export function failureInfo(e: unknown): FailureInfo | undefined {
  return e instanceof RouteFailure ? e.failure : undefined;
}

/** The cause recorded for an error that is not a catalogued failure: a
 *  neutral one. Its own text may hold paths or SQL, so it is never put in
 *  `params` or a message; the caller logs it. */
export const INTERNAL_CAUSE: MessageParams = {
  code: "NO_PATH",
  params: { reason: "internal" },
};

/** A cause for `params.cause`: `{ code, params }` of a catalogued failure,
 *  rendered again in the reader's language; anything else is the neutral
 *  internal cause (see INTERNAL_CAUSE). */
export function causeOf(e: unknown): MessageParams {
  if (e instanceof RouteFailure && e.catalogued) {
    return { code: e.code, params: e.params };
  }
  return INTERNAL_CAUSE;
}

/** Whether `causeOf(e)` has to fall back to the internal cause. */
export function isInternalCause(e: unknown): boolean {
  return !(e instanceof RouteFailure && e.catalogued);
}
