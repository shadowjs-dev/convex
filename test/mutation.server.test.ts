import { renderToString } from "@shadow-js/web/server";
import { describe, expect, it } from "vitest";
import { useAction, useMutation } from "../src/mutation";
import { api } from "./support/refs";

describe("useMutation and useAction on the server", () => {
  it("[SSR-M1] a page that calls them renders without a ConvexProvider (mutations never run during render)", () => {
    let add: ReturnType<typeof useMutation<typeof api.tasks.add>> | undefined;
    let send: ReturnType<typeof useAction<typeof api.emails.send>> | undefined;
    const html = renderToString(() => {
      add = useMutation(api.tasks.add);
      send = useAction(api.emails.send);
      return "rendered";
    });
    expect(html).toBe("rendered");
    expect(add?.pending()).toBe(false);
    expect(add?.error()).toBeUndefined();
    expect(send?.pending()).toBe(false);
  });

  it("[SSR-M2] a call on the server rejects with an error that names the browser, instead of throwing", async () => {
    let add: ReturnType<typeof useMutation<typeof api.tasks.add>> | undefined;
    renderToString(() => {
      add = useMutation(api.tasks.add);
      return "rendered";
    });
    const call = add;
    if (call === undefined) throw new Error("the component did not render");
    const outcome = await call({ title: "x" }).then(
      () => "resolved",
      (error: unknown) => (error instanceof Error ? error.message : "other"),
    );
    expect(outcome).toMatch(/ConvexProvider/);
    expect(outcome).toMatch(/browser/);
    expect(call.error()).toBeInstanceOf(Error);
  });
});
