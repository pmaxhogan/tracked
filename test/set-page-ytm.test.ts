// The set page's YouTube Music button: the script that builds it parses, and
// the video id regex survives the template literal (a slipped escape would
// leave a bare `/` that ends the regex early). The button sits in its own slot
// between the form and the diagnostics, so a phone shows it first.
import { describe, it, expect } from "vitest";
import { fakeKV } from "./helpers/fake-kv";
import { fakeD1 } from "./helpers/fake-d1";
import type { Env } from "../src/types";
import { app } from "../src/index";

const makeEnv = () =>
  ({
    CACHE: fakeKV(),
    DB: fakeD1(),
    SUBS: fakeKV(),
    API_TOKEN: "t",
    DEV_BYPASS_CF_ACCESS: "1",
  }) as unknown as Env;

const loadPage = async () => (await app.request("http://x/ui/set", {}, makeEnv())).text();
const scriptsOf = (page: string) =>
  [...page.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]!);

type FakeEl = { attrs: Record<string, string>; setAttribute(k: string, v: string): void } & Record<
  string,
  unknown
>;

// The button helpers from the page script, run against a fake slot and document.
function ytmHelpers(src: string) {
  // Setting textContent empties the slot, as on a real element.
  const slot = {
    hidden: true,
    children: [] as FakeEl[],
    appendChild(el: FakeEl) {
      slot.children.push(el);
    },
    set textContent(_: string) {
      slot.children = [];
    },
  };
  const document = {
    createElement: (): FakeEl => {
      const el = { attrs: {} } as FakeEl;
      el.setAttribute = (k, v) => {
        el.attrs[k] = v;
      };
      return el;
    },
  };
  const body = src.slice(src.indexOf("let ytFromDiag"), src.indexOf("// The track table"));
  const api = new Function(
    "$",
    "document",
    body +
      "; return { videoIdOf, diagVideoId, renderYtm, set: (d, p) => { ytFromDiag = d; ytFromPage = p; } };",
  )(() => slot, document) as {
    videoIdOf(u: unknown): string | null;
    diagVideoId(d: unknown): string | null;
    renderYtm(): void;
    set(d: string | null, p: string | null): void;
  };
  return { api, slot };
}

describe("/ui/set YouTube Music button", () => {
  it("ships a parsing script whose video id regex reads watch and short links", async () => {
    const page = await loadPage();
    expect(page).toContain("Open in YouTube Music ↗");
    expect(page).toContain("'btn primary ytm'");
    const scripts = scriptsOf(page);
    for (const js of scripts) expect(() => new Function(js)).not.toThrow();
    const { api } = ytmHelpers(scripts.find((s) => s.includes("function videoIdOf"))!);
    expect(api.videoIdOf("https://www.youtube.com/watch?v=7-HvbsxBq-4&t=3")).toBe("7-HvbsxBq-4");
    expect(api.videoIdOf("https://youtu.be/9Z8W5-47Ym0")).toBe("9Z8W5-47Ym0");
    expect(api.videoIdOf("https://www.youtube.com/embed/9Z8W5-47Ym0")).toBe("9Z8W5-47Ym0");
    expect(api.videoIdOf(null)).toBeNull();
  });

  it("puts the button slot above the diagnostics and the track list", async () => {
    const page = await loadPage();
    const slot = page.indexOf('id="ytm-slot"');
    expect(slot).toBeGreaterThan(page.indexOf('id="load-form"'));
    expect(slot).toBeLessThan(page.indexOf('id="diag"'));
    expect(slot).toBeLessThan(page.indexOf('id="setmeta"'));
  });

  it("shows a new-tab music.youtube.com link only when a video is known, the diagnostics' first", async () => {
    const page = await loadPage();
    const { api, slot } = ytmHelpers(
      scriptsOf(page).find((s) => s.includes("function renderYtm"))!,
    );

    api.renderYtm();
    expect(slot.hidden).toBe(true);
    expect(slot.children).toHaveLength(0);

    // Only the set page's own link (the diagnostics have not answered or found none).
    api.set(null, "PAGEVIDEO01");
    api.renderYtm();
    expect(slot.hidden).toBe(false);
    expect(slot.children).toHaveLength(1);
    expect(slot.children[0]!.href).toBe("https://music.youtube.com/watch?v=PAGEVIDEO01");

    // The diagnostics' video (an mkvid upload's, from the synced row) wins; a redraw replaces the button.
    api.set(
      api.diagVideoId({ video: { id: "c_x9pmJnGeE", from: "tracklists", source: "mkvid" } }),
      "PAGEVIDEO01",
    );
    api.renderYtm();
    expect(slot.children).toHaveLength(1);
    const a = slot.children[0]!;
    expect(a.href).toBe("https://music.youtube.com/watch?v=c_x9pmJnGeE");
    expect(a.target).toBe("_blank");
    expect(String(a.rel)).toContain("noopener");
    expect(a.className).toBe("btn primary ytm");

    // A new load clears it.
    api.set(null, null);
    api.renderYtm();
    expect(slot.hidden).toBe(true);
    expect(slot.children).toHaveLength(0);

    expect(api.diagVideoId({ video: null })).toBeNull();
    expect(api.diagVideoId(null)).toBeNull();
  });
});
