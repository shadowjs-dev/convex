import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createRoot } from "@shadow-js/core";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ConvexProvider } from "../src/client";
import type { ConvexClientLike } from "../src/types";
import { type UploadFileHandle, useUploadFile } from "../src/upload";
import { api } from "./support/refs";

/**
 * The XMLHttpRequest path, under happy-dom. A loopback server receives the bytes and answers with
 * a storage id; the test checks the request body, the progress reports and the abort.
 */
let server: Server;
let origin: string;
let lastBody = "";
let delayMs = 0;

beforeAll(async () => {
  server = createServer((request: IncomingMessage, response: ServerResponse) => {
    // Convex storage is a cross-origin endpoint: it answers the CORS preflight and the response.
    const cors = {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST",
      "access-control-allow-headers": "content-type",
    };
    if (request.method === "OPTIONS") {
      response.writeHead(204, cors);
      response.end();
      return;
    }
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      lastBody = Buffer.concat(chunks).toString("utf8");
      setTimeout(() => {
        response.writeHead(200, { ...cors, "content-type": "application/json" });
        response.end(JSON.stringify({ storageId: "xhr-storage" }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // The aborted request may still be open: drop its socket before closing the listener.
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

function clientReturning(url: string): ConvexClientLike {
  return {
    onUpdate: () => () => undefined,
    mutation: () => Promise.resolve(url) as never,
    action: () => Promise.reject(new Error("not used")),
    setAuth: () => undefined,
  };
}

function mountUpload(url: string): UploadFileHandle {
  const slot: { value: UploadFileHandle | undefined } = { value: undefined };
  createRoot((disposeRoot) => {
    ConvexProvider({
      client: clientReturning(url),
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

describe("useUploadFile with XMLHttpRequest", () => {
  it("[UPL-XHR-1] posts the bytes with XMLHttpRequest and resolves with the storageId", async () => {
    expect(typeof XMLHttpRequest).toBe("function");
    delayMs = 0;
    const upload = mountUpload(`${origin}/upload`);
    const result = await upload(new Blob(["xhr bytes"], { type: "text/plain" }));
    expect(result).toEqual({ storageId: "xhr-storage" });
    expect(lastBody).toBe("xhr bytes");
  });

  it("[UPL-XHR-2] an abort through the signal calls xhr.abort() and rejects with AbortError", async () => {
    // A stand-in XMLHttpRequest that never answers: abort is observed directly, with no socket.
    const aborts: string[] = [];
    class StallingXhr {
      readonly upload: { onprogress?: (event: ProgressEvent) => void } = {};
      onload?: () => void;
      onerror?: () => void;
      onabort?: () => void;
      open(): void {
        // The request is only recorded when it is sent.
      }
      setRequestHeader(): void {
        // Headers are not checked by this stand-in.
      }
      send(): void {
        aborts.push("sent");
      }
      abort(): void {
        aborts.push("aborted");
        this.onabort?.();
      }
    }
    vi.stubGlobal("XMLHttpRequest", StallingXhr);
    try {
      const upload = mountUpload("https://storage.invalid/upload");
      const controller = new AbortController();
      const pending = upload(new Blob(["never sent"]), { signal: controller.signal });
      expect(upload.pending()).toBe(true);
      // The URL comes from a mutation first, so the request is sent a little later.
      await vi.waitFor(() => expect(aborts).toEqual(["sent"]));
      controller.abort();
      const failure = await pending.then(
        () => undefined,
        (error: unknown) => error,
      );
      expect((failure as { name?: string }).name).toBe("AbortError");
      expect(aborts).toEqual(["sent", "aborted"]);
      expect(upload.pending()).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
