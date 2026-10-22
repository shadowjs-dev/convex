import { ConvexClient } from "convex/browser";
import { describe, expect, it } from "vitest";
import { ConvexProvider, createConvexClient, ServerConvexProvider, useConvex } from "../src/client";
import { FakeConvexClient, FakeHttpClient } from "./support/fake-client";
import { api } from "./support/refs";
import { mount, mountWith } from "./support/root";

describe("createConvexClient", () => {
  it("[CLI-1] returns a real ConvexClient", () => {
    const client = createConvexClient("https://happy-otter-123.convex.cloud", { disabled: true });
    expect(client).toBeInstanceOf(ConvexClient);
  });

  it("[CLI-2] options are passed through: disabled stays set on the returned client", () => {
    const client = createConvexClient("https://happy-otter-123.convex.cloud", { disabled: true });
    expect(client.disabled).toBe(true);
  });

  it("[CLI-3] a URL that is not http(s) is rejected", () => {
    expect(() =>
      createConvexClient("ftp://happy-otter-123.convex.cloud", { disabled: true }),
    ).toThrow(/Must start with/);
  });

  it("[CLI-4] a .convex.site address (the HTTP actions host) is rejected by default", () => {
    expect(() =>
      createConvexClient("https://happy-otter-123.convex.site", { disabled: true }),
    ).toThrow(/convex\.site/);
  });

  it("[CLI-5] skipConvexDeploymentUrlCheck lets a self-hosted address through", () => {
    const client = createConvexClient("https://convex.example.internal", {
      disabled: true,
      skipConvexDeploymentUrlCheck: true,
    });
    expect(client).toBeInstanceOf(ConvexClient);
  });

  it("[CLI-6] a disabled real client accepts subscriptions without opening a socket", () => {
    const client = createConvexClient("https://happy-otter-123.convex.cloud", { disabled: true });
    const stop = client.onUpdate(api.tasks.list, {}, () => undefined);
    expect(typeof stop).toBe("function");
    stop();
  });
});

describe("ConvexProvider and useConvex", () => {
  it("[CLI-7] useConvex returns the client of the nearest provider", () => {
    const client = new FakeConvexClient();
    const { value } = mountWith(client, () => useConvex());
    expect(value).toBe(client);
  });

  it("[CLI-8] nested providers: the innermost client wins", () => {
    const outer = new FakeConvexClient();
    const inner = new FakeConvexClient();
    let seen: unknown;
    mountWith(outer, () => {
      mountWith(inner, () => {
        seen = useConvex();
        return null;
      });
      return null;
    });
    expect(seen).toBe(inner);
  });

  it("[CLI-9] useConvex without a provider throws an error that names ConvexProvider", () => {
    expect(() => mount(() => useConvex())).toThrow(/ConvexProvider/);
  });

  it("[CLI-10] the error for a missing provider explains how to fix it", () => {
    let message = "";
    try {
      mount(() => useConvex());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain("must be used inside <ConvexProvider>");
  });

  it("[CLI-11] ConvexProvider returns an accessor of its children, which reads them reactively", () => {
    const client = new FakeConvexClient();
    const result = mount(() =>
      ConvexProvider({
        client,
        get children() {
          return "rendered";
        },
      }),
    );
    expect(readAccessor(result.value)).toBe("rendered");
  });

  it("[CLI-12] ServerConvexProvider returns an accessor of its children and fetches nothing by itself", () => {
    const http = new FakeHttpClient();
    const result = mount(() =>
      ServerConvexProvider({
        client: http,
        get children() {
          return 42;
        },
      }),
    );
    expect(readAccessor(result.value)).toBe(42);
    expect(http.queries.length).toBe(0);
  });
});

/** Reads the accessor a provider returns. The provider wraps its children in one. */
function readAccessor(value: unknown): unknown {
  if (typeof value !== "function") throw new TypeError("expected an accessor");
  return (value as () => unknown)();
}
