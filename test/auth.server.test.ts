import { renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { useConvexAuth } from "../src/auth";

describe("useConvexAuth on the server", () => {
  it("[SSR-A1] without a ConvexProviderWithAuth (the server renders no socket) the auth state is loading, not signed in", () => {
    let state: ReturnType<typeof useConvexAuth> | undefined;
    const html = renderToString(() => {
      state = useConvexAuth();
      return "rendered";
    });
    expect(html).toBe("rendered");
    expect(state?.isLoading()).toBe(true);
    expect(state?.isAuthenticated()).toBe(false);
  });
});
