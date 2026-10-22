import { describe, expect, it } from "vitest";
import { fetchQuery } from "../src/fetch";

describe("SEC-20x Convex server helpers", () => {
  it("[SEC-200] a token passed to one call never reaches a later call (a fresh client per call)", async () => {
    const tokens: Array<string | undefined> = [];
    const createClient = () => {
      let token: string | undefined;
      return {
        setAuth: (value: string) => {
          token = value;
        },
        query: async () => {
          tokens.push(token);
          return null;
        },
        mutation: async () => null,
        action: async () => null,
      };
    };
    const fn = {} as never;
    await fetchQuery(
      "https://app.convex.cloud",
      fn,
      {} as never,
      { token: "secret-token", createClient } as never,
    );
    await fetchQuery("https://app.convex.cloud", fn, {} as never, { createClient } as never);
    expect(tokens[1]).toBeUndefined();
  });

  it("[SEC-201] an empty deployment URL is refused before any client is built", () => {
    expect(() => fetchQuery("", {} as never, {} as never)).toThrow(TypeError);
  });
});
