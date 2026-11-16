/**
 * How routeiq reaches the tide plugins running in the same Signal K server.
 *
 * Signal K has no tides/currents provider API, so there are two routes:
 *
 * - In-process (preferred): a plugin that emits the well-known PropertyValue
 *   `currentsApi` (signalk-tidal-currents, version 1 contract) hands routeiq
 *   plain functions to call. No port, no TLS, no login. See
 *   `watchCurrentsApi`.
 * - HTTP loopback (fallback, and the only route to signalk-tides): routeiq
 *   calls its own server's REST API like any client would. It needs the
 *   server's address and a login, neither of which a plugin is given:
 *   - the address comes from the server's own settings, by the same rule the
 *     server uses to pick its listening port (`localServerBase`);
 *   - the login is the caller's: every tide lookup happens while answering a
 *     client request, so the request's `Authorization` header and cookie are
 *     passed on (`runWithCaller` / `callerHeaders`). Anyone allowed to ask
 *     routeiq for a route is allowed to read tides.
 *
 * Until 2026-11-16 the address was a `tidesApiBase` setting defaulting to
 * http://localhost:3000 and no login was sent, so tides silently switched off
 * on another port, with SSL on, or with security on and no read-only access.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as http from "node:http";
import * as https from "node:https";

// ── Caller credentials ──────────────────────────────────────────────

interface CallerCredentials {
  authorization?: string;
  cookie?: string;
}

const callerStore = new AsyncLocalStorage<CallerCredentials>();

/** Run `fn` (and every async continuation it starts) with the credentials of
 *  the request being answered, so a loopback call made anywhere below it can
 *  send them on. */
export function runWithCaller<T>(
  headers: { authorization?: string; cookie?: string },
  fn: () => T,
): T {
  return callerStore.run(
    { authorization: headers.authorization, cookie: headers.cookie },
    fn,
  );
}

/** The current caller's auth headers, or none outside a request. */
export function callerHeaders(): Record<string, string> {
  const c = callerStore.getStore();
  const out: Record<string, string> = {};
  if (c?.authorization) out.authorization = c.authorization;
  if (c?.cookie) out.cookie = c.cookie;
  return out;
}

// ── Local server address ────────────────────────────────────────────

/** The parts of the server app the address is read from. */
export interface ServerSettingsSurface {
  config?: {
    settings?: { ssl?: boolean; port?: number; sslport?: number };
  };
}

/** Where this Signal K server listens, as a base URL for loopback calls.
 *  Mirrors signalk-server's own ports.js: with `ssl` on, the primary listener
 *  is HTTPS on SSLPORT / settings.sslport (default 3443) and the HTTP port only
 *  redirects; otherwise HTTP on PORT / settings.port (default 3000).
 *  (A systemd socket-activated server, LISTEN_FDS, has no port to read; this
 *  then falls back to the same settings, which may not match.) */
export function localServerBase(app: ServerSettingsSurface): string {
  const settings = app.config?.settings ?? {};
  const envPort = (name: string) => {
    const n = Number(process.env[name]);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  };
  if (settings.ssl) {
    const port = envPort("SSLPORT") ?? settings.sslport ?? 3443;
    return `https://localhost:${port}`;
  }
  const port = envPort("PORT") ?? settings.port ?? 3000;
  return `http://localhost:${port}`;
}

// ── Loopback GET ────────────────────────────────────────────────────

export interface JsonResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type GetJson = (url: string) => Promise<JsonResponse>;

/** A whole loopback GET (connect, headers and body) must finish within this.
 *  Generous on purpose: on a Raspberry Pi a long timeline can take seconds,
 *  and a slow answer must still count. What keeps a dead plugin from holding
 *  a route for long is not a short timeout but the breaker in `TideSource`
 *  (one wait, then skipped) and asking all stations at once. */
export const LOOPBACK_TIMEOUT_MS = 30_000;

/**
 * GET a URL on this server with the caller's credentials. Uses node:http(s)
 * rather than fetch: an SSL-enabled Signal K server usually has a self-signed
 * certificate, which fetch would refuse, and this only ever talks to
 * localhost, so certificate checking buys nothing here.
 */
export const loopbackGetJson = (
  url: string,
  timeoutMs: number = LOOPBACK_TIMEOUT_MS,
): Promise<JsonResponse> =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: { accept: "application/json", ...callerHeaders() },
        ...(u.protocol === "https:" ? { rejectUnauthorized: false } : {}),
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          clearTimeout(deadline);
          const status = res.statusCode ?? 0;
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({
            ok: status >= 200 && status < 300,
            status,
            json: async () => JSON.parse(text),
          });
        });
        res.on("error", reject);
      },
    );
    // A total deadline, not the socket idle timeout: a server that trickles
    // bytes would otherwise hold the route forever.
    const deadline = setTimeout(
      () => req.destroy(new TimeoutError(timeoutMs)),
      timeoutMs,
    );
    req.on("error", (e) => {
      clearTimeout(deadline);
      reject(e);
    });
    req.end();
  });

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms} ms`);
    this.name = "TimeoutError";
  }
}

/** Reject with a TimeoutError when `p` takes longer than `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/** How long a tide source that did not answer is skipped before it is tried
 *  again. */
export const UNREACHABLE_RETRY_MS = 60_000;

/**
 * One tide plugin as a source: the loopback GET with its status handling, the
 * in-process call with a deadline, and a breaker. When the plugin does not
 * answer (connection refused, timeout, or a redirect, which means the address
 * from the settings is not where the server listens), every lookup fails at
 * once for `UNREACHABLE_RETRY_MS` instead of each waiting out its own
 * timeout. A departure scan runs dozens of routes, so without this a dead
 * address would cost a timeout per route. A refused login (401/403) or a
 * missing plugin (404) is a quick answer and never trips it: the login is
 * per caller.
 */
export class TideSource {
  private downUntil = 0;
  private warned = new Set<string>();

  constructor(
    readonly name: string,
    readonly base: string,
    private readonly getJson: GetJson = loopbackGetJson,
    private readonly timeoutMs = LOOPBACK_TIMEOUT_MS,
    private readonly retryMs = UNREACHABLE_RETRY_MS,
  ) {}

  /** GET `url` (on `base`) and return its JSON body. */
  async get(url: string, what: string): Promise<unknown> {
    this.checkUp(what);
    let resp: JsonResponse;
    try {
      resp = await this.getJson(url);
    } catch (e) {
      this.trip(
        "unreachable",
        `not reachable at ${this.base} (${errText(e)}). Check the server's ` +
          `port and SSL settings.`,
      );
      throw new Error(`${what} failed: ${errText(e)}`);
    }
    if (resp.status >= 300 && resp.status < 400) {
      this.trip(
        "redirect",
        `answered ${resp.status} (a redirect) at ${this.base}: the server ` +
          `settings do not match the address it listens on.`,
      );
      throw new Error(`${what} failed (${resp.status})`);
    }
    if (!resp.ok) {
      if (resp.status === 401 || resp.status === 403)
        this.warnOnce(
          "refused",
          `refused the request (${resp.status}): the caller's login does ` +
            `not allow reading it. Tides stay off for such requests.`,
        );
      throw new Error(`${what} failed (${resp.status})`);
    }
    return resp.json();
  }

  /** Call the plugin in-process, under the same deadline and breaker. */
  async call<T>(what: string, fn: () => Promise<T>): Promise<T> {
    this.checkUp(what);
    try {
      return await withTimeout(fn(), this.timeoutMs);
    } catch (e) {
      if (e instanceof TimeoutError)
        this.trip("unreachable", `did not answer in-process (${e.message}).`);
      throw e;
    }
  }

  private checkUp(what: string): void {
    if (Date.now() < this.downUntil)
      throw new Error(`${what} skipped: ${this.name} did not answer recently`);
  }

  private trip(kind: string, message: string): void {
    this.downUntil = Date.now() + this.retryMs;
    this.warnOnce(
      kind,
      `${message} Tide lookups skip it for ${Math.round(this.retryMs / 1000)} s.`,
    );
  }

  private warnOnce(kind: string, message: string): void {
    if (this.warned.has(kind)) return;
    this.warned.add(kind);
    console.warn(`[routeiq] ${this.name} ${message}`);
  }
}

function errText(e: unknown): string {
  const code = (e as { code?: unknown })?.code;
  if (typeof code === "string") return code;
  return e instanceof Error ? e.message : String(e);
}

/** A short key for the current caller's login, for caches of data fetched
 *  with it: one caller's answer must not be served to another, who might not
 *  be allowed to read it. Empty outside a request or without a login. */
export function callerKey(): string {
  const h = callerHeaders();
  if (!h.authorization && !h.cookie) return "";
  return createHash("sha256")
    .update(`${h.authorization ?? ""}\n${h.cookie ?? ""}`)
    .digest("base64url")
    .slice(0, 16);
}

// ── In-process currents API (PropertyValues) ────────────────────────

/** Version 1 of the `currentsApi` PropertyValue, as emitted by
 *  signalk-tidal-currents. Both methods return the same JSON as its
 *  /signalk/v2/api/currents HTTP routes and reject while it is stopped. */
export interface CurrentsApiHandle {
  version: 1;
  providerId: string;
  findStations(
    latitude: number,
    longitude: number,
    limit?: number,
  ): Promise<unknown>;
  getTimeline(
    stationId: string,
    startIso: string,
    endIso: string,
    stepMinutes?: number,
  ): Promise<unknown>;
}

export const CURRENTS_API_PROPERTY = "currentsApi";

interface PropertyValueLike {
  value?: unknown;
}

/** The part of the server app that offers PropertyValues. */
export interface PropertyValuesSurface {
  onPropertyValues?(
    name: string,
    cb: (values: PropertyValueLike[] | undefined) => void,
  ): (() => void) | void;
}

function asCurrentsApi(v: unknown): CurrentsApiHandle | null {
  if (!v || typeof v !== "object") return null;
  const h = v as Partial<CurrentsApiHandle>;
  return h.version === 1 &&
    typeof h.findStations === "function" &&
    typeof h.getTimeline === "function"
    ? (h as CurrentsApiHandle)
    : null;
}

/**
 * Follow the `currentsApi` PropertyValue. Plugins start in no fixed order, so
 * the handle may arrive before or after this subscribes; the server replays
 * earlier values to a new listener. The newest usable value wins. Returns the
 * unsubscribe function (a no-op on servers without PropertyValues).
 */
export function watchCurrentsApi(
  app: PropertyValuesSurface,
  onHandle: (handle: CurrentsApiHandle) => void,
): () => void {
  if (typeof app.onPropertyValues !== "function") return () => {};
  const unsub = app.onPropertyValues(CURRENTS_API_PROPERTY, (values) => {
    const list = values ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
      const h = asCurrentsApi(list[i]?.value);
      if (h) {
        onHandle(h);
        return;
      }
    }
  });
  return typeof unsub === "function" ? unsub : () => {};
}

// ── Retired setting ─────────────────────────────────────────────────

/** The `tidesApiBase` setting is gone (the address now comes from the server
 *  settings). A saved value that named another server can no longer apply,
 *  and those tides would stop without a word, so say so. Returns whether it
 *  warned. */
export function warnIfRemoteTidesApiBase(value: unknown): boolean {
  if (typeof value !== "string" || !value.trim()) return false;
  let host: string;
  try {
    host = new URL(value).hostname.replace(/^\[|\]$/g, "");
  } catch {
    return false;
  }
  if (["localhost", "127.0.0.1", "::1", "0.0.0.0", "::"].includes(host))
    return false;
  console.warn(
    `[routeiq] The Tides API Base URL setting (${value}) is retired: routeiq ` +
      `now reads tides only from the plugins on this server. Install ` +
      `signalk-tides / signalk-tidal-currents here to keep tide-aware routing.`,
  );
  return true;
}
