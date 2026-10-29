import {
  type Accessor,
  batch,
  isServer,
  useContext,
  useMemo,
  useRenderEffect,
  useSignal,
} from "@shadow-js/core";
import { createComputation, readComputation } from "@shadow-js/core/extend";
import { ConvexProvider, missingProvider } from "./client";
import { ConvexAuthContext } from "./internal/contexts";
import type { AuthHookState, ConvexAuthState, ConvexClientLike } from "./types";

/**
 * Props of {@link ConvexProviderWithAuth}.
 *
 * @example
 * ```tsx
 * import {
 *   type AuthHookState,
 *   ConvexProviderWithAuth,
 *   type ConvexProviderWithAuthProps,
 *   createConvexClient,
 * } from "@shadow-js/convex";
 *
 * async function fetchAccessToken(): Promise<string | null> {
 *   const response = await fetch("/auth/convex-token");
 *   return response.ok ? response.text() : null;
 * }
 *
 * function useSessionAuth(): AuthHookState {
 *   return { isLoading: false, isAuthenticated: true, fetchAccessToken };
 * }
 *
 * const props: ConvexProviderWithAuthProps = {
 *   client: createConvexClient("https://happy-otter-123.convex.cloud"),
 *   useAuth: useSessionAuth,
 *   children: <main>Dashboard</main>,
 * };
 *
 * export const app = ConvexProviderWithAuth(props);
 * ```
 * @since 1.0.0
 */
export interface ConvexProviderWithAuthProps {
  /**
   * The client whose auth is driven by `useAuth`. It is also provided to the hooks below, as
   * {@link ConvexProvider} does.
   */
  readonly client: ConvexClientLike;
  /**
   * Hook returning the auth provider's state (Clerk, Auth0, your own). It runs inside a tracked
   * computation, so reading signals in it makes the provider react to them. A change of
   * `fetchAccessToken`, or of the signed-in state, re-registers the token with the client.
   */
  readonly useAuth: () => AuthHookState;
  /** The application. Read lazily inside the provider's scope. */
  readonly children?: unknown;
}

/** Where the auth provider is, as far as the registration logic cares. @internal */
type ProviderPhase = "loading" | "signed-in" | "signed-out";

/** Equal when the fields the provider reacts to are equal. @internal */
function sameAuthState(a: AuthHookState, b: AuthHookState): boolean {
  return (
    a.isLoading === b.isLoading &&
    a.isAuthenticated === b.isAuthenticated &&
    a.fetchAccessToken === b.fetchAccessToken
  );
}

/**
 * Removes the token from the client and tells the server. `ConvexClient` has no `clearAuth` of its
 * own, but the base client behind it (`client.client`) has the real one: it sends the sign-out to the
 * server, so subscribed queries run again without an identity. Registering a fetcher that returns
 * `null` instead only clears the local state and leaves the server's old identity in place until the
 * socket reconnects, so queries keep their signed-in results: it is the last resort.
 * @internal
 */
function clearAuth(client: ConvexClientLike): void {
  if (client.clearAuth !== undefined) client.clearAuth();
  else if (client.client?.clearAuth !== undefined) client.client.clearAuth();
  else client.setAuth(() => Promise.resolve(null));
}

/**
 * Delays, in milliseconds, before a token the server rejected is registered again. The last delay repeats. A
 * rejection can be transient (a token the server does not yet accept right after sign-in), so the first retries are short.
 * @internal
 */
const RETRY_DELAYS_MS: readonly number[] = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

/**
 * Connects an auth provider to Convex. While the provider reports a signed-in user, its token is
 * registered with the client; the server then confirms or rejects it. `useConvexAuth`,
 * `Authenticated`, `Unauthenticated` and `AuthLoading` read the combined state:
 *
 * - loading until the server has confirmed the token, or while the provider is loading;
 * - authenticated when the provider is signed in and the server accepted the token;
 * - unauthenticated otherwise.
 *
 * A token the server rejects while the provider still reports a session is registered again after
 * a delay of 1, 2, 4, 8, 16 and then every 30 seconds. When the provider signs out, or the
 * component is disposed, the token is removed from the client. It also provides the Convex client,
 * so it replaces {@link ConvexProvider}. With Clerk, `ConvexProviderWithClerk` from
 * `@shadow-js/clerk/convex` wraps this component.
 *
 * @param props See {@link ConvexProviderWithAuthProps}.
 * @returns The rendered children.
 * @example
 * ```tsx
 * import {
 *   type AuthHookState,
 *   Authenticated,
 *   AuthLoading,
 *   ConvexProviderWithAuth,
 *   createConvexClient,
 *   Unauthenticated,
 * } from "@shadow-js/convex";
 * import { render } from "@shadow-js/web";
 *
 * const client = createConvexClient("https://happy-otter-123.convex.cloud");
 *
 * // Asks the app's own server for a Convex JWT; `null` means signed out.
 * async function fetchAccessToken(): Promise<string | null> {
 *   const response = await fetch("/auth/convex-token");
 *   return response.ok ? response.text() : null;
 * }
 *
 * function useSessionAuth(): AuthHookState {
 *   return {
 *     isLoading: false,
 *     isAuthenticated: document.cookie.includes("signed_in=1"),
 *     fetchAccessToken,
 *   };
 * }
 *
 * render(
 *   () => (
 *     <ConvexProviderWithAuth client={client} useAuth={useSessionAuth}>
 *       <AuthLoading>
 *         <p>Checking session</p>
 *       </AuthLoading>
 *       <Authenticated>
 *         <p>Welcome back</p>
 *       </Authenticated>
 *       <Unauthenticated>
 *         <a href="/sign-in">Sign in</a>
 *       </Unauthenticated>
 *     </ConvexProviderWithAuth>
 *   ),
 *   document.body,
 * );
 * ```
 * @see {@link useConvexAuth}
 * @since 1.0.0
 */
export function ConvexProviderWithAuth(props: ConvexProviderWithAuthProps): unknown {
  const client = props.client;
  const provider = useMemo<AuthHookState>(() => props.useAuth(), { equals: sameAuthState });
  // null: waiting for the server; true/false: what the server reported for the registered token.
  const [serverAuth, setServerAuth] = useSignal<boolean | null>(null);

  // The provider's state is read inside this memo, which is tracked, so a getter-based state (one
  // that reads the provider's own signals when accessed) is followed. Reads inside the effect's
  // apply would not be. Provider loading means "not known yet"; signed out means the server must say no.
  const phase = useMemo<ProviderPhase>(() => {
    const state = provider();
    if (state.isLoading) return "loading";
    return state.isAuthenticated ? "signed-in" : "signed-out";
  });
  // "Loading" is not written into `serverAuth`: the server's answer for the registered token is still the last word
  // when the provider settles again with that same token (no new registration, so no new answer would come), and
  // forgetting it would leave the state loading for good. The combined state below folds the phase in instead.
  useRenderEffect(phase, (current) => {
    if (current === "signed-out") setServerAuth(false);
  });

  // The registration changes only when the provider's signed-in fetcher changes.
  const registration = useMemo<AuthHookState["fetchAccessToken"] | null>(() => {
    const state = provider();
    return state.isAuthenticated ? state.fetchAccessToken : null;
  });
  useRenderEffect(registration, (fetchAccessToken) => {
    if (fetchAccessToken === null) return undefined;
    let relevant = true;
    let rejections = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const register = (): void => {
      batch(() => setServerAuth(null));
      client.setAuth(fetchAccessToken, (authenticated) => {
        if (!relevant) return;
        if (authenticated) {
          rejections = 0;
          batch(() => setServerAuth(true));
          return;
        }
        batch(() => setServerAuth(false));
        // The client gives up on a token it has seen rejected and does not ask again. The provider still reports a
        // session, so the rejection is treated as transient: the token is registered again after a delay.
        const delay = RETRY_DELAYS_MS[Math.min(rejections, RETRY_DELAYS_MS.length - 1)] ?? 30_000;
        rejections += 1;
        retry = setTimeout(() => {
          retry = undefined;
          if (relevant) register();
        }, delay);
      });
    };

    register();
    return () => {
      relevant = false;
      if (retry !== undefined) clearTimeout(retry);
      clearAuth(client);
    };
  });

  const state: ConvexAuthState = {
    isLoading: () => phase() === "loading" || serverAuth() === null,
    isAuthenticated: () => phase() === "signed-in" && serverAuth() === true,
  };
  return ConvexProvider({
    client,
    get children() {
      return ConvexAuthContext({
        value: state,
        get children() {
          return props.children;
        },
      });
    },
  });
}

/**
 * Reads the auth state of the nearest {@link ConvexProviderWithAuth}. Both members are accessors.
 * During server rendering without a provider it returns a state that is loading and not
 * authenticated, so the page renders its loading branch and the browser decides afterward.
 *
 * @returns `{ isLoading, isAuthenticated }`, see {@link ConvexAuthState}.
 * @throws Error when there is no `ConvexProviderWithAuth` above the component in the browser. The
 * message starts with `useConvexAuth() must be used inside <ConvexProviderWithAuth>`.
 * @example
 * ```tsx
 * import { useConvexAuth } from "@shadow-js/convex";
 *
 * export function AccountLink() {
 *   const auth = useConvexAuth();
 *   return (
 *     <a href={auth.isAuthenticated() ? "/account" : "/sign-in"}>
 *       {() => (auth.isLoading() ? "Checking session" : "Account")}
 *     </a>
 *   );
 * }
 * ```
 * @since 1.0.0
 */
export function useConvexAuth(): ConvexAuthState {
  const state = useContext(ConvexAuthContext);
  if (state !== null) return state;
  if (!isServer) throw missingProvider("useConvexAuth", "ConvexProviderWithAuth");
  return SERVER_AUTH_STATE;
}

/**
 * What a page rendered on the server sees: there is no socket and no token, so the state is
 * loading and not signed in. A Dusk page that reads the auth state therefore renders its loading
 * branch and the browser decides afterward, as `ConvexProviderWithAuth` does.
 * @internal
 */
const SERVER_AUTH_STATE: ConvexAuthState = {
  isLoading: () => true,
  isAuthenticated: () => false,
};

/**
 * Renders its children while the user is authenticated: the auth provider reports a signed-in user
 * and the server has accepted the token. The children are built when the state turns
 * authenticated and disposed when it turns back.
 *
 * @param props `children` to show.
 * @returns An accessor of the children, or `null` when not authenticated.
 * @throws Error when there is no {@link ConvexProviderWithAuth} above the component in the
 * browser, as {@link useConvexAuth} does.
 * @example
 * ```tsx
 * import { Authenticated } from "@shadow-js/convex";
 *
 * export function Header() {
 *   return (
 *     <header>
 *       <Authenticated>
 *         <a href="/account">Account</a>
 *       </Authenticated>
 *     </header>
 *   );
 * }
 * ```
 * @see {@link Unauthenticated}
 * @see {@link AuthLoading}
 * @since 1.0.0
 */
export function Authenticated(props: { readonly children?: unknown }): Accessor<unknown> {
  const auth = useConvexAuth();
  return whileTrue(() => auth.isAuthenticated(), props);
}

/**
 * Renders its children while the user is signed out: the state is neither loading nor
 * authenticated. A token the server rejected counts as signed out.
 *
 * @param props `children` to show.
 * @returns An accessor of the children, or `null` while loading or authenticated.
 * @throws Error when there is no {@link ConvexProviderWithAuth} above the component in the
 * browser, as {@link useConvexAuth} does.
 * @example
 * ```tsx
 * import { Unauthenticated } from "@shadow-js/convex";
 *
 * export function SignInPrompt() {
 *   return (
 *     <Unauthenticated>
 *       <a href="/sign-in">Sign in to see your tasks</a>
 *     </Unauthenticated>
 *   );
 * }
 * ```
 * @see {@link Authenticated}
 * @see {@link AuthLoading}
 * @since 1.0.0
 */
export function Unauthenticated(props: { readonly children?: unknown }): Accessor<unknown> {
  const auth = useConvexAuth();
  return whileTrue(() => !auth.isLoading() && !auth.isAuthenticated(), props);
}

/**
 * Renders its children while the auth state is still being determined: the auth provider is
 * loading, or the server has not yet confirmed or rejected the token. During server rendering
 * without a provider the state is always loading, so these children are what the server renders.
 *
 * @param props `children` to show.
 * @returns An accessor of the children, or `null` once the state is known.
 * @throws Error when there is no {@link ConvexProviderWithAuth} above the component in the
 * browser, as {@link useConvexAuth} does.
 * @example
 * ```tsx
 * import { AuthLoading } from "@shadow-js/convex";
 *
 * export function SessionSpinner() {
 *   return (
 *     <AuthLoading>
 *       <p role="status">Checking session</p>
 *     </AuthLoading>
 *   );
 * }
 * ```
 * @see {@link Authenticated}
 * @see {@link Unauthenticated}
 * @since 1.0.0
 */
export function AuthLoading(props: { readonly children?: unknown }): Accessor<unknown> {
  const auth = useConvexAuth();
  return whileTrue(() => auth.isLoading(), props);
}

/**
 * Builds the children while `condition()` holds, in a memo created here: the children are made in
 * this component's scope, so they see the providers above it (a bare accessor would be called by
 * whoever renders it, outside that scope), and they are disposed when the condition turns false.
 * @internal
 */
function whileTrue(
  condition: () => boolean,
  props: { readonly children?: unknown },
): Accessor<unknown> {
  const node = createComputation({
    kind: "memo",
    allowWrites: true,
    fn: () => (condition() ? props.children : null),
  });
  return () => readComputation<unknown>(node);
}
