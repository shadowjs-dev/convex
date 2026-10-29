import { describe, expect, it } from "vitest";
import {
  isPageResult,
  type PageHandlers,
  type PageHost,
  type PageResultShape,
  type PageSpec,
  PaginationModel,
} from "../src/internal/pagination";

interface Opened {
  readonly spec: PageSpec;
  readonly handlers: PageHandlers;
  stopped: boolean;
}

/** Records every page subscription the model opens; the test delivers results by hand. */
class FakePageHost implements PageHost {
  readonly opened: Opened[] = [];
  /** When true, results are delivered synchronously inside `open` (see the synchronous test). */
  syncFor: ((spec: PageSpec) => PageResultShape | undefined) | undefined;

  open(spec: PageSpec, handlers: PageHandlers): () => void {
    const record: Opened = { spec, handlers, stopped: false };
    this.opened.push(record);
    const sync = this.syncFor?.(spec);
    if (sync !== undefined) handlers.onResult(sync);
    return () => {
      record.stopped = true;
    };
  }

  get live(): number {
    return this.opened.filter((record) => !record.stopped).length;
  }

  at(index: number): Opened {
    const record = this.opened[index];
    if (record === undefined) throw new Error(`no subscription ${index}`);
    return record;
  }

  deliver(index: number, result: PageResultShape): void {
    this.at(index).handlers.onResult(result);
  }
}

function page(
  ids: readonly string[],
  continueCursor: string,
  isDone: boolean,
  extra: Partial<PageResultShape> = {},
): PageResultShape {
  return { page: ids, continueCursor, isDone, ...extra };
}

function setup(initial = 2): {
  host: FakePageHost;
  model: PaginationModel;
  changes: { count: number };
} {
  const host = new FakePageHost();
  const changes = { count: 0 };
  const model = new PaginationModel(host, initial, () => {
    changes.count += 1;
  });
  return { host, model, changes };
}

describe("PaginationModel: first page and status", () => {
  it("[PAG-1] start opens one page with a null cursor and the initial size", () => {
    const { host, model } = setup(5);
    model.start();
    expect(host.opened.length).toBe(1);
    expect(host.at(0).spec).toEqual({ cursor: null, numItems: 5 });
    expect(host.at(0).spec.endCursor).toBeUndefined();
  });

  it("[PAG-2] the status is LoadingFirstPage until the first page arrives", () => {
    const { model, host } = setup();
    model.start();
    expect(model.snapshot().status).toBe("LoadingFirstPage");
    expect(model.snapshot().results).toEqual([]);
    host.deliver(0, page(["a"], "c1", false));
    expect(model.snapshot().status).toBe("CanLoadMore");
  });

  it("[PAG-3] a loaded page is reported as CanLoadMore with its items", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a", "b"], "c1", false));
    expect(model.snapshot()).toMatchObject({ results: ["a", "b"], status: "CanLoadMore" });
  });

  it("[PAG-4] a page with isDone is Exhausted", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", true));
    expect(model.snapshot().status).toBe("Exhausted");
  });

  it("[PAG-5] every change is reported through onChange", () => {
    const { model, host, changes } = setup();
    model.start();
    const afterStart = changes.count;
    host.deliver(0, page(["a"], "c1", false));
    expect(changes.count).toBeGreaterThan(afterStart);
  });
});

describe("PaginationModel: loading more", () => {
  it("[PAG-6] loadMore opens the next page after the continue cursor", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", false));
    expect(model.loadMore(3)).toBe(true);
    expect(host.at(1).spec).toEqual({ cursor: "c1", numItems: 3 });
  });

  it("[PAG-7] loadMore returns false while the last page has not arrived", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", false));
    expect(model.loadMore(2)).toBe(true);
    expect(model.loadMore(2)).toBe(false);
    expect(host.opened.length).toBe(2);
  });

  it("[PAG-8] while a further page loads, the status is LoadingMore and earlier items stay", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a", "b"], "c1", false));
    model.loadMore(2);
    expect(model.snapshot()).toMatchObject({ results: ["a", "b"], status: "LoadingMore" });
  });

  it("[PAG-9] items of successive pages are stitched in order", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", false));
    model.loadMore(2);
    host.deliver(1, page(["b", "c"], "c2", true));
    expect(model.snapshot()).toMatchObject({ results: ["a", "b", "c"], status: "Exhausted" });
  });

  it("[PAG-10] loadMore returns false once the results are exhausted", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", true));
    expect(model.loadMore(2)).toBe(false);
    expect(host.opened.length).toBe(1);
  });

  it("[PAG-11] a page delivered twice replaces itself instead of duplicating its items", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", false));
    host.deliver(0, page(["a"], "c1", false));
    expect(model.snapshot().results).toEqual(["a"]);
  });

  it("[PAG-12] fifty pages open fifty subscriptions and dispose stops all of them", () => {
    const { model, host } = setup();
    model.start();
    for (let i = 1; i <= 50; i += 1) {
      host.deliver(i - 1, page([`item${i}`], `c${i}`, false));
      expect(model.loadMore(1)).toBe(true);
    }
    expect(model.snapshot().results.length).toBe(50);
    expect(host.live).toBe(51);
    model.dispose();
    expect(host.live).toBe(0);
    expect(model.openSubscriptions).toBe(0);
  });
});

describe("PaginationModel: splitting oversized pages", () => {
  it("[PAG-13] a page flagged SplitRecommended opens two halves bounded by endCursor", () => {
    const { model, host } = setup(2);
    model.start();
    host.deliver(
      0,
      page(["a", "b", "c"], "c9", false, { splitCursor: "s5", pageStatus: "SplitRecommended" }),
    );
    expect(host.opened.length).toBe(3);
    expect(host.at(1).spec).toEqual({ cursor: null, endCursor: "s5", numItems: 2 });
    expect(host.at(2).spec).toEqual({ cursor: "s5", endCursor: "c9", numItems: 2 });
  });

  it("[PAG-14] a page larger than twice the initial size splits even without pageStatus", () => {
    const { model, host } = setup(2);
    model.start();
    host.deliver(0, page(["a", "b", "c", "d", "e"], "c9", false, { splitCursor: "s5" }));
    expect(host.opened.length).toBe(3);
  });

  it("[PAG-15] a page without splitCursor is never split", () => {
    const { model, host } = setup(2);
    model.start();
    host.deliver(0, page(["a", "b", "c", "d", "e"], "c9", false, { pageStatus: "SplitRequired" }));
    expect(host.opened.length).toBe(1);
  });

  it("[PAG-16] while the halves load, the original page stays visible", () => {
    const { model, host } = setup(2);
    model.start();
    host.deliver(
      0,
      page(["a", "b", "c"], "c9", false, { splitCursor: "s5", pageStatus: "SplitRequired" }),
    );
    expect(model.snapshot().results).toEqual(["a", "b", "c"]);
    host.deliver(1, page(["a"], "s5", false));
    expect(model.snapshot().results).toEqual(["a", "b", "c"]);
  });

  it("[PAG-17] when both halves are in, they replace the original page and its subscription stops", () => {
    const { model, host } = setup(2);
    model.start();
    host.deliver(
      0,
      page(["a", "b", "c"], "c9", false, { splitCursor: "s5", pageStatus: "SplitRequired" }),
    );
    host.deliver(1, page(["a", "b"], "s5", false));
    host.deliver(2, page(["c"], "c9", true));
    expect(model.snapshot().results).toEqual(["a", "b", "c"]);
    expect(model.snapshot().status).toBe("Exhausted");
    expect(host.at(0).stopped).toBe(true);
    expect(host.live).toBe(2);
  });

  it("[PAG-18] loadMore after a split continues from the last half's continue cursor", () => {
    const { model, host } = setup(2);
    model.start();
    host.deliver(
      0,
      page(["a", "b", "c"], "c9", false, { splitCursor: "s5", pageStatus: "SplitRequired" }),
    );
    host.deliver(1, page(["a", "b"], "s5", false));
    host.deliver(2, page(["c"], "c9", false));
    expect(model.loadMore(4)).toBe(true);
    expect(host.at(3).spec).toEqual({ cursor: "c9", numItems: 4 });
  });

  it("[PAG-19] a half that is itself oversized splits again (nested split)", () => {
    const { model, host } = setup(2);
    model.start();
    host.deliver(
      0,
      page(["a", "b", "c", "d"], "c9", false, { splitCursor: "s5", pageStatus: "SplitRequired" }),
    );
    host.deliver(
      1,
      page(["a", "b", "c"], "s5", false, { splitCursor: "s2", pageStatus: "SplitRequired" }),
    );
    expect(host.opened.length).toBe(5);
    host.deliver(2, page(["d"], "c9", true));
    host.deliver(3, page(["a"], "s2", false));
    host.deliver(4, page(["b", "c"], "s5", false));
    expect(model.snapshot().results).toEqual(["a", "b", "c", "d"]);
  });

  it("[PAG-20] a split is decided once: a repeated oversized result does not start another split", () => {
    const { model, host } = setup(2);
    model.start();
    const big = page(["a", "b", "c"], "c9", false, {
      splitCursor: "s5",
      pageStatus: "SplitRequired",
    });
    host.deliver(0, big);
    host.deliver(0, big);
    expect(host.opened.length).toBe(3);
  });
});

describe("PaginationModel: lifecycle and errors", () => {
  it("[PAG-21] dispose stops every subscription and later results are ignored", () => {
    const { model, host, changes } = setup();
    model.start();
    const before = changes.count;
    model.dispose();
    host.deliver(0, page(["late"], "c1", false));
    expect(model.snapshot().results).toEqual([]);
    expect(changes.count).toBe(before);
    expect(host.live).toBe(0);
  });

  it("[PAG-22] dispose is idempotent", () => {
    const { model, host } = setup();
    model.start();
    model.dispose();
    model.dispose();
    expect(host.live).toBe(0);
  });

  it("[PAG-23] loadMore after dispose returns false and opens nothing", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", false));
    model.dispose();
    expect(model.loadMore(2)).toBe(false);
    expect(host.opened.length).toBe(1);
  });

  it("[PAG-24] a host error is reported as the snapshot error without changing the items", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", false));
    host.at(0).handlers.onError(new Error("boom"));
    expect(model.snapshot().error).toEqual(new Error("boom"));
    expect(model.snapshot().results).toEqual(["a"]);
  });

  it("[CVX-REV-1] a page that failed and then delivers a result clears its error", () => {
    // The real client keeps a query subscribed after an error and calls the callback again when the query recovers.
    const { model, host } = setup();
    model.start();
    host.at(0).handlers.onError(new Error("boom"));
    expect(model.snapshot().error).toEqual(new Error("boom"));
    host.deliver(0, page(["a"], "c1", false));
    expect(model.snapshot().error).toBeUndefined();
    expect(model.snapshot().results).toEqual(["a"]);
  });

  it("[CVX-REV-1] an error of one page stays while another page recovers", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page(["a"], "c1", false));
    model.loadMore(2);
    host.at(0).handlers.onError(new Error("first"));
    host.at(1).handlers.onError(new Error("second"));
    host.deliver(1, page(["b"], "c2", true));
    expect(model.snapshot().error).toEqual(new Error("first"));
    host.deliver(0, page(["a"], "c1", false));
    expect(model.snapshot().error).toBeUndefined();
  });

  it("[PAG-25] a result delivered synchronously inside open is not lost", () => {
    const host = new FakePageHost();
    host.syncFor = (spec) => (spec.cursor === null ? page(["a"], "c1", false) : undefined);
    const model = new PaginationModel(host, 2, () => undefined);
    model.start();
    expect(model.snapshot().results).toEqual(["a"]);
  });

  it("[PAG-26] a synchronous split inside open registers both halves before they deliver", () => {
    const host = new FakePageHost();
    host.syncFor = (spec) => {
      if (spec.cursor === null && spec.endCursor === undefined) {
        return page(["a", "b", "c"], "c9", false, {
          splitCursor: "s5",
          pageStatus: "SplitRequired",
        });
      }
      if (spec.endCursor === "s5") return page(["a", "b"], "s5", false);
      if (spec.endCursor === "c9") return page(["c"], "c9", true);
      return undefined;
    };
    const model = new PaginationModel(host, 2, () => undefined);
    model.start();
    expect(model.snapshot().results).toEqual(["a", "b", "c"]);
    expect(model.snapshot().status).toBe("Exhausted");
  });

  it("[PAG-27] an open subscription count is zero for a model that never started", () => {
    const { model, host } = setup();
    expect(model.openSubscriptions).toBe(0);
    expect(host.opened.length).toBe(0);
  });

  it("[PAG-28] an empty first page with a more to come is LoadingFirstPage-free: CanLoadMore", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page([], "c1", false));
    expect(model.snapshot().status).toBe("CanLoadMore");
  });
});

describe("PaginationModel: status with empty pages", () => {
  it("[CVX-REV-5] loading a further page after an empty first page is LoadingMore, not LoadingFirstPage", () => {
    const { model, host } = setup();
    model.start();
    host.deliver(0, page([], "c1", false));
    expect(model.loadMore(2)).toBe(true);
    expect(model.snapshot().results).toEqual([]);
    expect(model.snapshot().status).toBe("LoadingMore");
    host.deliver(1, page(["a"], "c2", true));
    expect(model.snapshot().status).toBe("Exhausted");
  });
});

describe("isPageResult", () => {
  it("[PAG-29] accepts a complete page result", () => {
    expect(isPageResult({ page: [], isDone: true, continueCursor: "c" })).toBe(true);
  });

  it.each([
    ["null", null],
    ["a number", 3],
    ["a missing page", { isDone: true, continueCursor: "c" }],
    ["a page that is not an array", { page: {}, isDone: true, continueCursor: "c" }],
    ["a non-boolean isDone", { page: [], isDone: "yes", continueCursor: "c" }],
    ["a missing cursor", { page: [], isDone: false }],
  ])("[PAG-30] rejects %s", (_label, value) => {
    expect(isPageResult(value)).toBe(false);
  });
});
