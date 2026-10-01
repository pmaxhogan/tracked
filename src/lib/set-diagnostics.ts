// Read-only "why isn't set X in my playlist" report: one set's discovery,
// schedule, verification, full-recording verdict, playlist and hygiene
// evidence and mkvid state, from D1 and cached facts only. It never calls
// YouTube, tlpool or 1001tracklists, and never writes.
import type { Env } from '../types'
import { dbOf } from './db'
import { getVerification } from './verification'
import { loadSetFacts, judgeVideo, rejectVerticalEnabled, REASON_LABELS } from './playlist-hygiene'
import { readCachedVideoMeta } from './video-meta'
import { isOverridden } from './playlist-blocklist'
import { getMkvidRequestForSet, mkvidQueuePosition } from './mkvid'
import { readinessFor, type MkvidReadiness } from './mkvid-readiness'

export type SetDiagnostics = {
  url: string
  now: number
  discovered: Array<{ slug: string; artistName: string | null; discoveredAt: number; processed: boolean; abandoned: boolean; failureCount: number; videoKnown: boolean; videoId: string | null; videoSource: string | null; checkedAt: number | null }>
  schedule: { setDate: string | null; nextDueAt: number | null; lastFetchedAt: number | null; hasIdRows: boolean; noGoodVideo: boolean; retryAt: number | null; attemptDay: string | null; attemptsToday: number } | null
  verification: { state: 'pending' | 'verified'; rowCount: number; firstAccount: string | null; firstFetchedAt: number; verifyDueAt: number | null; secondAccount: string | null; secondFetchedAt: number | null; verifiedAt: number | null; mismatches: number } | null
  media: { videoId: string | null; noFullNotice: boolean; lastCueSeconds: number | null; audioMaxSeconds: number | null; audioKind: string | null; setTitle: string | null; setDate: string | null; trackCount: number | null; idedCount: number | null; fetchedAt: number } | null
  video: {
    id: string
    from: 'tracklists' | 'media' | 'mkvid'
    meta: { durationSeconds: number | null; embedWidth: number | null; embedHeight: number | null; privacy: string | null; uploadStatus: string | null; alive: boolean; fetchedAt: number } | null
    verdict: { ok: true } | { ok: false; reason: string; label: string; detail: string } | null
    override: boolean
  } | null
  playlist: {
    additions: Array<{ key: string; ts: number; status: string; slug: string; videoId: string | null; message: string | null }>
    confirmed: Array<{ playlistId: string; state: 'in' | 'out'; source: string; at: number }>
  }
  hygiene: {
    removed: Array<{ playlistId: string; reason: string; at: number; slug: string | null }>
    removals: Array<{ id: number; at: number; source: string; status: string; playlistKind: string; reason: string; detail: string | null }>
  }
  mkvid: {
    id: string
    status: string
    position: number | null
    readiness: MkvidReadiness | null
    attempts: number
    notBefore: number | null
    error: string | null
    videoId: string | null
    style: string | null
    account: string
    skipIdWait: boolean
    list: { trackCount: number; idRows: number | null; trusted: boolean; named: number; mismatched: number; scrapedAt: number } | null
  } | null
}

const ACCT = /^acct-\d+$/
const acct = (s: string | null | undefined): string | null => (s && ACCT.test(s) ? s : null)
const numOrNull = (x: unknown): number | null => (x === null || x === undefined ? null : Number(x))

type TracklistRow = {
  slug: string
  artist_name: string | null
  discovered_at: number
  processed: number
  abandoned: number
  failure_count: number
  video_known: number
  video_id: string | null
  video_source: string | null
  checked_at: number | null
}
type ScheduleRow = {
  set_date: string | null
  next_due_at: number | null
  last_fetched_at: number | null
  has_id_rows: number
  no_good_video: number
  retry_at: number | null
  attempt_day: string | null
  attempts_today: number
}
type AdditionRow = { id: number; ts: number; status: string; slug: string; video_id: string | null; msg: string | null }
type TrackListRow = { track_count: number; id_rows: number | null; trusted: number; named: number; mismatched: number; scraped_at: number }

/** `url` must already be normalized (normalizeTracklistUrl). */
export async function setDiagnostics(env: Env, url: string): Promise<SetDiagnostics> {
  const db = dbOf(env)
  const now = Math.floor(Date.now() / 1000)

  const [tl, sched, ver, factsMap, adds, req] = await Promise.all([
    db
      .prepare(
        `SELECT t.slug AS slug, s.artist_name AS artist_name, t.discovered_at, t.processed, t.abandoned, t.failure_count,
                t.video_known, t.video_id, t.video_source, t.checked_at
           FROM tracklists t LEFT JOIN sub_sync s ON s.slug = t.slug
          WHERE t.url = ? ORDER BY t.discovered_at ASC, t.slug ASC`,
      )
      .bind(url)
      .all<TracklistRow>(),
    db.prepare('SELECT * FROM set_schedule WHERE url = ?').bind(url).first<ScheduleRow>(),
    getVerification(env, url),
    loadSetFacts(env, [url]),
    db
      .prepare(
        `SELECT id, ts, status, slug, video_id, json_extract(summary, '$.msg') AS msg
           FROM playlist_additions WHERE set_url = ? ORDER BY ts DESC, id DESC LIMIT 10`,
      )
      .bind(url)
      .all<AdditionRow>(),
    getMkvidRequestForSet(env, url),
  ])

  const facts = factsMap.get(url) ?? null
  const [position, readiness, listRow] = req
    ? await Promise.all([
        req.status === 'pending' ? mkvidQueuePosition(env, req.id) : Promise.resolve(null),
        readinessFor(env, [req]).then((m) => m.get(req.id) ?? null),
        db
          .prepare('SELECT track_count, id_rows, trusted, named, mismatched, scraped_at FROM mkvid_request_tracks WHERE request_id = ?')
          .bind(req.id)
          .first<TrackListRow>(),
      ])
    : [null, null, null]

  const discovered = tl.results.map((r) => ({
    slug: r.slug,
    artistName: r.artist_name,
    discoveredAt: Number(r.discovered_at),
    processed: Number(r.processed) === 1,
    abandoned: Number(r.abandoned) === 1,
    failureCount: Number(r.failure_count),
    videoKnown: Number(r.video_known) === 1,
    videoId: r.video_id,
    videoSource: r.video_source,
    checkedAt: numOrNull(r.checked_at),
  }))

  let videoId: string | null = null
  let from: 'tracklists' | 'media' | 'mkvid' = 'tracklists'
  const fromTracklists = discovered.find((d) => d.videoId)?.videoId ?? null
  if (fromTracklists) videoId = fromTracklists
  else if (facts?.videoId) {
    videoId = facts.videoId
    from = 'media'
  } else if (req?.videoId) {
    videoId = req.videoId
    from = 'mkvid'
  }

  let video: SetDiagnostics['video'] = null
  let confirmed: SetDiagnostics['playlist']['confirmed'] = []
  let removed: SetDiagnostics['hygiene']['removed'] = []
  let removals: SetDiagnostics['hygiene']['removals'] = []
  if (videoId) {
    const [metaMap, override, conf, rem, rems] = await Promise.all([
      readCachedVideoMeta(env, [videoId]),
      isOverridden(env, videoId),
      db
        .prepare('SELECT playlist_id, state, source, at FROM playlist_confirmed WHERE video_id = ? ORDER BY at DESC, playlist_id ASC')
        .bind(videoId)
        .all<{ playlist_id: string; state: string; source: string; at: number }>(),
      db
        .prepare('SELECT playlist_id, reason, at, slug FROM removed_videos WHERE video_id = ? ORDER BY at DESC, playlist_id ASC')
        .bind(videoId)
        .all<{ playlist_id: string; reason: string; at: number; slug: string | null }>(),
      db
        .prepare('SELECT id, at, source, status, playlist_kind, reason, detail FROM playlist_removals WHERE video_id = ? ORDER BY at DESC, id DESC LIMIT 20')
        .bind(videoId)
        .all<{ id: number; at: number; source: string; status: string; playlist_kind: string; reason: string; detail: string | null }>(),
    ])
    const meta = metaMap.get(videoId) ?? null
    const v = facts || meta ? judgeVideo(facts, meta, { rejectVertical: rejectVerticalEnabled(env) }) : null
    video = {
      id: videoId,
      from,
      meta: meta
        ? {
            durationSeconds: meta.durationSeconds,
            embedWidth: meta.embedWidth,
            embedHeight: meta.embedHeight,
            privacy: meta.privacy,
            uploadStatus: meta.uploadStatus,
            alive: meta.alive,
            fetchedAt: meta.fetchedAt,
          }
        : null,
      verdict: v ? (v.ok ? { ok: true } : { ok: false, reason: v.reason, label: REASON_LABELS[v.reason] ?? v.reason, detail: v.detail }) : null,
      override,
    }
    confirmed = conf.results.map((r) => ({ playlistId: r.playlist_id, state: r.state === 'in' ? 'in' : 'out', source: r.source, at: Number(r.at) }))
    removed = rem.results.map((r) => ({ playlistId: r.playlist_id, reason: r.reason, at: Number(r.at), slug: r.slug }))
    removals = rems.results.map((r) => ({ id: Number(r.id), at: Number(r.at), source: r.source, status: r.status, playlistKind: r.playlist_kind, reason: r.reason, detail: r.detail }))
  }

  return {
    url,
    now,
    discovered,
    schedule: sched
      ? {
          setDate: sched.set_date,
          nextDueAt: numOrNull(sched.next_due_at),
          lastFetchedAt: numOrNull(sched.last_fetched_at),
          hasIdRows: Number(sched.has_id_rows) === 1,
          noGoodVideo: Number(sched.no_good_video) === 1,
          retryAt: numOrNull(sched.retry_at),
          attemptDay: sched.attempt_day,
          attemptsToday: Number(sched.attempts_today ?? 0),
        }
      : null,
    verification: ver
      ? {
          state: ver.state,
          rowCount: Number(ver.row_count),
          firstAccount: acct(ver.first_account),
          firstFetchedAt: Number(ver.first_fetched_at),
          verifyDueAt: numOrNull(ver.verify_due_at),
          secondAccount: acct(ver.second_account),
          secondFetchedAt: numOrNull(ver.second_fetched_at),
          verifiedAt: numOrNull(ver.verified_at),
          mismatches: Number(ver.mismatches),
        }
      : null,
    media: facts
      ? {
          videoId: facts.videoId,
          noFullNotice: facts.noFullNotice,
          lastCueSeconds: facts.lastCueSeconds,
          audioMaxSeconds: facts.audioMaxSeconds,
          audioKind: facts.audioKind,
          setTitle: facts.setTitle,
          setDate: facts.setDate,
          trackCount: facts.trackCount,
          idedCount: facts.idedCount,
          fetchedAt: facts.fetchedAt,
        }
      : null,
    video,
    playlist: {
      additions: adds.results.map((r) => ({ key: String(r.id), ts: Number(r.ts), status: r.status, slug: r.slug, videoId: r.video_id, message: r.msg ?? null })),
      confirmed,
    },
    hygiene: { removed, removals },
    mkvid: req
      ? {
          id: req.id,
          status: req.status,
          position,
          readiness,
          attempts: req.attempts,
          notBefore: req.notBefore,
          error: req.error,
          videoId: req.videoId,
          style: req.style,
          account: req.account,
          skipIdWait: req.skipIdWait,
          list: listRow
            ? {
                trackCount: Number(listRow.track_count),
                idRows: numOrNull(listRow.id_rows),
                trusted: Number(listRow.trusted) === 1,
                named: Number(listRow.named),
                mismatched: Number(listRow.mismatched),
                scrapedAt: Number(listRow.scraped_at),
              }
            : null,
        }
      : null,
  }
}
