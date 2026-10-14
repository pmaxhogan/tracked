// Estimate, from D1 alone, what ordering the artist playlists by set date
// costs (lib/playlist-order.ts, lib/playlist-reorder.ts). The combined
// playlist is not ordered and not counted. Reads only: four SELECTs through
// wrangler, one at a time; no YouTube call, nothing written.
//
//   node scripts/playlist-order-estimate.mjs [--daily-units 2000] [--moves-per-run 10] [--local] [--show <slug>]
//
// Needs Node 23.6+ (it imports the TypeScript module the Worker uses, so the
// numbers come from the same planner). The real dry run is the Worker's:
// GET /ui/api/playlist-order?fresh=1 reads every playlist's actual order
// (1 unit per 50 entries). This is for when the quota is spent or nothing is
// deployed: D1 does not store positions, so the current order is INFERRED:
//   - an entry with a known insert time (the audit trail, or a confirmed
//     insert) goes where that time puts it: YouTube appended every insert;
//   - an entry only ever seen in a listing has no time ("untimed"): those were
//     there before the others, and are taken to be in the order the sync adds
//     a DJ's back catalogue, newest set first.
// Columns: "timed" = entries whose place rests on a real insert time;
// "rho" = Spearman rank correlation between an entry's inferred place and its
// set date (+1 = already oldest first, -1 = exactly newest first);
// "min" = the moves the timed entries alone need whatever order the untimed
// ones are in (a floor); "worst" = every entry but one moves (a ceiling).
// --show <slug> prints one playlist's inferred order with dates.

import { execFileSync } from "node:child_process";
import {
  compareOrder,
  estimateDays,
  orderKeysByVideo,
  orderNeed,
  UNDATED,
  UNITS_PER_MOVE,
} from "../src/lib/playlist-order.ts";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const dailyUnits = Number(arg("daily-units", 2000));
const movesPerRun = Number(arg("moves-per-run", 10));
const show = arg("show", null);
const where = process.argv.includes("--local") ? "--local" : "--remote";

function select(sql) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error("read-only");
  const out = execFileSync(
    "npx",
    ["wrangler", "d1", "execute", "tracked", where, "--json", "--command", JSON.stringify(sql)],
    {
      encoding: "utf8",
      shell: true,
      maxBuffer: 1 << 28,
      stdio: ["ignore", "pipe", "inherit"],
    },
  );
  return JSON.parse(out.slice(out.indexOf("[")))[0].results;
}

const tracklists = select(
  "SELECT slug, url, video_id, position FROM tracklists WHERE video_id IS NOT NULL",
);
const subs = select(
  "SELECT slug, playlist_id, artist_name FROM sub_sync WHERE playlist_id IS NOT NULL",
);
const confirmed = select(
  "SELECT playlist_id, video_id, source, at FROM playlist_confirmed WHERE state = 'in'",
);
const additions = select(
  "SELECT ts, video_id, json_extract(record, '$.playlistId') AS playlist_id FROM playlist_additions WHERE status IN ('added', 'replaced')",
);

const keys = orderKeysByVideo(tracklists.map((t) => ({ url: t.url, videoId: t.video_id })));
/** Discovery order of a video within a DJ (0 = newest set), for entries with no insert time. */
const discovery = new Map(tracklists.map((t) => [`${t.slug}|${t.video_id}`, t.position]));
const insertedAt = new Map();
for (const a of additions) {
  if (!a.video_id || !a.playlist_id) continue;
  const k = `${a.playlist_id}|${a.video_id}`;
  if (!insertedAt.has(k) || a.ts < insertedAt.get(k)) insertedAt.set(k, a.ts);
}

/** Spearman's rho between place in the playlist and place by set date (dated entries only, ties by average rank). */
function rho(entries) {
  const dated = entries.filter((e) => e.key.date !== null);
  const n = dated.length;
  if (n < 3) return null;
  const byDate = [...dated].sort((a, b) => compareOrder(a.key, b.key));
  const rank = new Map();
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && compareOrder(byDate[j + 1].key, byDate[i].key) === 0) j++;
    for (let k = i; k <= j; k++) rank.set(byDate[k].id, (i + j) / 2);
    i = j + 1;
  }
  const mean = (n - 1) / 2;
  let num = 0,
    dx = 0,
    dy = 0;
  dated.forEach((e, i) => {
    const y = rank.get(e.id) - mean;
    num += (i - mean) * y;
    dx += (i - mean) ** 2;
    dy += y * y;
  });
  return dx && dy ? num / Math.sqrt(dx * dy) : null;
}

const playlists = subs.map((s) => {
  const entries = confirmed
    .filter((c) => c.playlist_id === s.playlist_id)
    .map((c) => ({
      id: c.video_id,
      key: keys.get(c.video_id) ?? UNDATED,
      at:
        insertedAt.get(`${s.playlist_id}|${c.video_id}`) ??
        (c.source === "listing" ? null : c.at * 1000),
      pos: discovery.get(`${s.slug}|${c.video_id}`) ?? Number.MAX_SAFE_INTEGER,
    }));
  // Untimed entries were there first, newest set first; the rest follow in the order they were inserted.
  entries.sort((a, b) =>
    a.at === null
      ? b.at === null
        ? a.pos - b.pos || (a.id < b.id ? -1 : 1)
        : -1
      : b.at === null
        ? 1
        : a.at - b.at,
  );
  return { slug: s.slug, name: s.artist_name ?? s.slug, entries };
});
playlists.sort((a, b) => a.name.localeCompare(b.name));

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);
console.log(
  `${pad("playlist", 24)}${num("items", 7)}${num("no date", 9)}${num("timed", 7)}${num("rho", 7)}${num("moves", 7)}${num("units", 8)}${num("min", 6)}${num("worst", 7)}`,
);
const needs = [];
const floors = [];
for (const p of playlists) {
  const need = orderNeed(p.entries);
  const timed = p.entries.filter((e) => e.at !== null);
  const floor = orderNeed(timed).moves;
  const r = rho(p.entries);
  needs.push(need);
  floors.push({ ...need, moves: floor });
  console.log(
    `${pad(p.name.slice(0, 22), 24)}${num(need.items, 7)}${num(need.undated, 9)}${num(timed.length, 7)}${num(r === null ? "" : r.toFixed(2), 7)}${num(need.moves, 7)}${num(need.units, 8)}${num(floor, 6)}${num(Math.max(0, need.items - 1), 7)}`,
  );
}
const sum = (xs, f) => xs.reduce((a, n) => a + f(n), 0);
const worst = needs.map((n) => ({ ...n, moves: Math.max(0, n.items - 1) }));
console.log(
  `${pad(`total (${needs.length} playlists)`, 24)}${num(
    sum(needs, (n) => n.items),
    7,
  )}${num(
    sum(needs, (n) => n.undated),
    9,
  )}${num(
    sum(playlists, (p) => p.entries.filter((e) => e.at !== null).length),
    7,
  )}${num("", 7)}${num(
    sum(needs, (n) => n.moves),
    7,
  )}${num(
    sum(needs, (n) => n.units),
    8,
  )}${num(
    sum(floors, (n) => n.moves),
    6,
  )}${num(
    sum(worst, (n) => n.moves),
    7,
  )}`,
);
console.log("");
const line = (label, xs) => {
  const at = (u) => estimateDays(xs, u, movesPerRun);
  const e = at(dailyUnits);
  const others = [2000, 4000]
    .filter((u) => u !== dailyUnits)
    .map((u) => `${at(u).days} days at ${u}`);
  console.log(
    `${pad(label, 10)}${sum(xs, (n) => n.moves)} moves x ${UNITS_PER_MOVE} + the listings and read-backs of runs of ${movesPerRun} = ${e.units} units: ${e.days} days at ${dailyUnits} a day${others.length ? `, ${others.join(", ")}` : ""}`,
  );
};
line("estimate", needs);
line("floor", floors);
line("ceiling", worst);

if (show) {
  const p = playlists.find((x) => x.slug === show);
  if (!p) throw new Error(`no playlist for slug ${show}`);
  console.log(`\n${p.name}: inferred current order (place, set date, how the place is known)`);
  p.entries.forEach((e, i) =>
    console.log(
      `${num(i, 4)}  ${e.key.date ?? "(no date)"}  ${e.at === null ? "untimed" : new Date(e.at).toISOString().slice(0, 10)}  ${e.id}`,
    ),
  );
}
