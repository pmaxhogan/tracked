// Estimate, from D1 alone, what ordering every managed playlist by set date
// costs (lib/playlist-order.ts, lib/playlist-reorder.ts). Reads only: four
// SELECTs through wrangler, one at a time; no YouTube call, nothing written.
//
//   node scripts/playlist-order-estimate.mjs [--daily-units 2000] [--moves-per-run 10] [--local]
//
// Needs Node 23.6+ (it imports the TypeScript module the Worker uses, so the
// numbers come from the same planner). The real dry run is the Worker's:
// GET /ui/api/playlist-order?fresh=1 reads every playlist's actual order
// (1 unit per 50 entries). This is for when the quota is spent or nothing is
// deployed: D1 does not store positions, so the current order is INFERRED:
//   - an entry tracked inserted itself goes where its insert time puts it
//     (YouTube appended every insert until now);
//   - an entry only ever seen in a listing (no insert time) is taken to be in
//     the order the sync adds a DJ's back catalogue, newest set first;
//   - the combined playlist: its recorded members, by the time the sync or
//     the backfill added each (unknown = artist by artist, as the backfill does).
// "worst" is every entry but one moving, which no order can exceed.

import { execFileSync } from 'node:child_process'
import { estimateDays, orderKeysByVideo, orderNeed, UNDATED, UNITS_PER_MOVE } from '../src/lib/playlist-order.ts'

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`)
  return i > 0 ? Number(process.argv[i + 1]) : fallback
}
const dailyUnits = arg('daily-units', 2000)
const movesPerRun = arg('moves-per-run', 10)
const where = process.argv.includes('--local') ? '--local' : '--remote'

function select(sql) {
  if (!/^\s*SELECT\b/i.test(sql)) throw new Error('read-only')
  const out = execFileSync('npx', ['wrangler', 'd1', 'execute', 'tracked', where, '--json', '--command', JSON.stringify(sql)], {
    encoding: 'utf8',
    shell: true,
    maxBuffer: 1 << 28,
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return JSON.parse(out.slice(out.indexOf('[')))[0].results
}

const tracklists = select('SELECT slug, url, video_id, position FROM tracklists WHERE video_id IS NOT NULL')
const subs = select('SELECT slug, playlist_id, artist_name FROM sub_sync WHERE playlist_id IS NOT NULL')
const confirmed = select("SELECT playlist_id, video_id, source, at FROM playlist_confirmed WHERE state = 'in'")
const members = select('SELECT playlist_id, video_id FROM playlist_members')
const additions = select(
  "SELECT ts, video_id, json_extract(record, '$.playlistId') AS playlist_id, json_extract(record, '$.combinedStatus') AS combined FROM playlist_additions WHERE status IN ('added', 'replaced')",
)

const keys = orderKeysByVideo(tracklists.map((t) => ({ url: t.url, videoId: t.video_id })))
const artistIds = new Set(subs.map((s) => s.playlist_id))
/** Discovery order of a video within a DJ (0 = newest set), for entries with no insert time. */
const discovery = new Map(tracklists.map((t) => [`${t.slug}|${t.video_id}`, t.position]))
const insertedAt = new Map()
const combinedAt = new Map()
for (const a of additions) {
  if (!a.video_id) continue
  const k = `${a.playlist_id}|${a.video_id}`
  if (a.playlist_id && (!insertedAt.has(k) || a.ts < insertedAt.get(k))) insertedAt.set(k, a.ts)
  if (a.combined === 'added' && (!combinedAt.has(a.video_id) || a.ts < combinedAt.get(a.video_id))) combinedAt.set(a.video_id, a.ts)
}

const playlists = []
const artistOrder = new Map()
for (const s of subs) {
  const rows = confirmed.filter((c) => c.playlist_id === s.playlist_id)
  const entries = rows.map((c) => {
    const at = insertedAt.get(`${s.playlist_id}|${c.video_id}`) ?? (c.source === 'listing' ? null : c.at * 1000)
    return { id: c.video_id, at, pos: discovery.get(`${s.slug}|${c.video_id}`) ?? Number.MAX_SAFE_INTEGER }
  })
  // Entries without an insert time were there first, newest set first; the rest follow in the order they were inserted.
  entries.sort((a, b) => (a.at === null ? (b.at === null ? a.pos - b.pos || (a.id < b.id ? -1 : 1) : -1) : b.at === null ? 1 : a.at - b.at))
  artistOrder.set(s.playlist_id, entries.map((e) => e.id))
  playlists.push({ name: s.artist_name ?? s.slug, kind: 'artist', ids: entries.map((e) => e.id) })
}
const combinedIds = [...new Set(members.filter((m) => !artistIds.has(m.playlist_id)).map((m) => m.playlist_id))]
for (const id of combinedIds) {
  const inIt = new Set(members.filter((m) => m.playlist_id === id).map((m) => m.video_id))
  // Backfilled entries (no time on record): artist by artist, each in its playlist's order.
  const backfilled = []
  for (const ids of artistOrder.values()) for (const v of ids) if (inIt.has(v) && !combinedAt.has(v) && !backfilled.includes(v)) backfilled.push(v)
  for (const v of inIt) if (!combinedAt.has(v) && !backfilled.includes(v)) backfilled.push(v)
  const live = [...inIt].filter((v) => combinedAt.has(v)).sort((a, b) => combinedAt.get(a) - combinedAt.get(b))
  playlists.push({ name: 'All tracked artists (combined)', kind: 'combined', ids: [...backfilled, ...live] })
}

const pad = (s, n) => String(s).padEnd(n)
const num = (s, n) => String(s).padStart(n)
console.log(`${pad('playlist', 34)}${num('items', 7)}${num('no date', 9)}${num('moves', 7)}${num('units', 9)}${num('worst', 8)}`)
const needs = []
let worstMoves = 0
for (const p of playlists.sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'artist' ? -1 : 1))) {
  const need = orderNeed(p.ids.map((id) => ({ id, key: keys.get(id) ?? UNDATED })))
  needs.push(need)
  const worst = Math.max(0, need.items - 1)
  worstMoves += worst
  console.log(`${pad(p.name.slice(0, 32), 34)}${num(need.items, 7)}${num(need.undated, 9)}${num(need.moves, 7)}${num(need.units, 9)}${num(worst, 8)}`)
}
const sum = (f) => needs.reduce((a, n) => a + f(n), 0)
const est = estimateDays(needs, dailyUnits, movesPerRun)
const worst = estimateDays(needs.map((n) => ({ ...n, moves: Math.max(0, n.items - 1) })), dailyUnits, movesPerRun)
console.log(`${pad(`total (${needs.length} playlists)`, 34)}${num(sum((n) => n.items), 7)}${num(sum((n) => n.undated), 9)}${num(sum((n) => n.moves), 7)}${num(sum((n) => n.units), 9)}${num(worstMoves, 8)}`)
console.log('')
console.log(`moves cost ${UNITS_PER_MOVE} units each; with the listings of a run of ${movesPerRun} moves at a time: ${est.units} units`)
console.log(`at ${dailyUnits} units a day: about ${est.days} days (worst case ${worst.units} units, ${worst.days} days)`)
