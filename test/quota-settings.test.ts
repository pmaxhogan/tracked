/**
 * The quota settings group: defaults, and the one-time carry-over of the old
 * per-feature caps into quota.consumers when a stored document has none yet.
 */
import { describe, it, expect } from "vitest";
import {
  DEFAULT_APP_SETTINGS,
  DEFAULT_SWEEP_REMOVALS,
  getAppSettings,
  updateAppSettings,
  migrateQuotaConsumers,
  type AppSettings,
} from "../src/lib/app-settings";
import { DEFAULT_SWEEP_DAILY_REMOVALS } from "../src/lib/playlist-hygiene";
import { QUOTA_CONSUMERS } from "../src/lib/quota-consumers";
import { fakeKV } from "./helpers/fake-kv";

const KEYS = [
  "likes",
  "presave_playlists",
  "dj_playlists",
  "hygiene",
  "mkvid_uploads",
  "mkvid_recreate",
  "combined",
  "renames",
  "ordering",
];

/** Defaults with some old caps changed. */
function withOld(
  playlists: Partial<AppSettings["playlists"]>,
  presave: Partial<AppSettings["presave"]> = {},
): AppSettings {
  return {
    ...DEFAULT_APP_SETTINGS,
    playlists: { ...DEFAULT_APP_SETTINGS.playlists, ...playlists },
    presave: { ...DEFAULT_APP_SETTINGS.presave, ...presave },
  };
}

describe("quota defaults", () => {
  it("has the owner's order, a 300 margin and a 10000 project budget", () => {
    expect(DEFAULT_APP_SETTINGS.quota.order).toEqual(KEYS);
    expect(DEFAULT_APP_SETTINGS.quota.margin).toBe(300);
    expect(DEFAULT_APP_SETTINGS.quota.projectBudget).toBe(10000);
    expect(DEFAULT_APP_SETTINGS.quota.consumers).toEqual({});
  });

  it("catalogues every ranked consumer once, in the default order", () => {
    expect(QUOTA_CONSUMERS.map((c) => c.key)).toEqual(KEYS);
    for (const c of QUOTA_CONSUMERS) {
      expect(c.label).not.toBe("");
      expect(c.description).not.toBe("");
      expect(c.perAction).not.toBe("");
    }
  });
});

describe("migrateQuotaConsumers", () => {
  it("ordering: orderDailyUnits 8000 becomes max 8000, enabled", () => {
    const c = migrateQuotaConsumers(withOld({ orderDailyUnits: 8000 }), {}).quota.consumers;
    expect(c.ordering).toEqual({ min: null, max: 8000, enabled: true });
  });

  it("ordering: 0 (paused) becomes disabled", () => {
    const c = migrateQuotaConsumers(withOld({ orderDailyUnits: 0 }), {}).quota.consumers;
    expect(c.ordering?.enabled).toBe(false);
  });

  it("combined: 80 inserts a day becomes 4000 units", () => {
    const c = migrateQuotaConsumers(withOld({ combinedDailyInsertCap: 80 }), {}).quota.consumers;
    expect(c.combined).toEqual({ min: null, max: 4000, enabled: true });
  });

  it("hygiene: a saved sweepDailyRemovals wins over the env var", () => {
    const c = migrateQuotaConsumers(withOld({ sweepDailyRemovals: 10 }), {
      PLAYLIST_SWEEP_DAILY_REMOVALS: "25",
    }).quota.consumers;
    expect(c.hygiene?.max).toBe(510);
  });

  it("hygiene: sweepDailyRemovals null with env 25 becomes 1275", () => {
    const c = migrateQuotaConsumers(withOld({ sweepDailyRemovals: null }), {
      PLAYLIST_SWEEP_DAILY_REMOVALS: "25",
    }).quota.consumers;
    expect(c.hygiene).toEqual({ min: null, max: 1275, enabled: true });
  });

  it("hygiene: neither setting nor env falls back to 40, so 2040", () => {
    const c = migrateQuotaConsumers(withOld({}), {}).quota.consumers;
    expect(c.hygiene?.max).toBe(2040);
  });

  it("likes: likeDailyUnitCap carries over", () => {
    const c = migrateQuotaConsumers(withOld({}, { likeDailyUnitCap: 500 }), {}).quota.consumers;
    expect(c.likes).toEqual({ min: null, max: 500, enabled: true });
  });

  it("keeps an entry that is already there and leaves other consumers alone", () => {
    const base = withOld({ orderDailyUnits: 8000 });
    const s: AppSettings = {
      ...base,
      quota: {
        ...base.quota,
        consumers: { ordering: { min: 100, max: 1000, enabled: true } },
      },
    };
    const c = migrateQuotaConsumers(s, {}).quota.consumers;
    expect(c.ordering).toEqual({ min: 100, max: 1000, enabled: true });
    expect(c.combined?.max).toBe(4000);
    expect(c.renames).toBeUndefined();
  });
});

describe("getAppSettings", () => {
  it("fills quota.consumers from the live old caps without writing", async () => {
    const SUBS = fakeKV();
    await SUBS.put(
      "app:settings",
      JSON.stringify({ playlists: { orderDailyUnits: 8000, combinedDailyInsertCap: 80 } }),
    );
    const s = await getAppSettings({ SUBS, PLAYLIST_SWEEP_DAILY_REMOVALS: "25" });
    expect(s.quota.consumers.ordering?.max).toBe(8000);
    expect(s.quota.consumers.combined?.max).toBe(4000);
    expect(s.quota.consumers.hygiene?.max).toBe(1275);
    expect(JSON.parse((await SUBS.get("app:settings")) as string).quota).toBeUndefined();
  });
});

describe("quota validation", () => {
  const bad: Array<[string, unknown, string]> = [
    ["a dropped key", { quota: { order: KEYS.slice(1) } }, "quota.order"],
    ["a duplicate", { quota: { order: [...KEYS.slice(1), KEYS[1]] } }, "quota.order"],
    ["an unknown order key", { quota: { order: [...KEYS.slice(1), "nope"] } }, "quota.order"],
    [
      "an unknown consumer",
      { quota: { consumers: { nope: { min: null, max: null, enabled: true } } } },
      "quota.consumers",
    ],
  ];
  for (const [name, patch, path] of bad)
    it(`rejects ${name}`, async () => {
      const r = await updateAppSettings({ SUBS: fakeKV() }, patch);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.issues.join(" ")).toContain(path);
    });

  it("accepts a reordered permutation", async () => {
    const r = await updateAppSettings(
      { SUBS: fakeKV() },
      { quota: { order: [...KEYS].reverse() } },
    );
    expect(r.ok).toBe(true);
  });

  it("the first save resolves hygiene from the env var", async () => {
    const r = await updateAppSettings(
      { SUBS: fakeKV(), PLAYLIST_SWEEP_DAILY_REMOVALS: "25" },
      { quota: { margin: 400 } },
    );
    expect(r.ok && r.settings.quota.consumers.hygiene?.max).toBe(1275);
  });

  it("the sweep default matches playlist-hygiene's", () => {
    expect(DEFAULT_SWEEP_REMOVALS).toBe(DEFAULT_SWEEP_DAILY_REMOVALS);
  });
});

describe("a stored quota group that is no longer whole", () => {
  it("is normalised on read: known keys kept in order once, missing ones appended, unknown ones dropped; the rest of the document kept", async () => {
    const SUBS = fakeKV({
      "app:settings": JSON.stringify({
        graph: { nodeCap: 4000 },
        quota: {
          order: ["ordering", "gone_consumer", "likes", "ordering", "combined"],
          margin: 450,
          consumers: {
            gone_consumer: { min: null, max: 10, enabled: true },
            ordering: { min: null, max: 500, enabled: true },
          },
        },
      }),
    });
    const s = await getAppSettings({ SUBS });
    expect(s.quota.order).toEqual([
      "ordering",
      "likes",
      "combined",
      "presave_playlists",
      "dj_playlists",
      "hygiene",
      "mkvid_uploads",
      "mkvid_recreate",
      "renames",
    ]);
    expect(s.quota.margin).toBe(450);
    expect(s.quota.consumers.ordering).toEqual({ min: null, max: 500, enabled: true });
    expect(s.quota.consumers).not.toHaveProperty("gone_consumer");
    expect(s.graph.nodeCap).toBe(4000);
  });

  it("a PATCH with an unknown key is still refused", async () => {
    const r = await updateAppSettings(
      { SUBS: fakeKV() },
      { quota: { order: [...KEYS.slice(1), "gone_consumer"] } },
    );
    expect(r.ok).toBe(false);
  });
});
