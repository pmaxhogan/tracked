/**
 * Durable audit trail for playlist additions — the data behind the admin
 * panel's "Recent playlist additions" view.
 *
 * Mirrors the `np:` trail /now-playing writes for requests: one KV record per
 * tracklist the sync processed, keyed `pladd:<invertedTs>:<slug>:<i>` (90-day
 * TTL) so a plain `list()` returns newest-first in a single page, with a
 * compact summary duplicated into KV **metadata** so the list view needs no
 * per-row `get`.
 *
 * Records are buffered during a run and flushed in one parallel batch at the
 * end (`flushPlaylistAdditions`) rather than awaited inside the set loop:
 * a run processes up to 30 sets and sequential KV puts would eat a large slice
 * of the 25 s sync deadline. The tradeoff is that a run killed mid-loop loses
 * its rows — fine, because this is diagnostics only. Idempotency and progress
 * live in the per-sub state (see lib/sync.ts), never here.
 */

import type { Env } from '../types'
import { invertedTs, TTL } from './cache'
import type { CombinedAdditionStatus } from './combined-playlist'
import { errorFields, type Logger } from './log'

export const PLAYLIST_AUDIT_PREFIX = 'pladd:'

/**
 * Outcome for one tracklist the sync looked at:
 *  - `added`      the set's video was inserted into the playlist
 *  - `duplicate`  the video was already in the playlist (nothing inserted)
 *  - `no_youtube` the set page has no YouTube recording to add
 *  - `failed`     the set errored this run (a later run retries it)
 *  - `abandoned`  errored too many times in a row; the cron gives up on it
 *
 * `failed` and `abandoned` are what the panel's "problems only" filter keeps.
 */
export type PlaylistAdditionStatus = 'added' | 'duplicate' | 'no_youtube' | 'failed' | 'abandoned'

export type PlaylistAdditionRecord = {
  /** ISO timestamp of the moment the outcome was decided. */
  t: string
  status: PlaylistAdditionStatus
  /** Subscription slug, e.g. `lillypalmer`. */
  slug: string
  artistName: string | null
  /** 1001tracklists tracklist URL this row is about. */
  setUrl: string
  videoId: string | null
  videoUrl: string | null
  playlistId: string | null
  playlistTitle: string | null
  /**
   * What happened to the same video on its way into the combined all-artists
   * playlist. `unavailable` means that playlist couldn't be opened at all this
   * run — the combined backfill picks the video up later either way, which is
   * why a combined miss never fails the set. null on rows with no video.
   */
  combinedStatus: CombinedAdditionStatus | null
  /** Which scrape path served the set page — `home-proxy` / `unlocker` / `direct`. */
  via: string | null
  /** What kicked off the run, e.g. `cron.daily`, `manual.one`. */
  trigger: string | null
  /** Error message on `failed` / `abandoned`. */
  message: string | null
  /** Consecutive failures recorded for this set URL (failure rows only). */
  failureCount: number | null
  meta: { ms: number | null }
}

/**
 * Compact form stored in KV metadata for the list view. Must stay under KV's
 * 1024-byte metadata cap, hence the short keys and the truncations.
 */
export type PlaylistAdditionSummary = {
  t: string
  status: PlaylistAdditionStatus
  slug: string
  artist: string | null
  set: string
  vid: string | null
  via: string | null
  trg: string | null
  msg: string | null
  ms: number | null
  /** Combined-playlist outcome — see PlaylistAdditionRecord.combinedStatus. */
  cmb: CombinedAdditionStatus | null
}

export function playlistAdditionSummary(r: PlaylistAdditionRecord): PlaylistAdditionSummary {
  return {
    t: r.t,
    status: r.status,
    slug: r.slug,
    artist: r.artistName ? r.artistName.slice(0, 100) : null,
    set: r.setUrl.slice(0, 200),
    vid: r.videoId,
    via: r.via,
    trg: r.trigger,
    msg: r.message ? r.message.slice(0, 160) : null,
    ms: r.meta.ms,
    cmb: r.combinedStatus,
  }
}

/**
 * `i` is the record's index within the flushed batch, and it is inverted for
 * the same reason the timestamp is: cached/fast sets can resolve inside a
 * single millisecond, and a forward index would list those newest-last. It
 * also keeps same-millisecond rows from overwriting each other. Width 4 is far
 * above `maxSetsPerRun`, so the padding never truncates.
 */
export function playlistAdditionKey(r: PlaylistAdditionRecord, i: number): string {
  const invIdx = String(9999 - i).padStart(4, '0')
  return `${PLAYLIST_AUDIT_PREFIX}${invertedTs(Date.parse(r.t))}:${r.slug}:${invIdx}`
}

/**
 * Write a run's buffered rows. Best-effort by contract: a KV failure here must
 * never fail the sync that produced the rows, so everything is swallowed into
 * a warn log.
 */
export async function flushPlaylistAdditions(
  env: Env,
  records: PlaylistAdditionRecord[],
  log: Logger,
): Promise<void> {
  if (records.length === 0) return
  try {
    const results = await Promise.allSettled(
      records.map((r, i) =>
        env.CACHE.put(playlistAdditionKey(r, i), JSON.stringify(r), {
          expirationTtl: TTL.PLAYLIST_AUDIT,
          metadata: playlistAdditionSummary(r),
        }),
      ),
    )
    const rejected = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (rejected.length > 0) {
      log.warn('playlist_audit.write_failed', {
        failed: rejected.length,
        total: records.length,
        ...errorFields(rejected[0]!.reason),
      })
    }
  } catch (e) {
    log.warn('playlist_audit.flush_threw', { total: records.length, ...errorFields(e) })
  }
}
