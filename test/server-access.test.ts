import assert from "node:assert";
import * as http from "node:http";
import { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import {
  callerHeaders,
  CurrentsApiHandle,
  localServerBase,
  loopbackGetJson,
  runWithCaller,
  watchCurrentsApi,
} from "../dist/server-access.js";
import type { ServerAPI } from "@signalk/server-api";
import { ApiHandler } from "../dist/api.js";
import { CurrentsClient, TidesClient } from "../dist/tides.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

// routeiq reaches the tide plugins in the same Signal K server either
// in-process (signalk-tidal-currents' `currentsApi` PropertyValue) or over
// HTTP on the server's own address with the caller's login. These cover how
// the address is worked out, that the login travels with the request, and
// that the in-process handle wins when it is there.

describe("localServerBase", () => {
  const saved = { PORT: process.env.PORT, SSLPORT: process.env.SSLPORT };
  after(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
  function clearEnv() {
    delete process.env.PORT;
    delete process.env.SSLPORT;
  }

  it("defaults to http on 3000", () => {
    clearEnv();
    assert.strictEqual(localServerBase({}), "http://localhost:3000");
  });

  it("uses the configured http port", () => {
    clearEnv();
    assert.strictEqual(
      localServerBase({ config: { settings: { port: 8080 } } }),
      "http://localhost:8080",
    );
  });

  it("uses https on the ssl port when ssl is on", () => {
    clearEnv();
    assert.strictEqual(
      localServerBase({ config: { settings: { ssl: true, port: 3000 } } }),
      "https://localhost:3443",
    );
    assert.strictEqual(
      localServerBase({
        config: { settings: { ssl: true, port: 3000, sslport: 8443 } },
      }),
      "https://localhost:8443",
    );
  });

  it("lets PORT / SSLPORT override the settings, as the server does", () => {
    clearEnv();
    process.env.PORT = "4000";
    process.env.SSLPORT = "4443";
    assert.strictEqual(
      localServerBase({ config: { settings: { port: 3000 } } }),
      "http://localhost:4000",
    );
    assert.strictEqual(
      localServerBase({ config: { settings: { ssl: true, sslport: 8443 } } }),
      "https://localhost:4443",
    );
  });
});

describe("caller credentials", () => {
  let server: http.Server;
  let base: string;
  let seen: http.IncomingHttpHeaders[] = [];

  before(async () => {
    server = http.createServer((req, res) => {
      seen.push(req.headers);
      if (req.url?.startsWith("/denied")) {
        res.writeHead(401).end("{}");
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, url: req.url }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  it("has none outside a request", () => {
    assert.deepStrictEqual(callerHeaders(), {});
  });

  it("sends the caller's authorization and cookie, across awaits", async () => {
    seen = [];
    const body = await runWithCaller(
      { authorization: "Bearer abc", cookie: "JAUTHENTICATION=xyz" },
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        const resp = await loopbackGetJson(`${base}/x`);
        assert.strictEqual(resp.ok, true);
        return resp.json();
      },
    );
    assert.deepStrictEqual(body, { ok: true, url: "/x" });
    assert.strictEqual(seen[0].authorization, "Bearer abc");
    assert.strictEqual(seen[0].cookie, "JAUTHENTICATION=xyz");
  });

  it("keeps two callers apart", async () => {
    seen = [];
    await Promise.all([
      runWithCaller({ authorization: "Bearer one" }, () =>
        loopbackGetJson(`${base}/one`),
      ),
      runWithCaller({ authorization: "Bearer two" }, () =>
        loopbackGetJson(`${base}/two`),
      ),
    ]);
    const byUrl = Object.fromEntries(
      seen.map((h, i) => [i, h.authorization]),
    );
    assert.deepStrictEqual(Object.values(byUrl).sort(), [
      "Bearer one",
      "Bearer two",
    ]);
  });

  it("reports a refused login as a failed lookup", async () => {
    const client = new TidesClient(`${base}/denied`);
    const probe = await client.probe(52, 5);
    assert.deepStrictEqual(probe, { available: false, stations: [] });
  });
});

describe("currentsApi PropertyValue", () => {
  function handle(tag: string): CurrentsApiHandle {
    return {
      version: 1,
      providerId: tag,
      findStations: async () => [],
      getTimeline: async () => ({ timeline: [] }),
    };
  }

  it("takes the newest usable value from the replayed history", () => {
    const got: CurrentsApiHandle[] = [];
    let unsubscribed = false;
    const unsub = watchCurrentsApi(
      {
        onPropertyValues: (name, cb) => {
          assert.strictEqual(name, "currentsApi");
          // The server's history always starts with undefined.
          cb([
            undefined as unknown as { value?: unknown },
            { value: handle("old") },
            { value: { version: 2, findStations: () => 0 } },
          ]);
          return () => {
            unsubscribed = true;
          };
        },
      },
      (h) => got.push(h),
    );
    assert.deepStrictEqual(
      got.map((h) => h.providerId),
      ["old"],
    );
    unsub();
    assert.strictEqual(unsubscribed, true);
  });

  it("ignores a history with no handle yet", () => {
    const got: CurrentsApiHandle[] = [];
    watchCurrentsApi(
      { onPropertyValues: (_n, cb) => cb([undefined as never]) },
      (h) => got.push(h),
    );
    assert.strictEqual(got.length, 0);
  });

  it("is a no-op on a server without PropertyValues", () => {
    const unsub = watchCurrentsApi({}, () => assert.fail("no handle"));
    unsub();
  });
});

describe("CurrentsClient", () => {
  const station = {
    id: "s1",
    name: "S1",
    latitude: 52,
    longitude: 5,
    vectorCapable: true,
  };

  it("calls the in-process handle when there is one", async () => {
    const calls: unknown[][] = [];
    const h: CurrentsApiHandle = {
      version: 1,
      providerId: "signalk-tidal-currents",
      findStations: async (...a) => {
        calls.push(["find", ...a]);
        return [station, { ...station, id: "s2", vectorCapable: false }];
      },
      getTimeline: async (...a) => {
        calls.push(["timeline", ...a]);
        return { timeline: [] };
      },
    };
    const client = new CurrentsClient(
      "http://localhost:1",
      () => h,
      async () => assert.fail("must not use HTTP while the handle is there"),
    );
    const stations = await client.findStations(52, 5);
    assert.deepStrictEqual(
      stations.map((s) => s.id),
      ["s1"],
    );
    await client.fetchTimeline(
      "s1",
      Date.parse("2026-08-11T00:20:00Z"),
      Date.parse("2026-08-11T05:40:00Z"),
    );
    assert.deepStrictEqual(calls, [
      ["find", 52, 5, 10],
      [
        "timeline",
        "s1",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T06:00:00.000Z",
        10,
      ],
    ]);
  });

  it("falls back to HTTP on this server without a handle", async () => {
    const urls: string[] = [];
    const client = new CurrentsClient(
      "https://localhost:3443/",
      () => null,
      async (url) => {
        urls.push(url);
        return { ok: true, status: 200, json: async () => [station] };
      },
    );
    await client.findStations(52, 5);
    assert.deepStrictEqual(urls, [
      "https://localhost:3443/signalk/v2/api/currents/stations?latitude=52&longitude=5&limit=10",
    ]);
  });
});

describe("API router", () => {
  it("hands the caller's login to tide lookups made while answering", async () => {
    let seen: Record<string, string> | null = null;
    const engine = {
      tidesClient: {
        probe: async () => {
          await new Promise((r) => setTimeout(r, 5));
          seen = callerHeaders();
          return { available: false, stations: [] };
        },
      },
      currentsClient: null,
    };
    const app = {
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      getSelfPath: () => undefined,
    } as unknown as ServerAPI;
    const handler = new ApiHandler({ ...DEFAULT_CONFIG }, app);
    handler.setComponents({} as never, engine as never);
    const router = handler.getRouter() as unknown as (
      q: unknown,
      s: unknown,
      n: (err?: unknown) => void,
    ) => void;

    await new Promise<void>((resolve, reject) => {
      const req = {
        method: "GET",
        url: "/tides/status?latitude=52&longitude=5",
        originalUrl: "/router/tides/status?latitude=52&longitude=5",
        headers: { authorization: "Bearer tok", cookie: "c=1" },
        query: { latitude: "52", longitude: "5" },
        on: () => req,
      };
      const res = {
        statusCode: 200,
        headersSent: false,
        header: () => res,
        setHeader: () => res,
        getHeader: () => undefined,
        status(code: number) {
          res.statusCode = code;
          return res;
        },
        json: () => resolve(),
        send: () => resolve(),
        end: () => resolve(),
      };
      router(req, res, (err?: unknown) =>
        reject(err instanceof Error ? err : new Error("no handler reached")),
      );
    });
    assert.deepStrictEqual(seen, { authorization: "Bearer tok", cookie: "c=1" });
  });
});
