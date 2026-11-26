/**
 * Whether a connection opened with `{ readOnly: true }` really is read-only.
 *
 * A `node:sqlite` that ignores the option (22.5.0) opens the file read-write.
 * The check runs on the actual connection and writes nothing that lasts: inside
 * a transaction it tries to create a table, which a read-only connection
 * refuses (SQLITE_READONLY); the transaction is always rolled back. Nothing is
 * created beside the data and no temporary directory is used.
 */

/** What the write attempt did. */
export interface ReadOnlyProbeOutcome {
  /** The write attempt threw. */
  threw: boolean;
  /** The error it threw was SQLite's read-only error. */
  readOnlyError: boolean;
}

/** Whether the outcome shows `readOnly` is honoured: the write was refused
 *  because the database is read-only. */
export function readOnlyHonoured(outcome: ReadOnlyProbeOutcome): boolean {
  return outcome.threw && outcome.readOnlyError;
}

/** SQLITE_READONLY (8), or its message for a build without `errcode`. */
export function isReadOnlyError(e: unknown): boolean {
  const err = e as { errcode?: unknown; message?: unknown } | null;
  if (err && err.errcode === 8) return true;
  return (
    typeof err?.message === "string" && /readonly|read-only/i.test(err.message)
  );
}

/** The part of a `DatabaseSync` the check uses. */
export interface ProbeConnection {
  exec(sql: string): void;
}

/**
 * Tries a write on `db` inside a transaction and rolls it back. Returns whether
 * the connection is read-only. Any other failure is thrown as it is (it says
 * nothing about read-only support).
 */
export function probeReadOnlyConnection(db: ProbeConnection): boolean {
  const outcome: ReadOnlyProbeOutcome = { threw: false, readOnlyError: false };
  let other: unknown = null;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      db.exec("CREATE TABLE main.routeiq_ro_probe (x)");
    } catch (e) {
      outcome.threw = true;
      outcome.readOnlyError = isReadOnlyError(e);
      if (!outcome.readOnlyError) other = e;
    }
  } catch (e) {
    other = e;
  } finally {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* no transaction is open */
    }
  }
  if (other) throw other;
  return readOnlyHonoured(outcome);
}

/** Raised by an open when read-only mode was asked for and not honoured. */
export class ReadOnlyNotHonouredError extends Error {
  constructor() {
    super(
      `Read-only mode is not available: this Node.js (${process.version}) opens SQLite files read-write even when asked for read-only. Use a newer Node.js.`,
    );
    this.name = "ReadOnlyNotHonouredError";
  }
}
