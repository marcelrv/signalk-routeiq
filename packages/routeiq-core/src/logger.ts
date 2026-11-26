/**
 * Logging for the engine.
 *
 * The core never writes to the console: everything it has to say goes through a
 * `Logger` the host injects (`EngineOptions.logger`,
 * `RoutingDatabaseOptions.logger`, `SqliteWorkerStoreOptions.logger`). The
 * default is silent.
 *
 * What may be logged at which level:
 *   - `info` and above never carry route coordinates, request bodies or names a
 *     user typed. File names, counts, timings and error causes are fine.
 *   - Anything that locates a route or a position (a vessel position, a node id,
 *     which encodes its coordinates) is `debug`.
 * A host that wants a quiet log can drop `debug`; the core makes no other use
 * of the level.
 */

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export const LOG_LEVELS: readonly LogLevel[] = [
  "debug",
  "info",
  "warn",
  "error",
];

const noop = (): void => {};

/** A logger that discards everything. The default everywhere. */
export const SILENT_LOGGER: Logger = Object.freeze({
  debug: noop,
  info: noop,
  warn: noop,
  error: noop,
});

/** The logger to use for an optional option value. */
export function resolveLogger(logger: Logger | undefined | null): Logger {
  return logger ?? SILENT_LOGGER;
}
