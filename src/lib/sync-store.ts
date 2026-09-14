/**
 * D1 persistence for the sync's per-subscription state.
 *
 * The sync (lib/sync.ts) still thinks in terms of one `SubState` object per
 * DJ — sets of URLs, a failure map, a per-URL video record — because that is
 * the shape its orchestration logic is written and tested against. This
 * module is the boundary: it hydrates that object from the `sub_sync` +
 * `tracklists` tables and writes it back as row upserts.
 *
 * Writes are diff-based when the caller hands over the state it loaded
 * (`saveSubState(env, slug, next, { since: loaded })`): only rows whose
 * fields actually changed are upserted, so a 5-minute tick that touched 20
 * sets writes ~20 rows, not the DJ's whole 500-row history. Without `since`
 * every row is upserted (what a one-off import or a test does).
 *
 * **Legacy import.** State written before D1 existed lives as one JSON blob
 * at `subs:state:<slug>` in the SUBS KV namespace. The first `loadSubState`
 * for a slug with no D1 rows imports that blob. This must never quietly
 * degrade to "empty state": an empty state makes the sync treat every set as
 * new and re-fetch the DJ's entire back catalogue — hundreds of 1001tracklists
 * page fetches, which is exactly what gets the account banned. So a KV read
 * or D1 write failure during import throws, and the sync run for that DJ
 * fails loudly instead.
 */

import type { Env } from '../types'
import { batchChunked, dbOf, parseJson, v } from './db'
import type { Logger } from './log'

export type SubState = {
  playlistId?: string
  artistName?: string
  /**
   * Union over time of every tracklist URL we've ever seen on this DJ's
   * paginated index. The DJ index uses JS infinite-scroll, so a single
   * fetch only sees ~15 newest sets; we walk pageN.html on first sync to
   * build this and merge in newly-appearing URLs on every subsequent run.
   */
  discoveredTracklistUrls?: string[]
  processedTracklistUrls: string[]
  /**
   * Per-URL failure counter. When a set scrape errors (CF shell, IP block,
   * transport), we bump the count here. Once it crosses
   * `ABANDON_AFTER_FAILURES`, we move it to processedTracklistUrls so the
   * cron stops retrying — otherwise every cron tick re-attempts the same
   * failing URLs forever, which is what kept re-triggering the home-proxy
   * IP block. Cleared on success.
   */
  failureCounts?: Record<string, number>
  /** URLs we've given up retrying (after ABANDON_AFTER_FAILURES failures). */
  abandonedTracklistUrls?: string[]
  /**
   * What each processed tracklist resolved to, and when we last looked. This
   * is what a recheck compares against (see lib/sync.ts). Absent on state
   * written before rechecks existed; `syncOne` seeds it from the audit trail
   * on the first run after that, and any URL still without an entry is
   * rechecked as "baseline unknown".
   */
  tracklistVideos?: Record<string, TracklistVideo>
  lastRunAt?: number
  lastError?: string
  lastRunStats?: {
    tracklistsSeen: number
    tracklistsProcessed: number
    videoIdsFound: number
    videoIdsAdded: number
    tracklistsRechecked?: number
    videosReplaced?: number
    via: 'home-proxy' | 'home-proxy-pool' | 'unlocker' | 'direct' | 'mixed'
  }
}

export type VideoSource = '1001tl' | 'mkvid'

export type TracklistVideo = {
  /**
   * The YouTube video the set page carried at `checkedAt`; null when it had
   * none. *Absent* means the baseline is unknown — the set was processed
   * before rechecks existed and no audit row survived — so the next recheck
   * records rather than compares.
   */
  videoId?: string | null
  /** Unix seconds of the last fetch of the set page. 0 = due now (invalidated). */
  checkedAt: number
  /**
   * Where the video came from: embedded on the 1001tracklists set page
   * (`1001tl`, the default) or rendered from the set's SoundCloud / hearthis
   * recording and uploaded by mkvid (`mkvid`). Only meaningful with a videoId.
   */
  source?: VideoSource
}

const STATE_PREFIX = 'subs:state:'

/** One `tracklists` row as D1 returns it. */
export type TracklistRow = {
  slug: string
  url: string
  position: number
  discovered_at: number
  processed: number
  abandoned: number
  failure_count: number
  video_known: number
  video_id: string | null
  video_source: string | null
  checked_at: number | null
}

type SubSyncRow = {
  slug: string
  playlist_id: string | null
  artist_name: string | null
  last_run_at: number | null
  last_error: string | null
  last_run_stats: string | null
}

const nowSeconds = () => Math.floor(Date.now() / 1000)

// ─── rows ⇄ SubState ────────────────────────────────────────────────────────

export function rowsToState(sync: SubSyncRow | null, rows: TracklistRow[]): SubState {
  const ordered = [...rows].sort((a, b) => a.position - b.position)
  const discovered: string[] = []
  const processed: string[] = []
  const abandoned: string[] = []
  const failureCounts: Record<string, number> = {}
  const tracklistVideos: Record<string, TracklistVideo> = {}
  let anyRecord = false
  for (const r of ordered) {
    discovered.push(r.url)
    if (r.processed) processed.push(r.url)
    if (r.abandoned) abandoned.push(r.url)
    if (r.failure_count > 0) failureCounts[r.url] = r.failure_count
    if (r.checked_at !== null || r.video_known) {
      anyRecord = true
      const entry: TracklistVideo = { checkedAt: r.checked_at ?? 0 }
      if (r.video_known) entry.videoId = r.video_id
      // `1001tl` is the default and stays implicit; only an mkvid upload is marked.
      if (r.video_id && r.video_source === 'mkvid') entry.source = 'mkvid'
      tracklistVideos[r.url] = entry
    }
  }
  const state: SubState = {
    discoveredTracklistUrls: discovered,
    processedTracklistUrls: processed,
    abandonedTracklistUrls: abandoned,
    failureCounts,
    // Absent (not empty) when no row carries a record: that is the "state
    // written before rechecks existed" signal syncOne seeds from the audit
    // trail. A DJ whose sets are all unprocessed has no records either, but
    // then there is nothing to seed and the distinction is moot.
    ...(anyRecord || processed.length === 0 ? { tracklistVideos } : {}),
  }
  if (sync) {
    if (sync.playlist_id) state.playlistId = sync.playlist_id
    if (sync.artist_name) state.artistName = sync.artist_name
    if (sync.last_run_at !== null) state.lastRunAt = sync.last_run_at
    if (sync.last_error) state.lastError = sync.last_error
    const stats = parseJson<SubState['lastRunStats'] | null>(sync.last_run_stats, null)
    if (stats) state.lastRunStats = stats
  }
  return state
}

/** Every URL the state knows about, in discovery order, deduplicated. */
export function stateUrls(state: SubState): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  const add = (u: string) => {
    if (!seen.has(u)) {
      seen.add(u)
      out.push(u)
    }
  }
  for (const u of state.discoveredTracklistUrls ?? []) add(u)
  for (const u of state.processedTracklistUrls) add(u)
  for (const u of state.abandonedTracklistUrls ?? []) add(u)
  for (const u of Object.keys(state.failureCounts ?? {})) add(u)
  for (const u of Object.keys(state.tracklistVideos ?? {})) add(u)
  return out
}

/** The mutable (non-identity) columns of a tracklist row, derived from state. */
export type TracklistFields = {
  processed: number
  abandoned: number
  failure_count: number
  video_known: number
  video_id: string | null
  video_source: string | null
  checked_at: number | null
}

export function stateToFields(state: SubState): Map<string, TracklistFields> {
  const processed = new Set(state.processedTracklistUrls)
  const abandoned = new Set(state.abandonedTracklistUrls ?? [])
  const out = new Map<string, TracklistFields>()
  for (const url of stateUrls(state)) {
    const rec = state.tracklistVideos?.[url]
    const known = rec !== undefined && rec.videoId !== undefined
    const videoId = known ? (rec!.videoId ?? null) : null
    out.set(url, {
      processed: processed.has(url) ? 1 : 0,
      abandoned: abandoned.has(url) ? 1 : 0,
      failure_count: state.failureCounts?.[url] ?? 0,
      video_known: known ? 1 : 0,
      video_id: videoId,
      video_source: videoId ? (rec!.source ?? '1001tl') : null,
      checked_at: rec ? rec.checkedAt : null,
    })
  }
  return out
}

function sameFields(a: TracklistFields, b: TracklistFields): boolean {
  return (
    a.processed === b.processed &&
    a.abandoned === b.abandoned &&
    a.failure_count === b.failure_count &&
    a.video_known === b.video_known &&
    a.video_id === b.video_id &&
    a.video_source === b.video_source &&
    a.checked_at === b.checked_at
  )
}

// ─── load / save ────────────────────────────────────────────────────────────

async function readRows(env: Env, slug: string): Promise<{ sync: SubSyncRow | null; rows: TracklistRow[] }> {
  const db = dbOf(env)
  const [syncRes, rowsRes] = await db.batch<SubSyncRow | TracklistRow>([
    db.prepare('SELECT * FROM sub_sync WHERE slug = ?').bind(slug),
    db.prepare('SELECT * FROM tracklists WHERE slug = ? ORDER BY position').bind(slug),
  ])
  return {
    sync: (syncRes!.results[0] as SubSyncRow | undefined) ?? null,
    rows: rowsRes!.results as TracklistRow[],
  }
}

/**
 * The sync state for one DJ, or null when nothing has ever been recorded.
 * Imports the pre-D1 KV blob on first touch (see the module doc for why an
 * import failure throws rather than returning an empty state).
 */
export async function loadSubState(env: Env, slug: string, log?: Logger): Promise<SubState | null> {
  let { sync, rows } = await readRows(env, slug)
  if (!sync && rows.length === 0) {
    const imported = await importSubStateFromKv(env, slug, log)
    if (!imported) return null
    ;({ sync, rows } = await readRows(env, slug))
    if (!sync && rows.length === 0) return null
  }
  return rowsToState(sync, rows)
}

/**
 * Write `state` for `slug`. With `since` (the state as loaded), only changed
 * tracklist rows are upserted; the `sub_sync` row is always rewritten (its
 * `last_run_at` changes every run).
 */
export async function saveSubState(
  env: Env,
  slug: string,
  state: SubState,
  opts: { since?: SubState | null; discoveredAt?: number } = {},
): Promise<void> {
  const db = dbOf(env)
  const now = opts.discoveredAt ?? nowSeconds()
  const next = stateToFields(state)
  const prev = opts.since ? stateToFields(opts.since) : null
  const prevOrder = opts.since ? stateUrls(opts.since) : []
  const prevIndex = new Map(prevOrder.map((u, i) => [u, i] as const))
  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO sub_sync (slug, playlist_id, artist_name, last_run_at, last_error, last_run_stats)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(slug) DO UPDATE SET
           playlist_id = excluded.playlist_id, artist_name = excluded.artist_name,
           last_run_at = excluded.last_run_at, last_error = excluded.last_error,
           last_run_stats = excluded.last_run_stats`,
      )
      .bind(
        slug,
        v(state.playlistId),
        v(state.artistName),
        v(state.lastRunAt),
        v(state.lastError),
        state.lastRunStats ? JSON.stringify(state.lastRunStats) : null,
      ),
  ]
  const upsert = db.prepare(
    `INSERT INTO tracklists (slug, url, position, discovered_at, processed, abandoned, failure_count, video_known, video_id, video_source, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(slug, url) DO UPDATE SET
       processed = excluded.processed, abandoned = excluded.abandoned, failure_count = excluded.failure_count,
       video_known = excluded.video_known, video_id = excluded.video_id, video_source = excluded.video_source,
       checked_at = excluded.checked_at`,
  )
  let position = 0
  for (const [url, fields] of next) {
    const pos = position++
    if (prev) {
      const before = prev.get(url)
      if (before && sameFields(before, fields)) continue
    }
    // Position is only meaningful on insert (ON CONFLICT keeps the stored
    // one); for a URL the caller already knew, reuse its prior index so a
    // partial `since` can't reorder anything.
    const insertPos = prevIndex.get(url) ?? pos
    statements.push(
      upsert.bind(
        slug,
        url,
        insertPos,
        now,
        fields.processed,
        fields.abandoned,
        fields.failure_count,
        fields.video_known,
        fields.video_id,
        fields.video_source,
        fields.checked_at,
      ),
    )
  }
  await batchChunked(db, statements)
}

// ─── legacy KV import ───────────────────────────────────────────────────────

/**
 * Import the pre-D1 `subs:state:<slug>` blob, if there is one. Returns false
 * when KV has nothing for the slug. Throws on any read/write failure — see
 * the module doc.
 */
export async function importSubStateFromKv(env: Env, slug: string, log?: Logger): Promise<boolean> {
  const blob = (await env.SUBS.get(`${STATE_PREFIX}${slug}`, 'json')) as SubState | null
  if (!blob) return false
  if (!Array.isArray(blob.processedTracklistUrls)) {
    throw new Error(`subs:state:${slug} in KV is not a SubState blob; refusing to import`)
  }
  await saveSubState(env, slug, blob, { discoveredAt: blob.lastRunAt ?? nowSeconds() })
  log?.info('sync.state_imported_from_kv', {
    slug,
    discovered: blob.discoveredTracklistUrls?.length ?? 0,
    processed: blob.processedTracklistUrls.length,
    abandoned: blob.abandonedTracklistUrls?.length ?? 0,
    records: Object.keys(blob.tracklistVideos ?? {}).length,
  })
  return true
}

// ─── queries the sync uses instead of loading every blob ────────────────────

export type SubWorkCounts = { slug: string; pending: number; due: number }

/**
 * Per-slug counts of unprocessed sets and processed sets due for a recheck —
 * what the 5-minute cron needs to pick candidates without hydrating every
 * DJ's state. Only slugs with at least one tracklist row appear (a DJ that
 * has never been discovered has nothing to drain).
 */
export async function subWorkCounts(env: Env, recheckIntervalSeconds: number, now = nowSeconds()): Promise<SubWorkCounts[]> {
  const db = dbOf(env)
  const res = await db
    .prepare(
      `SELECT slug,
              SUM(CASE WHEN processed = 0 AND abandoned = 0 THEN 1 ELSE 0 END) AS pending,
              SUM(CASE WHEN processed = 1 AND abandoned = 0 AND (checked_at IS NULL OR checked_at <= ?) THEN 1 ELSE 0 END) AS due
       FROM tracklists GROUP BY slug`,
    )
    .bind(now - recheckIntervalSeconds)
    .all<{ slug: string; pending: number; due: number }>()
  return res.results.map((r) => ({ slug: r.slug, pending: Number(r.pending), due: Number(r.due) }))
}

/** Slugs (other than `exceptSlug`) with a tracklist currently resolved to `videoId`. */
export async function slugsReferencingVideo(env: Env, videoId: string, exceptSlug: string): Promise<string[]> {
  const res = await dbOf(env)
    .prepare('SELECT DISTINCT slug FROM tracklists WHERE video_id = ? AND slug != ?')
    .bind(videoId, exceptSlug)
    .all<{ slug: string }>()
  return res.results.map((r) => r.slug)
}

/** The sync summaries (playlist id, artist name) of every subscription that has one. */
export async function listSubSync(
  env: Env,
): Promise<Array<{ slug: string; playlistId: string | null; artistName: string | null; lastRunAt: number | null }>> {
  const res = await dbOf(env)
    .prepare('SELECT slug, playlist_id, artist_name, last_run_at FROM sub_sync')
    .all<{ slug: string; playlist_id: string | null; artist_name: string | null; last_run_at: number | null }>()
  return res.results.map((r) => ({
    slug: r.slug,
    playlistId: r.playlist_id,
    artistName: r.artist_name,
    lastRunAt: r.last_run_at === null ? null : Number(r.last_run_at),
  }))
}

/**
 * Mark every processed set of `slug` due for an immediate recheck (keeping its
 * recorded video), give abandoned sets another chance and reset failure
 * counts — the "Invalidate video cache" button. Returns what it touched.
 */
export async function invalidateSubTracklists(env: Env, slug: string): Promise<{ tracklistsMarked: number; abandonedCleared: number }> {
  const db = dbOf(env)
  const counts = await db
    .prepare(
      `SELECT SUM(CASE WHEN processed = 1 THEN 1 ELSE 0 END) AS processed,
              SUM(CASE WHEN abandoned = 1 THEN 1 ELSE 0 END) AS abandoned
       FROM tracklists WHERE slug = ?`,
    )
    .bind(slug)
    .first<{ processed: number | null; abandoned: number | null }>()
  await db.batch([
    db.prepare('UPDATE tracklists SET checked_at = 0 WHERE slug = ? AND processed = 1').bind(slug),
    db.prepare('UPDATE tracklists SET abandoned = 0, failure_count = 0 WHERE slug = ?').bind(slug),
  ])
  return { tracklistsMarked: Number(counts?.processed ?? 0), abandonedCleared: Number(counts?.abandoned ?? 0) }
}

/** Un-abandon and reset the failure count of specific sets. Returns the URLs that were actually changed. */
export async function requeueTracklists(env: Env, slug: string, urls: string[]): Promise<string[]> {
  if (urls.length === 0) return []
  const db = dbOf(env)
  const hit: string[] = []
  for (const url of urls) {
    const row = await db
      .prepare('SELECT abandoned, failure_count FROM tracklists WHERE slug = ? AND url = ?')
      .bind(slug, url)
      .first<{ abandoned: number; failure_count: number }>()
    if (row && (row.abandoned || row.failure_count > 0)) hit.push(url)
  }
  await batchChunked(
    db,
    hit.map((url) => db.prepare('UPDATE tracklists SET abandoned = 0, failure_count = 0 WHERE slug = ? AND url = ?').bind(slug, url)),
  )
  return hit
}

/** One tracklist row, or null. */
export async function getTracklistRow(env: Env, slug: string, url: string): Promise<TracklistRow | null> {
  return dbOf(env).prepare('SELECT * FROM tracklists WHERE slug = ? AND url = ?').bind(slug, url).first<TracklistRow>()
}

/** Record a video on one tracklist row directly (used when mkvid delivers an upload). */
export async function setTracklistVideo(
  env: Env,
  slug: string,
  url: string,
  video: { videoId: string; source: VideoSource; checkedAt?: number },
): Promise<void> {
  await dbOf(env)
    .prepare(
      `UPDATE tracklists SET video_known = 1, video_id = ?, video_source = ?, checked_at = ?, processed = 1
       WHERE slug = ? AND url = ?`,
    )
    .bind(video.videoId, video.source, video.checkedAt ?? nowSeconds(), slug, url)
    .run()
}
