import { describe, it, expect } from "vitest";
import vm from "node:vm";
import { app } from "../src/index";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";
import { QUOTA_CONSUMERS } from "../src/lib/quota-consumers";
import { DEFAULT_APP_SETTINGS, getAppSettings } from "../src/lib/app-settings";
import { markProjectOut } from "../src/lib/youtube-pool";

const mkEnv = () =>
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
const URL_ = "https://tracked.example";
const json = (body: unknown, method = "PUT") => ({
  method,
  headers: { "content-type": "application/json", "sec-fetch-site": "same-origin" },
  body: JSON.stringify(body),
});

function stub(
  fetchImpl: (u: string, init?: { method?: string; body?: string }) => Promise<Response>,
) {
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
      ls,
      addEventListener(t: string, f: (ev: unknown) => unknown) {
        (ls[t] ??= []).push(f);
      },
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
    Intl,
    URLSearchParams,
    location: { search: "", pathname: "/ui/quota", hash: "" },
    history: { state: null, replaceState() {} },
  });
  return { ctx, els };
}
/** A click on the element carrying the given data attribute. */
const click = (attr: string, value: string) => {
  const b: any = {
    getAttribute: (k: string) => (k === attr ? value : null),
    disabled: false,
    textContent: "",
    dataset: {},
    setAttribute() {},
    removeAttribute() {},
  };
  return {
    target: { closest: (sel: string) => (sel.includes(`[${attr}]`) ? b : null) },
    preventDefault() {},
  };
};

const NOW = Math.floor(Date.now() / 1000);
function answer(over: Record<string, unknown> = {}) {
  const order = DEFAULT_APP_SETTINGS.quota.order;
  return {
    pool: [
      {
        key: "shared",
        label: "tracked-youtube",
        budget: 10000,
        spent: 9960,
        mkvidUnits: 0,
        remaining: 40,
        out: { since: NOW - 60, until: NOW + 3600 },
        hasToken: true,
      },
      {
        key: "primary",
        label: "mkvid-uploads",
        budget: 10000,
        spent: 0,
        mkvidUnits: 140,
        remaining: 9860,
        out: null,
        hasToken: true,
      },
    ],
    notConnected: [{ key: "upload2", label: "upload2", since: NOW - 7200 }],
    resetsAt: NOW + 15120,
    margin: 300,
    projectBudget: 10000,
    consumers: order.map((key, i) => {
      const c = QUOTA_CONSUMERS.find((x) => x.key === key)!;
      const status = ["running", "held", "max", "pool_out", "off"][i % 5]!;
      return {
        ...c,
        min: null,
        max: key === "combined" ? 4000 : null,
        enabled: status !== "off",
        was: key === "combined" ? "Combined playlist inserts a day: 80" : null,
        status,
        spentToday: i * 10,
        waiting: i === 0 ? 1200 : 0,
      };
    }),
    outside: {
      uploads: [{ account: "primary", label: "mkvid-uploads", used: 3, cap: 24, limit: 100 }],
      apiKeyReads: { count: null, note: "their project is unknown" },
    },
    tokenSource: { lastPushAt: NOW - 60 },
    ...over,
  };
}

describe("YouTube quota API", () => {
  it("GET /ui/api/quota lists the consumers in the owner's order with settings and status", async () => {
    const env = mkEnv();
    const r = await app.request(`${URL_}/ui/api/quota`, {}, env);
    expect(r.status).toBe(200);
    const d: any = await r.json();
    expect(d.consumers.map((c: any) => c.key)).toEqual(DEFAULT_APP_SETTINGS.quota.order);
    const combined = d.consumers.find((c: any) => c.key === "combined");
    expect(combined.max).toBe(4000);
    expect(combined.was).toContain("Combined playlist inserts a day: 80");
    expect(combined.label).toBe('Combined "all artists" playlist');
    expect(typeof d.resetsAt).toBe("number");
    expect(d.margin).toBe(300);
    expect(d.tokenSource.lastPushAt).toBeNull();
    expect(d.outside.apiKeyReads.note).toContain("project is unknown");
    expect(Array.isArray(d.outside.uploads)).toBe(true);
    expect(d.pool[0].key).toBe("shared");
  });

  it("PUT round-trips order, margin, budget and consumer limits", async () => {
    const env = mkEnv();
    const order = [...DEFAULT_APP_SETTINGS.quota.order];
    [order[0], order[1]] = [order[1]!, order[0]!];
    const consumers = { likes: { min: 100, max: 2000, enabled: false } };
    const r = await app.request(
      `${URL_}/ui/api/quota`,
      json({ order, margin: 500, projectBudget: 9000, consumers }),
      env,
    );
    expect(r.status).toBe(200);
    const saved = (await getAppSettings(env)).quota;
    expect(saved.order).toEqual(order);
    expect(saved.margin).toBe(500);
    expect(saved.projectBudget).toBe(9000);
    expect(saved.consumers.likes).toEqual(consumers.likes);
    const d: any = await (await app.request(`${URL_}/ui/api/quota`, {}, env)).json();
    expect(d.consumers[0].key).toBe(order[0]);
    expect(d.margin).toBe(500);
    const likes = d.consumers.find((c: any) => c.key === "likes");
    expect([likes.min, likes.max, likes.enabled]).toEqual([100, 2000, false]);
    expect(likes.status).toBe("off");
  });

  it("PUT refuses an order that is not a permutation, and saves nothing", async () => {
    const env = mkEnv();
    const r = await app.request(`${URL_}/ui/api/quota`, json({ order: ["likes"] }), env);
    expect(r.status).toBe(400);
    expect(((await r.json()) as any).issues.join(" ")).toContain("every quota consumer");
    expect((await getAppSettings(env)).quota.order).toEqual(DEFAULT_APP_SETTINGS.quota.order);
  });

  it("clear drops a project's out flag; an unknown project is 404", async () => {
    const env = mkEnv();
    await markProjectOut(env, "shared");
    const before: any = await (await app.request(`${URL_}/ui/api/quota`, {}, env)).json();
    expect(before.pool.find((p: any) => p.key === "shared").out).not.toBeNull();
    const r = await app.request(
      `${URL_}/ui/api/quota/projects/shared/clear`,
      {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(r.status).toBe(200);
    const after: any = await (await app.request(`${URL_}/ui/api/quota`, {}, env)).json();
    expect(after.pool.find((p: any) => p.key === "shared").out).toBeNull();
    const nf = await app.request(
      `${URL_}/ui/api/quota/projects/nope/clear`,
      {
        method: "POST",
        headers: { "sec-fetch-site": "same-origin", "content-type": "application/json" },
        body: "{}",
      },
      env,
    );
    expect(nf.status).toBe(404);
  });

  it("reports a project mkvid stopped pushing, and the last push", async () => {
    const env = mkEnv();
    await env.CACHE.put("yt:pool:accounts", JSON.stringify(["primary"]));
    await env.CACHE.put("yt:pool:seen", String(NOW - 5000));
    const d: any = await (await app.request(`${URL_}/ui/api/quota`, {}, env)).json();
    expect(d.notConnected.map((p: any) => p.key)).toEqual(["primary"]);
    expect(d.notConnected[0].label).toBe("mkvid-uploads");
    expect(d.tokenSource.lastPushAt).toBe(NOW - 5000);
  });
});

describe("YouTube quota page", () => {
  it("is served with its copy, and its inline script parses", async () => {
    const r = await app.request(`${URL_}/ui/quota`, {}, mkEnv());
    expect(r.status).toBe(200);
    const html = await r.text();
    expect(html).toContain(
      "Each item spends only what is left after the waiting work of everything above it.",
    );
    expect(html).toContain("Outside the pool");
    for (const s of scriptsOf(html)) expect(() => new vm.Script(s)).not.toThrow();
  });

  async function boot(a: any = answer()) {
    const calls: Array<{ u: string; method: string; body: any }> = [];
    const s = stub(async (u, init) => {
      const method = init?.method ?? "GET";
      if (method !== "GET") {
        calls.push({ u, method, body: init?.body ? JSON.parse(init.body) : null });
        return Response.json({ ...a, ok: true });
      }
      if (u.startsWith("/ui/api/quota")) return Response.json(a);
      return new Response("{}", { status: 404 });
    });
    const html = await (await app.request(`${URL_}/ui/quota`, {}, mkEnv())).text();
    for (const sc of scriptsOf(html)) vm.runInContext(sc, s.ctx);
    await settle();
    return { ...s, calls };
  }

  it("renders the rows in the owner's order, with the five statuses", async () => {
    const t = await boot();
    const list: string = t.els.get("q-list").innerHTML;
    const keys = [...list.matchAll(/data-row="([a-z_]+)"/g)].map((m) => m[1]);
    expect(keys).toEqual(DEFAULT_APP_SETTINGS.quota.order);
    for (const w of [
      "running",
      "held for higher priority",
      "at its daily limit",
      "waiting for the quota reset",
      "off",
    ])
      expect(list).toContain(w);
    expect(list).toContain("Keep at least");
    expect(list).toContain("At most");
    expect(list).toContain("was Combined playlist inserts a day: 80");
    expect(list).toContain("1,200 units");
  });

  it("uses info, warn and neutral for statuses, never bad", async () => {
    const t = await boot();
    const all = ["q-list", "q-pool", "q-outside"].map((i) => t.els.get(i).innerHTML).join("");
    expect(all).not.toMatch(/badge bad/);
    expect(all).not.toMatch(/class="[^"]*\bbad\b/);
    expect(t.els.get("q-pool").innerHTML).toContain("not connected since");
    expect(t.els.get("q-pool").innerHTML).toContain("out until");
  });

  it("a token source silent for more than 10 minutes shows warn; a recent one does not", async () => {
    const quiet = await boot(answer({ tokenSource: { lastPushAt: NOW - 11 * 60 } }));
    expect(quiet.els.get("q-pool").innerHTML).toMatch(/badge warn[^>]*>[^<]*token source silent/i);
    expect(quiet.els.get("q-pool").innerHTML).not.toMatch(/badge bad/);
    const fresh = await boot(answer({ tokenSource: { lastPushAt: NOW - 60 } }));
    expect(fresh.els.get("q-pool").innerHTML).not.toMatch(/token source silent/i);
  });

  it("down posts the new order; the first row's up does nothing", async () => {
    const t = await boot();
    const order = DEFAULT_APP_SETTINGS.quota.order;
    t.els.get("q-list").ls.click![0]!(click("data-up", order[0]!));
    await settle();
    expect(t.calls).toHaveLength(0);
    t.els.get("q-list").ls.click![0]!(click("data-down", order[0]!));
    await settle();
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.method).toBe("PUT");
    expect(t.calls[0]!.u).toBe("/ui/api/quota");
    expect(t.calls[0]!.body.order.slice(0, 2)).toEqual([order[1], order[0]]);
  });

  it("Clear posts to the project", async () => {
    const t = await boot();
    t.els.get("q-pool").ls.click![0]!(click("data-clear", "shared"));
    await settle();
    expect(t.calls.map((c) => `${c.method} ${c.u}`)).toEqual([
      "POST /ui/api/quota/projects/shared/clear",
    ]);
  });

  it("escapes what comes from the server", async () => {
    const a = answer();
    a.pool[0]!.label = "<img src=x onerror=alert(1)>";
    const t = await boot(a);
    expect(t.els.get("q-pool").innerHTML).not.toContain("<img");
    expect(t.els.get("q-pool").innerHTML).toContain("&lt;img");
  });
});
