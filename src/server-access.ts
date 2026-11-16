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

const LOOPBACK_TIMEOUT_MS = 15_000;

/**
 * GET a URL on this server with the caller's credentials. Uses node:http(s)
 * rather than fetch: an SSL-enabled Signal K server usually has a self-signed
 * certificate, which fetch would refuse, and this only ever talks to
 * localhost, so certificate checking buys nothing here.
 */
export const loopbackGetJson: GetJson = (url) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === "https:" ? https : http;
    const req = mod.request(
      u,
      {
        method: "GET",
        headers: { accept: "application/json", ...callerHeaders() },
        ...(u.protocol === "https:" ? { rejectUnauthorized: false } : {}),
        timeout: LOOPBACK_TIMEOUT_MS,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
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
    req.on("timeout", () =>
      req.destroy(new Error(`timed out after ${LOOPBACK_TIMEOUT_MS} ms`)),
    );
    req.on("error", reject);
    req.end();
  });

/** Warn once per client when the server refuses the login, instead of
 *  letting tides quietly read as "not installed". */
export function warnIfRefused(
  status: number,
  what: string,
  warned: { done: boolean },
): void {
  if ((status === 401 || status === 403) && !warned.done) {
    warned.done = true;
    console.warn(
      `[routeiq] ${what} refused the request (${status}): the caller's login ` +
        `does not allow reading it. Tides stay off for such requests.`,
    );
  }
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
