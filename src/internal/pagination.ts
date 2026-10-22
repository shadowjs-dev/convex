import type { PaginationStatus } from "../types";
import { isRecord } from "./args";

/**
 * One page as the server returns it for `paginationOpts`. `splitCursor` and `pageStatus` are
 * optional: they appear when the query reads a lot of data, and then the page is split in two.
 * @internal
 */
export interface PageResultShape {
  readonly page: readonly unknown[];
  readonly isDone: boolean;
  readonly continueCursor: string;
  readonly splitCursor?: string | null | undefined;
  readonly pageStatus?: "SplitRecommended" | "SplitRequired" | null | undefined;
}

/**
 * The `paginationOpts` one page subscription runs with. `endCursor` is set only for the halves of a
 * split page, where it bounds the range the half covers.
 * @internal
 */
export interface PageSpec {
  readonly cursor: string | null;
  readonly endCursor?: string | null;
  readonly numItems: number;
}

/** Callbacks a page subscription delivers to. @internal */
export interface PageHandlers {
  readonly onResult: (result: PageResultShape) => void;
  readonly onError: (error: unknown) => void;
}

/**
 * Opens one page subscription and returns its stop function. The hook implements this on top of
 * `client.onUpdate`; tests implement it directly.
 * @internal
 */
export interface PageHost {
  open(spec: PageSpec, handlers: PageHandlers): () => void;
}

/** What the hook shows: the stitched results, the status and the last error. @internal */
export interface PaginationSnapshot {
  readonly results: unknown[];
  readonly status: PaginationStatus;
  readonly error: unknown;
}

/** A page slot in the tree. A slot splits into two child slots when its page is too large. */
interface Slot {
  readonly spec: PageSpec;
  readonly parent: Slot | null;
  result: PageResultShape | undefined;
  split: { readonly first: Slot; readonly second: Slot } | null;
  stop: (() => void) | undefined;
  stopped: boolean;
}

/** Shape check for a server page result: the fields the pagination logic reads. @internal */
export function isPageResult(value: unknown): value is PageResultShape {
  if (!isRecord(value)) return false;
  return (
    Array.isArray(value["page"]) &&
    typeof value["isDone"] === "boolean" &&
    typeof value["continueCursor"] === "string"
  );
}

/**
 * Pure pagination state: a list of page slots, each backed by one page subscription. `loadMore`
 * appends a slot after the last loaded page; a page the server reports as too large is replaced by
 * two half-pages once both have loaded (the same protocol as convex's own paginated client).
 *
 * The model never touches signals: it reports changes through `onChange` and the hook turns them
 * into state. Every callback checks whether its slot is still live, so a stopped or disposed model
 * ignores late results.
 * @internal
 */
export class PaginationModel {
  private readonly host: PageHost;
  private readonly initialNumItems: number;
  private readonly onChange: () => void;
  private readonly roots: Slot[] = [];
  private failure: { readonly error: unknown } | undefined;
  private disposed = false;

  constructor(host: PageHost, initialNumItems: number, onChange: () => void) {
    this.host = host;
    this.initialNumItems = initialNumItems;
    this.onChange = onChange;
  }

  /** Opens the first page. Call once. */
  start(): void {
    const first = this.slot({ cursor: null, numItems: this.initialNumItems }, null);
    this.roots.push(first);
    this.open(first);
    this.changed();
  }

  /**
   * Requests the next page after the last loaded one. Returns false when nothing can be loaded: the
   * model is disposed, the last page has not arrived yet, or the results are exhausted.
   */
  loadMore(numItems: number): boolean {
    if (this.disposed) return false;
    const last = this.visible().at(-1);
    if (last?.result === undefined || last.result.isDone) return false;
    const next = this.slot({ cursor: last.result.continueCursor, numItems }, null);
    this.roots.push(next);
    this.open(next);
    this.changed();
    return true;
  }

  /** The stitched results, the status and the last error. */
  snapshot(): PaginationSnapshot {
    const visible = this.visible();
    const results: unknown[] = [];
    let loading = false;
    for (const slot of visible) {
      if (slot.result === undefined) {
        loading = true;
        continue;
      }
      for (const item of slot.result.page) results.push(item);
    }
    let status: PaginationStatus;
    if (loading) {
      status = results.length === 0 ? "LoadingFirstPage" : "LoadingMore";
    } else {
      const last = visible.at(-1);
      status = last?.result?.isDone === true ? "Exhausted" : "CanLoadMore";
    }
    return { results, status, error: this.failure?.error };
  }

  /** Number of page subscriptions that are still open. Used to check that nothing leaks. */
  get openSubscriptions(): number {
    let count = 0;
    for (const slot of this.allSlots()) if (!slot.stopped) count += 1;
    return count;
  }

  /** Stops every subscription. Idempotent; late results are ignored afterward. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.allSlots()) {
      if (slot.stopped) continue;
      slot.stopped = true;
      slot.stop?.();
    }
  }

  /** The slots that define what is shown, in order: a split slot is replaced by its halves. */
  private visible(): Slot[] {
    const out: Slot[] = [];
    const stack: Slot[] = [];
    for (let i = this.roots.length - 1; i >= 0; i -= 1) {
      const root = this.roots[i];
      if (root !== undefined) stack.push(root);
    }
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      const split = node.split;
      if (split !== null && split.first.result !== undefined && split.second.result !== undefined) {
        stack.push(split.second, split.first);
      } else {
        out.push(node);
      }
    }
    return out;
  }

  /** Every slot ever created (iterative: split depth is data driven). */
  private allSlots(): Slot[] {
    const out: Slot[] = [];
    const stack: Slot[] = [...this.roots];
    for (let node = stack.pop(); node !== undefined; node = stack.pop()) {
      out.push(node);
      if (node.split !== null) stack.push(node.split.first, node.split.second);
    }
    return out;
  }

  private slot(spec: PageSpec, parent: Slot | null): Slot {
    return { spec, parent, result: undefined, split: null, stop: undefined, stopped: false };
  }

  private open(slot: Slot): void {
    const stop = this.host.open(slot.spec, {
      onResult: (result) => this.receive(slot, result),
      onError: (error) => this.fail(slot, error),
    });
    // The host may deliver synchronously, or the model may be disposed, before `open` returns.
    if (slot.stopped || this.disposed) {
      slot.stopped = true;
      stop();
    } else {
      slot.stop = stop;
    }
  }

  private receive(slot: Slot, result: PageResultShape): void {
    if (slot.stopped || this.disposed) return;
    slot.result = result;
    const parent = slot.parent;
    if (parent !== null) this.retireWhenHalvesLoaded(parent);
    if (slot.split === null && typeof result.splitCursor === "string" && this.shouldSplit(result)) {
      this.split(slot, result.splitCursor, result.continueCursor);
    }
    this.changed();
  }

  /** Once both halves are in, the parent page is no longer shown, so its subscription is dropped. */
  private retireWhenHalvesLoaded(parent: Slot): void {
    const split = parent.split;
    if (split === null || parent.stopped) return;
    if (split.first.result === undefined || split.second.result === undefined) return;
    parent.stopped = true;
    parent.stop?.();
  }

  private shouldSplit(result: PageResultShape): boolean {
    if (result.pageStatus === "SplitRecommended" || result.pageStatus === "SplitRequired") {
      return true;
    }
    return result.page.length > this.initialNumItems * 2;
  }

  private split(slot: Slot, splitCursor: string, continueCursor: string): void {
    const first = this.slot(
      { cursor: slot.spec.cursor, endCursor: splitCursor, numItems: this.initialNumItems },
      slot,
    );
    const second = this.slot(
      { cursor: splitCursor, endCursor: continueCursor, numItems: this.initialNumItems },
      slot,
    );
    // Both halves are registered before either opens: a synchronous result must see the split.
    slot.split = { first, second };
    this.open(first);
    this.open(second);
  }

  private fail(slot: Slot, error: unknown): void {
    if (slot.stopped || this.disposed) return;
    this.failure = { error };
    this.changed();
  }

  private changed(): void {
    if (!this.disposed) this.onChange();
  }
}
