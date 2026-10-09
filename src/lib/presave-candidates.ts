/**
 * Pre-save candidates (/ui/presaves, Candidates tab): tracks 1001tracklists
 * shows a Spotify "Pre-Save N" badge for with N >= 1 (people pre-saved the
 * Spotify release, which is not out yet) and that have neither a YouTube nor
 * a Spotify link. Read straight off set pages (lib/tracklists1001.ts
 * `presaveCount`, `hasYoutube`, `hasSpotify`): no extra fetch.
 *
 * Rules:
 *   - Every set fetch updates them (fetch-scheduler recordSetFetch), but only
 *     when the page's list is the set's verified list (the fingerprint the
 *     search index also requires): names from a decoy page never get in.
 *   - A row that qualifies is upserted (count, names, the set it was seen in,
 *     the time). A row on the page that no longer qualifies (a YouTube or
 *     Spotify link turned up, or the badge is gone or 0) is deleted, whatever
 *     set it was first seen in: links and counts belong to the track. A
 *     candidate last seen in this set whose row is gone from it is deleted too.
 *   - Key: `track:<medialink id>`, or `row:<page row id>` for a row without a
 *     media row (an ID row: its badge is keyed to the row).
 *   - Never throws; a failure is logged at warn as `presave_candidates.update_failed`.
 */
import type { Env } from '../types'
import { dbOf } from './db'
import { errorFields, type Logger } from './log'
import { normalizeTracklistUrl, type PageRow, type ScrapedTracklist } from './tracklists1001'
import { tracklistFingerprint, verifiedFingerprint } from './verification'

export type PresaveCandidateRow = {
  key: string
  track_id: string | null
  track_url: string | null
  artist: string | null
  title: string | null
  artwork_url: string | null
  label: string | null
  is_id: number
  presave_count: number
  set_url: string
  row_index: number | null
  cue_seconds: number | null
  dj_slug: string | null
  first_seen_at: number
  updated_at: number
}

/** The candidate key of a page row, or null when the row has no id at all. */
export function candidateKey(r: Pick<PageRow, 'mediaId' | 'trackId' | 'anonymous'>): string | null {
  if (r.mediaId) return `track:${r.mediaId}`
  return r.trackId ? `row:${r.trackId}` : null
}

/** Does a page row qualify: a pre-save count of at least 1, and no YouTube or Spotify link. */
export function isCandidateRow(r: Pick<PageRow, 'presaveCount' | 'hasYoutube' | 'hasSpotify'>): boolean {
  return (r.presaveCount ?? 0) >= 1 && !r.hasYoutube && !r.hasSpotify
}

const nameOrNull = (s: string | null | undefined): string | null => {
  const t = (s ?? '').trim()
  return t && t !== 'ID' ? t : null
}

export type CandidateUpdate = { status: 'updated' | 'not_verified' | 'skipped'; kept: number; dropped: number }

export async function updatePresaveCandidates(
  env: Env,
  rawSetUrl: string,
  parsed: Pick<ScrapedTracklist, 'rows' | 'tracks' | 'decoy'>,
  log?: Logger,
  now = Date.now(),
): Promise<CandidateUpdate> {
  const setUrl = normalizeTracklistUrl(rawSetUrl) ?? rawSetUrl
  try {
    if (!env.DB || !parsed?.rows?.length || parsed.decoy?.suspected) return { status: 'skipped', kept: 0, dropped: 0 }
    const fp = await verifiedFingerprint(env, rawSetUrl)
    if (!fp || fp !== (await tracklistFingerprint(parsed as ScrapedTracklist))) return { status: 'not_verified', kept: 0, dropped: 0 }

    const keep = new Map<string, Record<string, unknown>>()
    const onPage = new Set<string>()
    parsed.rows.forEach((r, i) => {
      const key = candidateKey(r)
      if (!key) return
      onPage.add(key)
      if (!isCandidateRow(r) || keep.has(key)) return
      keep.set(key, {
        key,
        track_id: r.mediaId ?? null,
        track_url: r.trackUrl ?? null,
        artist: nameOrNull(r.artist),
        title: nameOrNull(r.title),
        artwork_url: r.artworkUrl ?? null,
        label: r.label ?? null,
        is_id: r.anonymous || r.isUnidentified ? 1 : 0,
        presave_count: r.presaveCount ?? 0,
        row_index: i,
        cue_seconds: r.ownStartSeconds ?? r.startSeconds ?? null,
      })
    })
    const drop = [...onPage].filter((k) => !keep.has(k))
    const db = dbOf(env)
    const slug = await db.prepare('SELECT MIN(slug) AS slug FROM tracklists WHERE url = ? AND slug IN (SELECT slug FROM subscriptions)').bind(rawSetUrl).first<{ slug: string | null }>()
    const statements = [
      db.prepare('DELETE FROM presave_candidates WHERE key IN (SELECT value FROM json_each(?))').bind(JSON.stringify(drop)),
      db.prepare('DELETE FROM presave_candidates WHERE set_url = ? AND key NOT IN (SELECT value FROM json_each(?))').bind(setUrl, JSON.stringify([...onPage])),
    ]
    if (keep.size > 0) {
      statements.push(
        db
          .prepare(
            `INSERT INTO presave_candidates (key, track_id, track_url, artist, title, artwork_url, label, is_id, presave_count, set_url, row_index, cue_seconds, dj_slug, first_seen_at, updated_at)
             SELECT json_extract(value, '$.key'), json_extract(value, '$.track_id'), json_extract(value, '$.track_url'), json_extract(value, '$.artist'),
                    json_extract(value, '$.title'), json_extract(value, '$.artwork_url'), json_extract(value, '$.label'), json_extract(value, '$.is_id'),
                    json_extract(value, '$.presave_count'), ?1, json_extract(value, '$.row_index'), json_extract(value, '$.cue_seconds'), ?2, ?3, ?3
               FROM json_each(?4) WHERE true
             ON CONFLICT(key) DO UPDATE SET track_id = excluded.track_id, track_url = excluded.track_url, artist = excluded.artist, title = excluded.title,
               artwork_url = COALESCE(excluded.artwork_url, presave_candidates.artwork_url), label = excluded.label, is_id = excluded.is_id,
               presave_count = excluded.presave_count, set_url = excluded.set_url, row_index = excluded.row_index, cue_seconds = excluded.cue_seconds,
               dj_slug = excluded.dj_slug, updated_at = excluded.updated_at`,
          )
          .bind(setUrl, slug?.slug ?? null, now, JSON.stringify([...keep.values()])),
      )
    }
    await db.batch(statements)
    return { status: 'updated', kept: keep.size, dropped: drop.length }
  } catch (e) {
    log?.warn('presave_candidates.update_failed', { setUrl, ...errorFields(e) })
    return { status: 'skipped', kept: 0, dropped: 0 }
  }
}

export type PresaveCandidateOut = {
  key: string
  trackId: string | null
  trackUrl: string | null
  artist: string | null
  title: string | null
  artworkUrl: string | null
  label: string | null
  isId: boolean
  presaveCount: number
  setUrl: string
  rowIndex: number | null
  cueSeconds: number | null
  djSlug: string | null
  firstSeenAt: number
  updatedAt: number
  /** The pre-save already made for it (by track id, or by set row for an ID row), if any. */
  presaveId: number | null
  presaveStage: string | null
}

export function candidateOut(r: PresaveCandidateRow & { presave_id?: number | null; presave_stage?: string | null }): PresaveCandidateOut {
  return {
    key: r.key,
    trackId: r.track_id,
    trackUrl: r.track_url,
    artist: r.artist,
    title: r.title,
    artworkUrl: r.artwork_url,
    label: r.label,
    isId: Number(r.is_id) === 1,
    presaveCount: Number(r.presave_count),
    setUrl: r.set_url,
    rowIndex: r.row_index,
    cueSeconds: r.cue_seconds,
    djSlug: r.dj_slug,
    firstSeenAt: Number(r.first_seen_at),
    updatedAt: Number(r.updated_at),
    presaveId: r.presave_id ?? null,
    presaveStage: r.presave_stage ?? null,
  }
}

/** The presave matching a candidate: by medialink id, or (an ID row) by set and row. Trusted SQL, `c` = presave_candidates. */
export const CANDIDATE_PRESAVE_SQL = `(SELECT p.id FROM presaves p WHERE (c.track_id IS NOT NULL AND p.track_id = c.track_id) OR (c.track_id IS NULL AND p.track_id IS NULL AND p.set_url = c.set_url AND p.row_index = c.row_index) LIMIT 1)`
