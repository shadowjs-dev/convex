import { createContext, flushSync, useContext, useSignal } from "@shadow-js/core";
import { render } from "@shadow-js/web";
import { afterEach, describe, expect, it } from "vitest";
import { Authenticated, AuthLoading, ConvexProviderWithAuth, Unauthenticated } from "../src/index";

const hosts: HTMLElement[] = [];
afterEach(() => {
  for (const h of hosts.splice(0)) h.remove();
});

describe("auth guards keep the providers above them", () => {
  it("[CVX-AUTH-CTX] a child of Authenticated can use the Convex context (it is built in the guard's scope)", async () => {
    const [signedIn, setSignedIn] = useSignal(true);
    const client = {
      setAuth(_fetch: unknown, onChange?: (authenticated: boolean) => void) {
        queueMicrotask(() => onChange?.(true));
      },
      clearAuth: () => undefined,
      onUpdate: () => () => undefined,
      mutation: async () => undefined,
      action: async () => undefined,
      close: async () => undefined,
    };
    const Theme = createContext<string>("none");
    const seen: string[] = [];
    const Child = (): unknown => {
      seen.push(useContext(Theme));
      return "child";
    };
    const host = document.createElement("div");
    document.body.append(host);
    hosts.push(host);
    render(
      () =>
        Theme({
          value: "dark",
          get children() {
            return ConvexProviderWithAuth({
              client: client as never,
              useAuth: () => ({
                isLoading: false,
                get isAuthenticated() {
                  return signedIn();
                },
                fetchAccessToken: async () => "token",
              }),
              get children() {
                return [
                  Authenticated({
                    get children() {
                      return Child();
                    },
                  }),
                  Unauthenticated({ children: "out" }),
                  AuthLoading({ children: "loading" }),
                ];
              },
            });
          },
        }),
      host,
    );
    await Promise.resolve();
    flushSync();
    await Promise.resolve();
    flushSync();
    expect(host.textContent).toContain("child");
    expect(seen).toEqual(["dark"]);
    setSignedIn(false);
    flushSync();
    expect(host.textContent).not.toContain("child");
    expect(host.textContent).toContain("out");
  });
});
