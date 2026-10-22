import { flushSync, useRenderEffect, useSignal } from "@shadow-js/core";
import { describe, expect, it } from "vitest";
import { usePaginatedQuery } from "../src/paginated";
import { FakeConvexClient } from "./support/fake-client";
import { api, msg, pageOf } from "./support/refs";
import { mount, mountWith } from "./support/root";

const QUERY = "messages:page";

describe("usePaginatedQuery: pages and status", () => {
  it("[PGN-1] subscribes to the first page with a null cursor and the initial size", () => {
    const client = new FakeConvexClient();
    mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "general" }, { initialNumItems: 20 }),
    );
    expect(client.created.length).toBe(1);
    expect(client.created[0]?.name).toBe(QUERY);
    expect(client.created[0]?.args).toEqual({
      channel: "general",
      paginationOpts: { numItems: 20, cursor: null },
    });
  });

  it("[PGN-2] starts in LoadingFirstPage and isLoading is true", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    expect(list.status()).toBe("LoadingFirstPage");
    expect(list.isLoading()).toBe(true);
    expect(list.results()).toEqual([]);
  });

  it("[PGN-3] a delivered first page fills results and allows loading more", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(QUERY, pageOf([msg("1"), msg("2")], "c1", false));
    expect(list.results()).toEqual([msg("1"), msg("2")]);
    expect(list.status()).toBe("CanLoadMore");
    expect(list.isLoading()).toBe(false);
  });

  it("[PGN-4] loadMore subscribes to the next page from the continue cursor", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(QUERY, pageOf([msg("1")], "c1", false));
    expect(list.loadMore(5)).toBe(true);
    expect(client.created[1]?.args).toEqual({
      channel: "a",
      paginationOpts: { numItems: 5, cursor: "c1" },
    });
  });

  it("[PGN-5] while the second page loads, the status is LoadingMore and the first page stays", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(QUERY, pageOf([msg("1")], "c1", false));
    list.loadMore(2);
    expect(list.status()).toBe("LoadingMore");
    expect(list.isLoading()).toBe(true);
    expect(list.results()).toEqual([msg("1")]);
  });

  it("[PGN-6] the results of several pages are concatenated, and the last isDone exhausts them", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(QUERY, pageOf([msg("1")], "c1", false));
    list.loadMore(2);
    client.emit(QUERY, pageOf([msg("2"), msg("3")], "c2", true), {
      channel: "a",
      paginationOpts: { numItems: 2, cursor: "c1" },
    });
    expect(list.results()).toEqual([msg("1"), msg("2"), msg("3")]);
    expect(list.status()).toBe("Exhausted");
    expect(list.loadMore(2)).toBe(false);
  });

  it("[PGN-7] a page that the server splits is replaced by its two halves, each with an endCursor", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(
      QUERY,
      pageOf([msg("1"), msg("2"), msg("3")], "c9", false, {
        splitCursor: "s5",
        pageStatus: "SplitRequired",
      }),
    );
    const halves = client.created.slice(1);
    expect(halves.map((sub) => sub.args)).toEqual([
      { channel: "a", paginationOpts: { numItems: 2, cursor: null, endCursor: "s5" } },
      { channel: "a", paginationOpts: { numItems: 2, cursor: "s5", endCursor: "c9" } },
    ]);
    client.created[1]?.deliver(pageOf([msg("1"), msg("2")], "s5", false));
    client.created[2]?.deliver(pageOf([msg("3")], "c9", true));
    expect(list.results()).toEqual([msg("1"), msg("2"), msg("3")]);
    expect(list.status()).toBe("Exhausted");
  });

  it("[PGN-8] a page result with the wrong shape is reported as an error, not as items", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(QUERY, { notAPage: true });
    expect(list.error()).toBeInstanceOf(TypeError);
    expect(list.results()).toEqual([]);
  });

  it("[PGN-9] a subscription error is exposed through error()", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    const failure = new Error("network");
    client.fail(QUERY, failure);
    expect(list.error()).toBe(failure);
  });
});

describe("usePaginatedQuery: arguments and lifecycle", () => {
  it("[PGN-10] changing the arguments restarts from the first page and stops every old page", () => {
    const client = new FakeConvexClient();
    const [channel, setChannel] = useSignal("a");
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, () => ({ channel: channel() }), { initialNumItems: 2 }),
    );
    client.emit(QUERY, pageOf([msg("1")], "c1", false), {
      channel: "a",
      paginationOpts: { numItems: 2, cursor: null },
    });
    list.loadMore(2);
    setChannel("b");
    flushSync();
    expect(list.status()).toBe("LoadingFirstPage");
    expect(list.results()).toEqual([]);
    expect(client.liveCount).toBe(1);
    expect(client.created.at(-1)?.args).toEqual({
      channel: "b",
      paginationOpts: { numItems: 2, cursor: null },
    });
  });

  it("[PGN-11] unmounting stops every page subscription", () => {
    const client = new FakeConvexClient();
    const { value: list, dispose } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(QUERY, pageOf([msg("1")], "c1", false));
    list.loadMore(2);
    expect(client.liveCount).toBe(2);
    dispose();
    expect(client.liveCount).toBe(0);
  });

  it("[PGN-12] a page delivered after unmount is ignored", () => {
    const client = new FakeConvexClient();
    const { value: list, dispose } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    dispose();
    client.created[0]?.deliver(pageOf([msg("late")], "c1", false));
    expect(list.results()).toEqual([]);
  });

  it("[PGN-13] initialNumItems must be an integer of at least 1", () => {
    const client = new FakeConvexClient();
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() =>
        mountWith(client, () =>
          usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: bad }),
        ),
      ).toThrow(RangeError);
    }
    expect(client.created.length).toBe(0);
  });

  it("[PGN-14] loadMore rejects a size that is not a positive integer", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    client.emit(QUERY, pageOf([msg("1")], "c1", false));
    expect(() => list.loadMore(0)).toThrow(RangeError);
    expect(() => list.loadMore(2.5)).toThrow(RangeError);
  });

  it("[PGN-15] loadMore before the first page arrives returns false and requests nothing", () => {
    const client = new FakeConvexClient();
    const { value: list } = mountWith(client, () =>
      usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 }),
    );
    expect(list.loadMore(2)).toBe(false);
    expect(client.created.length).toBe(1);
  });

  it("[PGN-16] without a ConvexProvider, creating the hook throws a message that names the provider", () => {
    expect(() =>
      mount(() => usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 })),
    ).toThrow(/ConvexProvider/);
  });

  it("[PGN-17] the status accessor is reactive: an effect reading it sees each change", () => {
    const client = new FakeConvexClient();
    const seen: string[] = [];
    mountWith(client, () => {
      const list = usePaginatedQuery(api.messages.page, { channel: "a" }, { initialNumItems: 2 });
      useRenderEffect(
        () => list.status(),
        (status) => {
          seen.push(status);
        },
      );
      return list;
    });
    client.emit(QUERY, pageOf([msg("1")], "c1", true));
    expect(seen).toEqual(["LoadingFirstPage", "Exhausted"]);
  });
});
