import { type Accessor, batch, useSignal } from "@shadow-js/core";
import { useConvexForCalls } from "./client";
import { runMutation } from "./internal/adapters";
import { isLoopbackHost } from "./internal/deployment-url";
import { readBoundedBytes } from "./internal/guarded-fetch";
import type { ConvexClientLike, MutationRef } from "./types";

/**
 * Bytes sent so far for one upload, as passed to the `onProgress` option of {@link UploadOptions}.
 *
 * @example
 * ```ts
 * import type { UploadProgress } from "@shadow-js/convex";
 *
 * function percent(progress: UploadProgress): string {
 *   if (progress.total === 0) return "100%";
 *   return `${Math.round((progress.loaded / progress.total) * 100)}%`;
 * }
 *
 * percent({ loaded: 512, total: 2048 });
 * ```
 * @since 1.0.0
 */
export interface UploadProgress {
  /** Bytes sent so far. */
  readonly loaded: number;
  /**
   * Bytes to send in all: the size the browser reports for the request, or the file size when it
   * reports none. Can be `0` for an empty file.
   */
  readonly total: number;
}

/**
 * Options of one upload call.
 *
 * @example
 * ```ts
 * import { type MutationRef, type UploadOptions, useUploadFile } from "@shadow-js/convex";
 *
 * // Stands in for `api.files.generateUploadUrl` from convex/_generated/api.
 * declare const generateUploadUrl: MutationRef;
 *
 * export function useCancelableUpload() {
 *   const upload = useUploadFile(generateUploadUrl);
 *   const controller = new AbortController();
 *   const start = (file: Blob) => {
 *     const options: UploadOptions = {
 *       signal: controller.signal,
 *       allowedOrigins: ["https://files.example.com"],
 *       onProgress: ({ loaded, total }) => console.info(`${loaded} of ${total} bytes`),
 *     };
 *     return upload(file, options);
 *   };
 *   return { start, cancel: () => controller.abort() };
 * }
 * ```
 * @since 1.0.0
 */
export interface UploadOptions {
  /**
   * Called as bytes are sent. Browsers with `XMLHttpRequest` report every chunk; the `fetch` path
   * reports only completion, because `fetch` has no upload progress events.
   */
  readonly onProgress?: (progress: UploadProgress) => void;
  /**
   * Aborts the upload: the request is canceled and the call rejects with an `AbortError`. An
   * already aborted signal rejects before anything is requested.
   */
  readonly signal?: AbortSignal;
  /**
   * Origins besides the deployment's where the storage endpoint may be, for example
   * `["https://files.example.com"]` when a proxy fronts Convex storage. By default the upload URL
   * must be on the deployment's own origin (when the client exposes it) and use https, or http for a
   * loopback host. An exact origin is compared; a host that merely starts with it does not match.
   */
  readonly allowedOrigins?: readonly string[];
}

/** Largest answer of the storage endpoint accepted: it is `{"storageId":"..."}`. @internal */
const MAX_ANSWER_BYTES = 64 * 1024;

/** Builds the error of a refused upload target. Neither the URL nor its origin is echoed. @internal */
function refusedTarget(reason: string): TypeError {
  return new TypeError(
    `generateUploadUrl returned a URL that is not allowed: ${reason} Pass allowedOrigins to the upload call to allow a storage origin other than the deployment's.`,
  );
}

/** The origin of `value`, or `undefined` when it is not an absolute URL. @internal */
function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin;
  } catch {
    // Not a URL: the caller treats it as "no origin", which refuses the target or ignores the pin.
    return undefined;
  }
}

/**
 * Checks the URL the backend returned before a single byte of the file is sent: https (http only
 * for loopback), no credentials, and on an allowed origin. The deployment's own origin is allowed
 * when the client exposes it; `allowedOrigins` adds more. With neither, only the scheme is checked.
 * Returns the parsed URL, whose `href` is what is requested, so the checked and the used string
 * are the same.
 * @internal
 */
function checkUploadUrl(
  raw: string,
  deployment: string | undefined,
  extra: readonly string[],
): URL {
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    throw refusedTarget("it is not an absolute URL.");
  }
  const secure =
    target.protocol === "https:" ||
    (target.protocol === "http:" && isLoopbackHost(target.hostname));
  if (!secure) throw refusedTarget("it is not https (http is accepted for localhost only).");
  if (target.username !== "" || target.password !== "") {
    throw refusedTarget("it carries credentials.");
  }
  // A listed origin that is not a URL is a typo: refusing it keeps a mistake from widening the pin.
  const listed = extra.map((entry) => {
    const origin = originOf(entry);
    if (origin === undefined) {
      throw new TypeError("allowedOrigins must hold origins such as https://files.example.com.");
    }
    return origin;
  });
  const own = deployment === undefined ? undefined : originOf(deployment);
  const origins = own === undefined ? listed : [own, ...listed];
  if (origins.length > 0 && !origins.includes(target.origin)) {
    throw refusedTarget("its origin is not the deployment's.");
  }
  return target;
}

/**
 * What a successful upload resolves to: the id of the stored file. Convex's `storage.store` and
 * `storage.getUrl` take this id; cast it to your table's `Id` type when you save it in a document.
 *
 * @example
 * ```ts
 * import { type MutationRef, type UploadedFile, useMutation, useUploadFile } from "@shadow-js/convex";
 *
 * // Stand in for `api.files.generateUploadUrl` and `api.users.setAvatar` from convex/_generated/api.
 * declare const generateUploadUrl: MutationRef;
 * declare const setAvatar: MutationRef;
 *
 * export function useAvatarUpload() {
 *   const upload = useUploadFile(generateUploadUrl);
 *   const save = useMutation(setAvatar);
 *   return async (file: Blob): Promise<void> => {
 *     const stored: UploadedFile = await upload(file);
 *     await save({ storageId: stored.storageId });
 *   };
 * }
 * ```
 * @since 1.0.0
 */
export interface UploadedFile {
  /** The id Convex file storage assigned to the uploaded bytes. Always a string. */
  readonly storageId: string;
}

/**
 * The callable returned by {@link useUploadFile}, with the reactive state of its uploads.
 *
 * @example
 * ```tsx
 * import { type MutationRef, type UploadFileHandle, useUploadFile } from "@shadow-js/convex";
 *
 * // Stands in for `api.files.generateUploadUrl` from convex/_generated/api.
 * declare const generateUploadUrl: MutationRef;
 *
 * export function UploadStatus() {
 *   const upload: UploadFileHandle = useUploadFile(generateUploadUrl);
 *   return (
 *     <div>
 *       <progress hidden={!upload.pending()} max={1} value={upload.progress() ?? 0} />
 *       <p role="alert" hidden={upload.error() === undefined}>
 *         The upload failed.
 *         <button type="button" onClick={() => upload.reset()}>
 *           Dismiss
 *         </button>
 *       </p>
 *     </div>
 *   );
 * }
 * ```
 * @since 1.0.0
 */
export interface UploadFileHandle {
  /**
   * Uploads `file` and resolves with its storage id. Rejects with the errors listed on
   * {@link useUploadFile}.
   */
  (file: Blob, options?: UploadOptions): Promise<UploadedFile>;
  /** True while at least one upload has not settled. */
  readonly pending: Accessor<boolean>;
  /** The fraction (0 to 1) sent of the most recent upload, or `undefined` when none is running. */
  readonly progress: Accessor<number | undefined>;
  /** The error of the most recent failed upload; a new upload clears it. */
  readonly error: Accessor<unknown>;
  /** Clears `error`. Does not affect uploads in flight. */
  reset(): void;
}

/** Builds the error of an aborted upload, the same name `fetch` uses for an abort. @internal */
function abortError(): DOMException {
  return new DOMException("The upload was aborted.", "AbortError");
}

/** Throws the abort error when `signal` has already aborted. @internal */
function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw abortError();
}

/**
 * Turns the answer of the storage endpoint into the typed result. Anything without a string
 * `storageId` is an error, so a caller never stores `undefined`.
 * @internal
 */
function storageIdOf(answer: unknown): UploadedFile {
  if (typeof answer === "object" && answer !== null && "storageId" in answer) {
    const storageId: unknown = answer.storageId;
    if (typeof storageId === "string") return { storageId };
  }
  throw new TypeError("The upload response has no storageId string.");
}

/** Parses the JSON body of the storage endpoint; a body that is not JSON is an error. @internal */
function parseAnswer(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    // The parse error quotes the start of the body, which is the other party's text: not chained.
    throw new TypeError("The upload response is not JSON.");
  }
}

/**
 * Accepts the answer text only when it is small and came from the origin the file was posted to.
 * XMLHttpRequest follows redirects without a way to forbid them, so after a redirect this is the
 * check that stops a third party's reply from being trusted as the storage answer.
 * @internal
 */
function boundedAnswer(text: string, responseUrl: string, postedTo: string): string {
  if (responseUrl !== "" && originOf(responseUrl) !== originOf(postedTo)) {
    throw new TypeError("The upload was answered from a different origin than it was sent to.");
  }
  if (text.length > MAX_ANSWER_BYTES) {
    throw new RangeError("The upload response is larger than the allowed size.");
  }
  return text;
}

/** Sends the file with XMLHttpRequest, which reports upload progress. @internal */
function postWithXhr(
  url: string,
  file: Blob,
  contentType: string,
  options: UploadOptions,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const signal = options.signal;
    const onAbort = (): void => {
      xhr.abort();
    };
    const detach = (): void => signal?.removeEventListener("abort", onAbort);
    xhr.open("POST", url, true);
    // The one-time URL authorizes the upload; no cookie or other credential is sent with it.
    xhr.withCredentials = false;
    xhr.setRequestHeader("Content-Type", contentType);
    xhr.upload.onprogress = (event: ProgressEvent) => {
      options.onProgress?.({
        loaded: event.loaded,
        total: event.lengthComputable ? event.total : file.size,
      });
    };
    xhr.onload = () => {
      detach();
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          resolve(parseAnswer(boundedAnswer(xhr.responseText, xhr.responseURL, url)));
        } catch (error) {
          reject(error);
        }
      } else {
        reject(new Error(`The upload failed with HTTP ${xhr.status}.`));
      }
    };
    xhr.onerror = () => {
      detach();
      reject(new TypeError("The upload failed: the network request did not complete."));
    };
    xhr.onabort = () => {
      detach();
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort);
    xhr.send(file);
  });
}

/** Sends the file with `fetch` where XMLHttpRequest is missing (Node, workers). @internal */
async function postWithFetch(
  url: string,
  file: Blob,
  contentType: string,
  options: UploadOptions,
): Promise<unknown> {
  // `redirect: "error"`: a 307 or 308 would re-send the whole file to the new location. No
  // credentials: the one-time URL is the authorization.
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": contentType },
    body: file,
    credentials: "omit",
    redirect: "error",
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  });
  if (!response.ok) throw new Error(`The upload failed with HTTP ${response.status}.`);
  const bytes = await readBoundedBytes(response, MAX_ANSWER_BYTES, options.signal);
  const answer = parseAnswer(new TextDecoder().decode(bytes));
  options.onProgress?.({ loaded: file.size, total: file.size });
  return answer;
}

/**
 * Runs one upload: asks the server for a URL, posts the bytes to it, and returns the storage id.
 * @internal
 */
async function uploadOnce(
  client: ConvexClientLike,
  generateUploadUrl: MutationRef,
  file: Blob,
  options: UploadOptions,
  onFraction: (fraction: number) => void,
): Promise<UploadedFile> {
  throwIfAborted(options.signal);
  const returned: unknown = await runMutation(client, generateUploadUrl, {}, undefined);
  if (typeof returned !== "string") {
    throw new TypeError("generateUploadUrl must return the upload URL as a string.");
  }
  const url = checkUploadUrl(returned, client.client?.url, options.allowedOrigins ?? []).href;
  throwIfAborted(options.signal);
  const contentType = file.type === "" ? "application/octet-stream" : file.type;
  const track: UploadOptions = {
    ...options,
    onProgress: (progress) => {
      onFraction(progress.total === 0 ? 1 : progress.loaded / progress.total);
      options.onProgress?.(progress);
    },
  };
  const answer =
    typeof XMLHttpRequest === "function"
      ? await postWithXhr(url, file, contentType, track)
      : await postWithFetch(url, file, contentType, track);
  return storageIdOf(answer);
}

/**
 * Returns a function that uploads a file to Convex file storage. Each call asks
 * `generateUploadUrl` (a mutation that returns `ctx.storage.generateUploadUrl()`) for a URL, posts
 * the bytes to it with the blob's type as `Content-Type` (`application/octet-stream` when the blob
 * has none), and resolves with the `storageId`. The bytes are sent with `XMLHttpRequest` where it
 * exists, otherwise with `fetch`; no cookie or other credential is sent with them.
 *
 * The handle exposes `pending`, `progress` and `error` as accessors, so a button and a progress bar
 * can read them. Abort with `options.signal`.
 *
 * A call rejects, and sets `error()`, with:
 * - a `DOMException` named `AbortError` when `options.signal` aborts (where the upload uses
 *   `fetch`, an abort reason passed to `abort()` is rejected with instead);
 * - the mutation's error when `generateUploadUrl` fails, and a `TypeError` when it returns
 *   something other than a string;
 * - a `TypeError` when an entry of `allowedOrigins` is not an origin;
 * - a `TypeError` whose message starts with `generateUploadUrl returned a URL that is not allowed`
 *   when the URL is not https (http only for a loopback host), carries credentials, or is not on
 *   the deployment's origin or one of `allowedOrigins`; nothing is sent then;
 * - an `Error` whose message starts with `The upload failed with HTTP` for a status outside
 *   200 to 299, and a `TypeError` when the request does not complete;
 * - a `TypeError` when the answer is not JSON, has no string `storageId`, or comes from another
 *   origin, and a `RangeError` when it is larger than 64 KiB.
 *
 * @param generateUploadUrl A mutation reference that returns a string, for example
 * `api.files.generateUploadUrl`.
 * @returns An {@link UploadFileHandle}.
 * @throws Error when there is no `ConvexProvider` above the component (in the browser). The message
 * starts with `useUploadFile() must be used inside <ConvexProvider>`.
 * @example
 * ```tsx
 * import { type MutationRef, useUploadFile } from "@shadow-js/convex";
 *
 * // Stands in for `api.files.generateUploadUrl` from convex/_generated/api.
 * declare const generateUploadUrl: MutationRef;
 *
 * export function AvatarPicker(props: { onStored: (storageId: string) => void }) {
 *   const upload = useUploadFile(generateUploadUrl);
 *   const onChange = async (input: HTMLInputElement): Promise<void> => {
 *     const file = input.files?.[0];
 *     if (file === undefined) return;
 *     const { storageId } = await upload(file);
 *     props.onStored(storageId);
 *   };
 *   return (
 *     <label>
 *       Avatar
 *       <input type="file" accept="image/*" onChange={(event) => void onChange(event.currentTarget)} />
 *       <span>{() => `${Math.round((upload.progress() ?? 0) * 100)}%`}</span>
 *     </label>
 *   );
 * }
 * ```
 * @see {@link UploadOptions}
 * @since 1.0.0
 */
export function useUploadFile(generateUploadUrl: MutationRef): UploadFileHandle {
  const client = useConvexForCalls("useUploadFile").client;
  const [active, setActive] = useSignal(0);
  const [fraction, setFraction] = useSignal<number | undefined>(undefined);
  const [failure, setFailure] = useSignal<{ readonly error: unknown } | undefined>(undefined, {
    equals: false,
  });

  const upload = (file: Blob, options: UploadOptions = {}): Promise<UploadedFile> => {
    batch(() => {
      setActive((count) => count + 1);
      setFailure(undefined);
      setFraction(0);
    });
    return uploadOnce(client, generateUploadUrl, file, options, (value) => setFraction(value)).then(
      (result) => {
        batch(() => {
          setActive((count) => count - 1);
          setFraction(undefined);
        });
        return result;
      },
      (error: unknown) => {
        batch(() => {
          setActive((count) => count - 1);
          setFraction(undefined);
          setFailure({ error });
        });
        throw error;
      },
    );
  };

  return Object.defineProperties(upload, {
    pending: { value: () => active() > 0, enumerable: true },
    progress: { value: fraction, enumerable: true },
    error: { value: () => failure()?.error, enumerable: true },
    reset: {
      value: (): void => {
        setFailure(undefined);
      },
      enumerable: true,
    },
  }) as UploadFileHandle;
}
