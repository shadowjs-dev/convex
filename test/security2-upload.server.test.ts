import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRoot } from "@shadow-js/core";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ConvexProvider } from "../src/client";
import type { ConvexClientLike } from "../src/types";
import { type UploadFileHandle, useUploadFile } from "../src/upload";
import { api } from "./support/refs";

/**
 * SEC2-CONVEX-6x: the upload URL comes from the backend and the bytes of the user's file go to it.
 * It must be https (or loopback http), must carry no credentials, and, when the client knows its
 * deployment, must be on the deployment's origin (or one the call lists). A redirect from the
 * storage endpoint is not followed, and its answer is bounded.
 */

const DEPLOYMENT = "https://happy-otter-123.convex.cloud";

interface Sent {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

let sent: Sent[];
let realFetch: typeof fetch;
let respond: () => Response;

beforeEach(() => {
  sent = [];
  realFetch = globalThis.fetch;
  respond = () => new Response(JSON.stringify({ storageId: "s-1" }), { status: 200 });
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ url: String(input), init });
    return respond();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

function mountUpload(uploadUrl: unknown, deployment: string | undefined): UploadFileHandle {
  const client = {
    onUpdate: () => () => undefined,
    mutation: () => Promise.resolve(uploadUrl) as never,
    action: () => Promise.reject(new Error("not used")),
    setAuth: () => undefined,
    ...(deployment === undefined ? {} : { client: { url: deployment } }),
  } satisfies ConvexClientLike;
  const slot: { value: UploadFileHandle | undefined } = { value: undefined };
  createRoot((dispose) => {
    ConvexProvider({
      client,
      get children() {
        slot.value = useUploadFile(api.files.generateUploadUrl);
        return null;
      },
    });
    return dispose;
  });
  if (slot.value === undefined) throw new Error("mountUpload(): the body did not run.");
  return slot.value;
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  return promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

const file = new Blob(["private bytes"], { type: "text/plain" });

describe("SEC2-CONVEX upload target", () => {
  it("SEC2-CONVEX-60 the one-time URL on the deployment's origin is accepted, and the request carries no credentials", async () => {
    const url = `${DEPLOYMENT}/api/storage/upload?token=ONETIMESECRET`;
    const result = await mountUpload(url, DEPLOYMENT)(file);
    expect(result).toEqual({ storageId: "s-1" });
    expect(sent.length).toBe(1);
    expect(sent[0]?.url).toBe(url);
    const headers = new Headers(sent[0]?.init?.headers);
    expect([...headers.keys()]).toEqual(["content-type"]);
    expect(sent[0]?.init?.credentials).toBe("omit");
  });

  it("SEC2-CONVEX-61 a URL on another origin than the deployment is refused before the file is sent, and the error does not echo it", async () => {
    for (const url of [
      "https://evil.example/api/storage/upload?token=ONETIMESECRET",
      "https://happy-otter-123.convex.cloud.evil.example/upload?token=ONETIMESECRET",
      "https://happy-otter-123.convex.cloud:8443/upload?token=ONETIMESECRET",
      "http://happy-otter-123.convex.cloud/upload?token=ONETIMESECRET",
    ]) {
      const failure = await failureOf(mountUpload(url, DEPLOYMENT)(file));
      expect(failure, url).toBeInstanceOf(TypeError);
      expect(String((failure as Error).message), url).not.toContain("ONETIMESECRET");
      expect(String((failure as Error).message), url).not.toContain("evil.example");
    }
    expect(sent).toEqual([]);
  });

  it("SEC2-CONVEX-62 schemes other than https (and loopback http), credentials in the URL and non-URLs are refused", async () => {
    for (const url of [
      "http://203.0.113.7/upload",
      "ftp://evil.example/upload",
      "javascript:alert(1)",
      "data:text/plain,x",
      "file:///etc/passwd",
      "blob:https://evil.example/uuid",
      "https://user:pw@happy-otter-123.convex.cloud/upload",
      "//evil.example/upload",
      "/api/storage/upload",
      "",
      "not a url",
    ]) {
      const failure = await failureOf(mountUpload(url, undefined)(file));
      expect(failure, url).toBeInstanceOf(TypeError);
    }
    expect(sent).toEqual([]);
  });

  it("SEC2-CONVEX-63 without a known deployment, https and loopback http are accepted", async () => {
    await mountUpload("https://storage.example.com/upload?token=t", undefined)(file);
    await mountUpload("http://127.0.0.1:3210/api/storage/upload?token=t", undefined)(file);
    expect(sent.map((entry) => new URL(entry.url).origin)).toEqual([
      "https://storage.example.com",
      "http://127.0.0.1:3210",
    ]);
  });

  it("SEC2-CONVEX-64 allowedOrigins lets one call name an extra storage origin, and only an exact origin matches", async () => {
    const upload = mountUpload("https://files.example.com/upload?token=t", DEPLOYMENT);
    expect(await failureOf(upload(file))).toBeInstanceOf(TypeError);
    await expect(upload(file, { allowedOrigins: ["https://files.example.com"] })).resolves.toEqual({
      storageId: "s-1",
    });
    const near = mountUpload("https://files.example.com.evil.example/upload", DEPLOYMENT);
    expect(
      await failureOf(near(file, { allowedOrigins: ["https://files.example.com"] })),
    ).toBeInstanceOf(TypeError);
  });

  it("SEC2-CONVEX-65 the storage request is sent with redirect error", async () => {
    await mountUpload(`${DEPLOYMENT}/upload`, DEPLOYMENT)(file);
    expect(sent[0]?.init?.redirect).toBe("error");
  });

  it("SEC2-CONVEX-66 an answer over the size bound is refused, a normal one is accepted", async () => {
    respond = () => new Response(JSON.stringify({ storageId: "s", pad: "p".repeat(100_000) }));
    const failure = await failureOf(mountUpload(`${DEPLOYMENT}/upload`, DEPLOYMENT)(file));
    expect(failure).toBeInstanceOf(RangeError);
    respond = () => new Response(JSON.stringify({ storageId: "ok" }));
    await expect(mountUpload(`${DEPLOYMENT}/upload`, DEPLOYMENT)(file)).resolves.toEqual({
      storageId: "ok",
    });
  });

  it("SEC2-CONVEX-67 a non-JSON answer does not put its body into the error", async () => {
    respond = () => new Response("SECRETBODY<html></html>", { status: 200 });
    const failure = await failureOf(mountUpload(`${DEPLOYMENT}/upload`, DEPLOYMENT)(file));
    expect(failure).toBeInstanceOf(TypeError);
    expect(JSON.stringify(Object.getOwnPropertyNames(failure))).not.toContain("SECRETBODY");
    expect(String((failure as Error).message)).not.toContain("SECRETBODY");
    expect(String(((failure as Error).cause as Error | undefined)?.message)).not.toContain(
      "SECRETBODY",
    );
  });
});

describe("SEC2-CONVEX upload against a real redirecting endpoint", () => {
  let storage: Server;
  let sink: Server;
  let storageOrigin: string;
  let sinkHits: string[] = [];

  function readBody(request: IncomingMessage): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
      request.on("error", reject);
    });
  }

  function listen(server: Server): Promise<string> {
    return new Promise((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`);
      });
    });
  }

  let sinkOrigin = "";

  beforeAll(async () => {
    sink = createServer((request: IncomingMessage, response: ServerResponse) => {
      void readBody(request).then((body) => {
        sinkHits.push(body);
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ storageId: "stolen" }));
      });
    });
    sinkOrigin = await listen(sink);
    storage = createServer((request: IncomingMessage, response: ServerResponse) => {
      void readBody(request).then(() => {
        response.writeHead(307, { location: `${sinkOrigin}/collect` });
        response.end();
      });
    });
    storageOrigin = await listen(storage);
  });

  afterAll(async () => {
    sink.closeAllConnections();
    storage.closeAllConnections();
    await Promise.all([
      new Promise<void>((resolve) => sink.close(() => resolve())),
      new Promise<void>((resolve) => storage.close(() => resolve())),
    ]);
  });

  it("SEC2-CONVEX-68 a 307 from the storage endpoint does not forward the file to another origin", async () => {
    globalThis.fetch = realFetch;
    sinkHits = [];
    const failure = await failureOf(
      mountUpload(`${storageOrigin}/upload`, storageOrigin)(new Blob(["private bytes"])),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(sinkHits).toEqual([]);
  });
});

describe("SEC2-CONVEX upload over XMLHttpRequest", () => {
  const original = globalThis.XMLHttpRequest;

  afterEach(() => {
    globalThis.XMLHttpRequest = original;
  });

  /** A minimal XHR that answers with `body` as if it came from `responseURL`. */
  function stubXhr(responseURL: string, body: string): void {
    class FakeXhr {
      status = 0;
      responseText = "";
      responseURL = "";
      upload: { onprogress: ((event: ProgressEvent) => void) | null } = { onprogress: null };
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      open(): void {
        // Nothing to do: the stub answers in send().
      }
      setRequestHeader(): void {
        // Headers are not inspected by these tests.
      }
      abort(): void {
        // Never aborted in these tests.
      }
      send(): void {
        this.status = 200;
        this.responseText = body;
        this.responseURL = responseURL;
        this.onload?.();
      }
    }
    globalThis.XMLHttpRequest = FakeXhr as unknown as typeof XMLHttpRequest;
  }

  it("SEC2-CONVEX-69 an answer that came from another origin than the one posted to is refused", async () => {
    stubXhr("https://evil.example/collect", JSON.stringify({ storageId: "stolen" }));
    const failure = await failureOf(mountUpload(`${DEPLOYMENT}/upload`, DEPLOYMENT)(file));
    expect(failure).toBeInstanceOf(TypeError);
  });

  it("SEC2-CONVEX-70 an answer from the posted origin is accepted, and an oversize one is refused", async () => {
    stubXhr(`${DEPLOYMENT}/upload`, JSON.stringify({ storageId: "fine" }));
    await expect(mountUpload(`${DEPLOYMENT}/upload`, DEPLOYMENT)(file)).resolves.toEqual({
      storageId: "fine",
    });
    stubXhr(`${DEPLOYMENT}/upload`, JSON.stringify({ storageId: "x", pad: "p".repeat(100_000) }));
    expect(await failureOf(mountUpload(`${DEPLOYMENT}/upload`, DEPLOYMENT)(file))).toBeInstanceOf(
      RangeError,
    );
  });
});
