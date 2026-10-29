import { createRoot, flushSync, useSignal } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { ConvexProviderWithAuth } from "../src/index";
import type { ConvexClientLike } from "../src/types";

type Fetcher = (args: { readonly forceRefreshToken: boolean }) => Promise<string | null>;

describe("ConvexProviderWithAuth registrations", () => {
  it("[CVX-R7-1] a replaced fetchAccessToken registers again with the new fetcher, and an equal state does not", () => {
    const registered: Fetcher[] = [];
    let clears = 0;
    const client: ConvexClientLike = {
      setAuth(fetchToken: Fetcher): void {
        registered.push(fetchToken);
      },
      clearAuth(): void {
        clears += 1;
      },
      onUpdate: () => () => undefined,
      mutation: () => Promise.reject(new Error("not used")),
      action: () => Promise.reject(new Error("not used")),
    };
    const [account, setAccount] = useSignal("user_1");
    const [unrelated, setUnrelated] = useSignal(0);
    const fetchers = new Map<string, Fetcher>();
    const fetcherFor = (id: string): Fetcher => {
      const known = fetchers.get(id);
      if (known !== undefined) return known;
      const created: Fetcher = () => Promise.resolve(`token-${id}`);
      fetchers.set(id, created);
      return created;
    };
    const dispose = createRoot((disposeRoot) => {
      ConvexProviderWithAuth({
        client,
        useAuth: () => ({
          isLoading: false,
          isAuthenticated: true,
          get fetchAccessToken() {
            unrelated();
            return fetcherFor(account());
          },
        }),
        children: null,
      });
      return disposeRoot;
    });
    flushSync();
    expect(registered.length).toBe(1);

    setUnrelated(1);
    flushSync();
    expect(registered.length).toBe(1);

    setAccount("user_2");
    flushSync();
    expect(registered.length).toBe(2);
    expect(registered[1]).toBe(fetcherFor("user_2"));
    expect(clears).toBeGreaterThan(0);
    dispose();
  });
});
