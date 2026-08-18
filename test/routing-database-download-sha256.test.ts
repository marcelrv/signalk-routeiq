import * as fs from "fs";
import * as path from "path";
import * as zlib from "node:zlib";
import * as crypto from "node:crypto";
import { Readable } from "node:stream";
import assert from "node:assert";
import { describe, it, beforeEach, afterEach } from "node:test";
import { Router } from "express";
import { ServerAPI } from "@signalk/server-api";
import { ApiHandler } from "../dist/api.js";
import { DEFAULT_CONFIG } from "../dist/types.js";

// Regression coverage for the sha256 integrity check added to
// /databases/download: it must reject a corrupted/mismatched transfer
// *before* installing it, and must not disturb an unverified download (no
// sha256 sent) since that is the only mode most of this suite's fixtures
// exercised before this check existed.
//
// Also guards the specific bug this check was built around: a first draft
// hashed the stream with a bare crypto.createHash() spliced into the
// pipeline. That object is writable-then-drain, not a passthrough -- piped
// downstream it emits only the final digest, truncating every download to
// 32 bytes. Caught by hand against a real release asset before this test
// existed; codified here so it can't come back silently.
describe("/databases/download sha256 verification", () => {
  const CATALOG_URL =
    "https://raw.githubusercontent.com/marcelrv/signalk-router-data/main/routing-index.json";
  const TRUSTED_DOWNLOAD_URL =
    "https://raw.githubusercontent.com/marcelrv/signalk-router-data/main/regions/europe/nl/zeeland.sqlite.gz";

  const plaintext = Buffer.from(
    "not a real sqlite file, just deterministic bytes to gzip and rehydrate",
  );
  const gzipped = zlib.gzipSync(plaintext);
  const correctSha256 = crypto
    .createHash("sha256")
    .update(gzipped)
    .digest("hex");
  const wrongSha256 = "0".repeat(64);

  let originalFetch: typeof fetch;
  let fetchCalls = 0;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    fetchCalls = 0;
    globalThis.fetch = (async () => {
      fetchCalls++;
      return {
        ok: true,
        status: 200,
        body: Readable.toWeb(Readable.from(gzipped)),
      } as unknown as Response;
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function makeHandler(dataDir: string): Router {
    const app = {
      debug: () => {},
      error: () => {},
      setPluginStatus: () => {},
      getSelfPath: () => undefined,
    } as unknown as ServerAPI;
    const handler = new ApiHandler(
      { ...DEFAULT_CONFIG, routingDataDir: dataDir, catalogUrl: CATALOG_URL },
      app,
    );
    handler.onReloadRequested = async () => {};
    return handler.getRouter();
  }

  /** Drive one authenticated POST through the router. */
  function post(
    router: Router,
    url: string,
    body: unknown,
  ): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const req = {
        method: "POST",
        url,
        path: url,
        originalUrl: "/router" + url,
        headers: {},
        query: {},
        body,
        skIsAuthenticated: true,
        skPrincipal: { identifier: "test", permissions: "admin" },
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
        json: (b: unknown) => resolve({ status: res.statusCode, body: b }),
        send: (b: unknown) => resolve({ status: res.statusCode, body: b }),
        end: () => resolve({ status: res.statusCode, body: undefined }),
      };
      (
        router as unknown as (
          q: unknown,
          s: unknown,
          n: (err?: unknown) => void,
        ) => void
      )(req, res, (err?: unknown) =>
        reject(
          err instanceof Error
            ? err
            : new Error(`POST ${url} reached no handler: ${err ?? "next()"}`),
        ),
      );
    });
  }

  function tempDir(tag: string): string {
    const dir = path.resolve(`./test/fixtures/download-sha256-${tag}`);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  it("installs the download when sha256 matches", async () => {
    const dir = tempDir("match");
    try {
      const res = await post(makeHandler(dir), "/databases/download", {
        url: TRUSTED_DOWNLOAD_URL,
        filename: "zeeland.sqlite.gz",
        sha256: correctSha256,
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      assert.equal(res.body.success, true);
      const installed = path.join(dir, "zeeland.sqlite");
      assert.equal(
        fs.existsSync(installed),
        true,
        "decompressed file must be installed",
      );
      assert.deepEqual(
        fs.readFileSync(installed),
        plaintext,
        "installed bytes must exactly match the original (uncorrupted) content",
      );
      assert.equal(
        fs.existsSync(installed + ".tmp"),
        false,
        "no leftover .tmp file",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects and does not install when sha256 does not match", async () => {
    const dir = tempDir("mismatch");
    try {
      const res = await post(makeHandler(dir), "/databases/download", {
        url: TRUSTED_DOWNLOAD_URL,
        filename: "zeeland.sqlite.gz",
        sha256: wrongSha256,
      });
      assert.equal(res.status, 502, JSON.stringify(res.body));
      assert.match(res.body.error, /integrity check/i);
      const installed = path.join(dir, "zeeland.sqlite");
      assert.equal(
        fs.existsSync(installed),
        false,
        "must not install on hash mismatch",
      );
      assert.equal(
        fs.existsSync(installed + ".tmp"),
        false,
        "must clean up the temp file",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("still installs when no sha256 is sent (backward compatible, unverified)", async () => {
    const dir = tempDir("unverified");
    try {
      const res = await post(makeHandler(dir), "/databases/download", {
        url: TRUSTED_DOWNLOAD_URL,
        filename: "zeeland.sqlite.gz",
      });
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const installed = path.join(dir, "zeeland.sqlite");
      assert.deepEqual(fs.readFileSync(installed), plaintext);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a malformed sha256 before ever fetching the URL", async () => {
    const dir = tempDir("malformed");
    try {
      const res = await post(makeHandler(dir), "/databases/download", {
        url: TRUSTED_DOWNLOAD_URL,
        filename: "zeeland.sqlite.gz",
        sha256: "not-a-hash",
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(
        fetchCalls,
        0,
        "must validate the hash format before downloading anything",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("rejects a single-element array sha256 instead of crashing mid-download", async () => {
    // RegExp#test() coerces its argument via ToString, and a one-element
    // array stringifies to just that element (no brackets/commas) -- so
    // [correctSha256] passes a bare regex check. Without an explicit
    // typeof guard this reaches sha256.toLowerCase() after the download
    // has already run, which throws (arrays have no such method).
    const dir = tempDir("array-hash");
    try {
      const res = await post(makeHandler(dir), "/databases/download", {
        url: TRUSTED_DOWNLOAD_URL,
        filename: "zeeland.sqlite.gz",
        sha256: [correctSha256],
      });
      assert.equal(res.status, 400, JSON.stringify(res.body));
      assert.equal(
        fetchCalls,
        0,
        "must validate the hash is a string before downloading anything",
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
