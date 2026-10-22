import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRoot } from "@shadow-js/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConvexProvider } from "../src/client";
import type { ConvexClientLike } from "../src/types";
import { type UploadFileHandle, useUploadFile } from "../src/upload";
import { api } from "./support/refs";

/**
 * A loopback HTTP server that plays the part of Convex's storage upload endpoint. It records each
 * request (method, content type, body bytes) and answers with the behavior the test asks for.
 * Loopback only: nothing leaves the machine.
 */
interface Received {
  readonly method: string | undefined;
  readonly contentType: string | undefined;
  readonly body: Buffer;
}

let server: Server;
let origin: string;
let received: Received[] = [];
/** The response the next request gets: "ok", "status", "no-id" or "slow". */
let mode: "ok" | "status" | "no-id" | "slow" = "ok";

function readBody(request: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
    request.on("error", reject);
  });
}

function answer(response: ServerResponse, status: number, payload: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(payload));
}

beforeAll(async () => {
  server = createServer((request, response) => {
    void readBody(request).then((body) => {
      received.push({
        method: request.method,
        contentType: request.headers["content-type"],
        body,
      });
      if (mode === "status") {
        answer(response, 413, { message: "too large" });
      } else if (mode === "no-id") {
        answer(response, 200, { other: true });
      } else if (mode === "slow") {
        setTimeout(() => answer(response, 200, { storageId: "late" }), 2000);
      } else {
        answer(response, 200, { storageId: "storage-1" });
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address() as AddressInfo;
  origin = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** A client whose only working call is `generateUploadUrl`, which answers through `generate`. */
function clientAnswering(generate: () => Promise<string>): ConvexClientLike {
  return {
    onUpdate: () => () => undefined,
    mutation: () => generate() as never,
    action: () => Promise.reject(new Error("not used")),
    setAuth: () => undefined,
  };
}

/** Mounts `useUploadFile` under a provider whose `generateUploadUrl` runs through `generate`. */
function mountUpload(generate: () => Promise<string>): UploadFileHandle {
  const slot: { value: UploadFileHandle | undefined } = { value: undefined };
  createRoot((disposeRoot) => {
    ConvexProvider({
      client: clientAnswering(generate),
      get children() {
        slot.value = useUploadFile(api.files.generateUploadUrl);
        return null;
      },
    });
    return disposeRoot;
  });
  if (slot.value === undefined) throw new Error("mountUpload(): the body did not run.");
  return slot.value;
}

describe("useUploadFile over a real HTTP endpoint", () => {
  it("[UPL-1] posts the bytes to the generated URL and resolves with the typed storageId", async () => {
    received = [];
    mode = "ok";
    const upload = mountUpload(() => Promise.resolve(`${origin}/upload`));
    const file = new Blob(["hello storage"], { type: "text/plain" });
    const result = await upload(file);
    expect(result).toEqual({ storageId: "storage-1" });
    expect(received.length).toBe(1);
    expect(received[0]?.method).toBe("POST");
    expect(received[0]?.body.toString("utf8")).toBe("hello storage");
  });

  it("[UPL-2] sends the blob's type as Content-Type, or application/octet-stream when it has none", async () => {
    received = [];
    mode = "ok";
    const upload = mountUpload(() => Promise.resolve(`${origin}/upload`));
    await upload(new Blob(["{}"], { type: "application/json" }));
    await upload(new Blob([new Uint8Array([1, 2, 3])]));
    expect(received.map((entry) => entry.contentType)).toEqual([
      "application/json",
      "application/octet-stream",
    ]);
    expect(received[1]?.body.equals(Buffer.from([1, 2, 3]))).toBe(true);
  });

  it("[UPL-3] a non-2xx answer rejects with the status, sets error() and clears pending()", async () => {
    received = [];
    mode = "status";
    const upload = mountUpload(() => Promise.resolve(`${origin}/upload`));
    const failure = await upload(new Blob(["x"])).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/413/);
    expect(upload.error()).toBe(failure);
    expect(upload.pending()).toBe(false);
    mode = "ok";
  });

  it("[UPL-4] an answer without a string storageId is rejected, not returned as undefined", async () => {
    received = [];
    mode = "no-id";
    const upload = mountUpload(() => Promise.resolve(`${origin}/upload`));
    await expect(upload(new Blob(["x"]))).rejects.toThrow(/storageId/);
    mode = "ok";
  });

  it("[UPL-5] an aborted upload rejects with an AbortError and does not report a storageId", async () => {
    received = [];
    mode = "slow";
    const upload = mountUpload(() => Promise.resolve(`${origin}/upload`));
    const controller = new AbortController();
    const pending = upload(new Blob(["big"]), { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const failure = await pending.then(
      () => undefined,
      (error: unknown) => error,
    );
    expect((failure as { name?: string }).name).toBe("AbortError");
    expect(upload.pending()).toBe(false);
    mode = "ok";
  });

  it("[UPL-6] an upload with an already aborted signal never reaches the endpoint", async () => {
    received = [];
    mode = "ok";
    const upload = mountUpload(() => Promise.resolve(`${origin}/upload`));
    const controller = new AbortController();
    controller.abort();
    await expect(upload(new Blob(["x"]), { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(received.length).toBe(0);
  });

  it("[UPL-7] a failing generateUploadUrl rejects, nothing is posted, and the error is kept", async () => {
    received = [];
    const failure = new Error("not signed in");
    const upload = mountUpload(() => Promise.reject(failure));
    await expect(upload(new Blob(["x"]))).rejects.toBe(failure);
    expect(received.length).toBe(0);
    expect(upload.error()).toBe(failure);
    upload.reset();
    expect(upload.error()).toBeUndefined();
  });

  it("[UPL-8] onProgress reports the byte count and the fraction, and completes at the file size", async () => {
    received = [];
    mode = "ok";
    const upload = mountUpload(() => Promise.resolve(`${origin}/upload`));
    const seen: Array<{ loaded: number; total: number }> = [];
    const file = new Blob(["0123456789"]);
    await upload(file, { onProgress: (progress) => seen.push(progress) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toEqual({ loaded: 10, total: 10 });
    expect(upload.progress()).toBeUndefined();
  });
});
