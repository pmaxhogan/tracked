import type { Env } from '../types'
import { dbOf } from './db'
import type { TableDef } from './table-query'

/**
 * The DJs and Playlists pages' table (GET /ui/api/djs): one row per
 * subscription with its sync summary, in one D1 query (subscriptions +
 * sub_sync + per-DJ aggregates over tracklists), sorted, filtered, searched
 * and paged by lib/table-query. It replaces the old "list, then one
 * /ui/api/state/:slug per row" fan-out; that per-DJ endpoint stays for the
 * DJ profile and other callers.
 *
 * Counts follow the old client-side summary (dj-actions summarize()):
 * `sets` = every tracklist row of the DJ, `processed` = resolved (with or
 * without a video; abandoned sets are moved to processed by the sync),
 * `pending` = not processed yet, `videos` = rows with a video, `mkvid` = those
 * rendered by mkvid.
 *
 * Also `djSetFacts`: what D1 knows about each of one DJ's sets (video,
 * track/ID counts from the last page fetch), merged into GET /ui/api/dj/:slug
 * so the profile's chips work for every set the sync has seen.
 */

type DjDbRow = {
  slug: string
  source_url: string
  added_at: number
  position: number
  artist_name: string | null
  playlist_id: string | null
  last_run_at: number | null
  last_error: string | null
  last_added: number | null
  sets: number
  processed: number
  pending: number
  abandoned: number
  videos: number
  mkvid: number
  last_discovered_at: number | null
}

export type DjTableRow = {
  slug: string
  name: string
  artistName: string | null
  sourceUrl: string
  /** Unix ms. */
  addedAt: number
  sets: number
  processed: number
  pending: number
  abandoned: number
  videos: number
  mkvid: number
  playlistId: string | null
  playlistUrl: string | null
  /** Unix ms, null when the DJ was never synced. */
  lastRunAt: number | null
  lastError: string | null
  hasError: boolean
  /** Videos the last run added (lastRunStats.videoIdsAdded). */
  lastAdded: number | null
  /** Unix ms of the newest set discovery. */
  lastDiscoveredAt: number | null
}

const AGG = `(SELECT slug, COUNT(*) AS sets, SUM(processed) AS processed,
    SUM(CASE WHEN processed = 0 THEN 1 ELSE 0 END) AS pending, SUM(abandoned) AS abandoned,
    SUM(CASE WHEN video_id IS NOT NULL THEN 1 ELSE 0 END) AS videos,
    SUM(CASE WHEN video_id IS NOT NULL AND video_source = 'mkvid' THEN 1 ELSE 0 END) AS mkvid,
    MAX(discovered_at) AS last_discovered_at
  FROM tracklists GROUP BY slug)`

const HAS_ERROR = `(y.last_error IS NOT NULL AND y.last_error != '')`

export const DJS_TABLE: TableDef<DjDbRow, DjTableRow> = {
  from: `subscriptions s LEFT JOIN sub_sync y ON y.slug = s.slug LEFT JOIN ${AGG} t ON t.slug = s.slug`,
  select: `s.slug AS slug, s.source_url AS source_url, s.added_at AS added_at, s.position AS position,
    y.artist_name AS artist_name, y.playlist_id AS playlist_id, y.last_run_at AS last_run_at, y.last_error AS last_error,
    json_extract(y.last_run_stats, '$.videoIdsAdded') AS last_added,
    COALESCE(t.sets, 0) AS sets, COALESCE(t.processed, 0) AS processed, COALESCE(t.pending, 0) AS pending,
    COALESCE(t.abandoned, 0) AS abandoned, COALESCE(t.videos, 0) AS videos, COALESCE(t.mkvid, 0) AS mkvid,
    t.last_discovered_at AS last_discovered_at`,
  primaryKey: 'slug',
  defaultSort: 'name',
  columns: {
    slug: { sql: 's.slug', type: 'text', searchable: true },
    name: { sql: 'COALESCE(y.artist_name, s.slug)', type: 'text', searchable: true },
    position: { sql: 's.position', type: 'number' },
    addedAt: { sql: 's.added_at', type: 'datetime', storage: 's' },
    sets: { sql: 'COALESCE(t.sets, 0)', type: 'number' },
    processed: { sql: 'COALESCE(t.processed, 0)', type: 'number' },
    pending: { sql: 'COALESCE(t.pending, 0)', type: 'number' },
    abandoned: { sql: 'COALESCE(t.abandoned, 0)', type: 'number' },
    videos: { sql: 'COALESCE(t.videos, 0)', type: 'number' },
    mkvid: { sql: 'COALESCE(t.mkvid, 0)', type: 'number' },
    lastRunAt: { sql: 'y.last_run_at', type: 'datetime', storage: 's' },
    lastDiscoveredAt: { sql: 't.last_discovered_at', type: 'datetime', storage: 's' },
    hasError: { sql: HAS_ERROR, type: 'bool' },
    lastError: { sql: 'y.last_error', type: 'text', searchable: true },
    hasPlaylist: { sql: '(y.playlist_id IS NOT NULL)', type: 'bool' },
    playlistId: { sql: 'y.playlist_id', type: 'text' },
    lastAdded: { sql: "json_extract(y.last_run_stats, '$.videoIdsAdded')", type: 'number' },
  },
  mapRow: (r) => djTableRow(r),
}

export function djTableRow(r: DjDbRow): DjTableRow {
  const lastRun = r.last_run_at == null ? null : Number(r.last_run_at)
  return {
    slug: r.slug,
    name: r.artist_name || r.slug,
    artistName: r.artist_name,
    sourceUrl: r.source_url,
    addedAt: Number(r.added_at) * 1000,
    sets: Number(r.sets) || 0,
    processed: Number(r.processed) || 0,
    pending: Number(r.pending) || 0,
    abandoned: Number(r.abandoned) || 0,
    videos: Number(r.videos) || 0,
    mkvid: Number(r.mkvid) || 0,
    playlistId: r.playlist_id,
    playlistUrl: r.playlist_id ? `https://www.youtube.com/playlist?list=${encodeURIComponent(r.playlist_id)}` : null,
    lastRunAt: lastRun == null ? null : lastRun * 1000,
    lastError: r.last_error || null,
    hasError: !!r.last_error,
    lastAdded: r.last_added == null ? null : Number(r.last_added),
    lastDiscoveredAt: r.last_discovered_at == null ? null : Number(r.last_discovered_at) * 1000,
  }
}

export type DjCounts = { total: number; errors: number; pending: number; neverSynced: number; noPlaylist: number; mkvid: number }

/** Totals for the DJs / Playlists chips (over every subscription, not the filtered page). */
export async function djCounts(env: Env): Promise<DjCounts> {
  const r = await dbOf(env)
    .prepare(
      `SELECT COUNT(*) AS total,
         SUM(CASE WHEN ${HAS_ERROR} THEN 1 ELSE 0 END) AS errors,
         SUM(CASE WHEN COALESCE(t.pending, 0) > 0 THEN 1 ELSE 0 END) AS pending,
         SUM(CASE WHEN y.last_run_at IS NULL THEN 1 ELSE 0 END) AS never_synced,
         SUM(CASE WHEN y.playlist_id IS NULL THEN 1 ELSE 0 END) AS no_playlist,
         SUM(CASE WHEN COALESCE(t.mkvid, 0) > 0 THEN 1 ELSE 0 END) AS mkvid
       FROM subscriptions s LEFT JOIN sub_sync y ON y.slug = s.slug LEFT JOIN ${AGG} t ON t.slug = s.slug`,
    )
    .first<{ total: number; errors: number | null; pending: number | null; never_synced: number | null; no_playlist: number | null; mkvid: number | null }>()
  return {
    total: Number(r?.total ?? 0),
    errors: Number(r?.errors ?? 0),
    pending: Number(r?.pending ?? 0),
    neverSynced: Number(r?.never_synced ?? 0),
    noPlaylist: Number(r?.no_playlist ?? 0),
    mkvid: Number(r?.mkvid ?? 0),
  }
}

/**
 * What D1 knows about one set of a DJ. `video`: 'page' = the 1001tracklists
 * page links a recording (it is or was the playlist video), 'mkvid' = mkvid
 * rendered one, 'none' = the page had none when last fetched, null = never
 * fetched. trackCount / idedCount come from the last page fetch
 * (set_media_facts), null when unknown.
 */
export type DjSetFacts = {
  /** The sync has a tracklists row for it (false: only a page fetch recorded it). */
  tracked: boolean
  processed: boolean
  abandoned: boolean
  video: 'page' | 'mkvid' | 'none' | null
  videoId: string | null
  trackCount: number | null
  idedCount: number | null
  /** Unix ms of the page fetch the counts come from. */
  factsAt: number | null
}

type FactsRow = {
  url: string
  processed: number | null
  abandoned: number | null
  video_known: number | null
  video_id: string | null
  video_source: string | null
  page_video: string | null
  track_count: number | null
  ided_count: number | null
  fetched_at: number | null
  has_facts: number
}

/** Facts for every set of `slug` D1 has a tracklist row or a page-facts row for, by set URL. */
export async function djSetFacts(env: Env, slug: string): Promise<Map<string, DjSetFacts>> {
  const db = dbOf(env)
  const [a, b] = await db.batch<FactsRow>([
    db
      .prepare(
        `SELECT t.url AS url, t.processed AS processed, t.abandoned AS abandoned, t.video_known AS video_known,
           t.video_id AS video_id, t.video_source AS video_source, f.video_id AS page_video,
           f.track_count AS track_count, f.ided_count AS ided_count, f.fetched_at AS fetched_at,
           CASE WHEN f.set_url IS NULL THEN 0 ELSE 1 END AS has_facts
         FROM tracklists t LEFT JOIN set_media_facts f ON f.set_url = t.url WHERE t.slug = ?`,
      )
      .bind(slug),
    db
      .prepare(
        `SELECT f.set_url AS url, NULL AS processed, NULL AS abandoned, NULL AS video_known, NULL AS video_id,
           NULL AS video_source, f.video_id AS page_video, f.track_count AS track_count, f.ided_count AS ided_count,
           f.fetched_at AS fetched_at, 1 AS has_facts
         FROM set_media_facts f WHERE f.slug = ?`,
      )
      .bind(slug),
  ])
  const out = new Map<string, DjSetFacts>()
  for (const r of [...(a?.results ?? []), ...(b?.results ?? [])]) {
    if (out.has(r.url)) continue
    let video: DjSetFacts['video'] = null
    let videoId: string | null = null
    if (r.video_id) {
      video = r.video_source === 'mkvid' ? 'mkvid' : 'page'
      videoId = r.video_id
    } else if (r.page_video) {
      video = 'page'
      videoId = r.page_video
    } else if (r.video_known || r.has_facts) {
      video = 'none'
    }
    out.set(r.url, {
      tracked: r.processed != null,
      processed: !!r.processed,
      abandoned: !!r.abandoned,
      video,
      videoId,
      trackCount: r.track_count == null ? null : Number(r.track_count),
      idedCount: r.ided_count == null ? null : Number(r.ided_count),
      factsAt: r.has_facts && r.fetched_at != null ? Number(r.fetched_at) * 1000 : null,
    })
  }
  return out
}
