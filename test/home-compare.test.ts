/**
 * Home's "Compare playlists" button: a run the YouTube quota rule held is a
 * wait (warn, in the rule's own words), never a red failure with a raw key.
 */
import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { app } from "../src/index";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";

const env = () =>
  ({
    CACHE: fakeKV(),
    SUBS: fakeKV(),
    DB: fakeD1(),
    API_TOKEN: "t",
    YOUTUBE_API_KEY: "k",
    DEV_BYPASS_CF_ACCESS: "1",
  }) as unknown as Env;
const scriptsOf = (html: string) =>
  [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
};

/** A DOM stub whose elements keep their listeners and children (the toasts are built from elements). */
function stub(fetchImpl: (u: string) => Promise<Response>) {
  const el = (): any => {
    const ls: Record<string, Array<(ev: unknown) => unknown>> = {};
    return {
      innerHTML: "",
      textContent: "",
      value: "",
      hidden: false,
      disabled: false,
      className: "",
      dataset: {},
      style: {},
      children: [] as any[],
      ls,
      addEventListener(t: string, f: (ev: unknown) => unknown) {
        (ls[t] ??= []).push(f);
      },
      appendChild(c: any) {
        this.children.push(c);
        c.parentNode = this;
        return c;
      },
      removeChild() {},
      focus() {},
      setAttribute() {},
      removeAttribute() {},
      getAttribute: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      closest: () => null,
    };
  };
  const els = new Map<string, any>();
  const document = {
    hidden: false,
    getElementById: (id: string) => (els.has(id) ? els.get(id) : (els.set(id, el()), els.get(id))),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    createElement: () => el(),
  };
  const ctx = vm.createContext({
    document,
    fetch: fetchImpl,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval() {},
    console,
    Date,
    URL,
    URLSearchParams,
    location: { search: "", pathname: "/ui", hash: "" },
    history: { replaceState() {} },
  });
  return { ctx, els };
}

async function compare(answer: unknown): Promise<{ kind: string; text: string }[]> {
  const { ctx, els } = stub(async (u: string) =>
    u.startsWith("/ui/api/hygiene/run")
      ? Response.json(answer)
      : new Response("{}", { status: 404 }),
  );
  const html = await (await app.request("https://tracked.example/ui", {}, env())).text();
  for (const s of scriptsOf(html)) vm.runInContext(s, ctx);
  await settle();
  const box = (ctx as any).document.getElementById("tk-toasts");
  const before = box.children.length;
  const clicks = els.get("h-compare")?.ls.click ?? [];
  expect(clicks.length).toBeGreaterThan(0);
  for (const f of clicks) await f({});
  await settle();
  return box.children
    .slice(before)
    .map((t: any) => ({ kind: t.className, text: t.children[0].textContent }));
}

describe("Home compare toast", () => {
  it("shows a quota hold as a warn in the rule's words", async () => {
    const toasts = await compare({
      skipped: "quota_pool_out",
      message: "waiting for the quota reset (midnight Pacific)",
    });
    expect(toasts).toEqual([
      {
        kind: "toast warn",
        text: "hygiene compare waits: waiting for the quota reset (midnight Pacific)",
      },
    ]);
  });

  it("keeps any other skip red", async () => {
    const toasts = await compare({ skipped: "youtube_not_connected" });
    expect(toasts).toHaveLength(1);
    expect(toasts[0]!.kind).toBe("toast bad");
  });
});
