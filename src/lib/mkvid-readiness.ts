/**
 * When a queued mkvid request may be rendered (spec decisions 1-4).
 *
 *   - Never for a set whose track list is not verified: the request stays
 *     `pending`, and the claim passes over it without touching it (no attempt
 *     used, no backoff).
 *   - A verified list that still has unidentified (ID) rows waits until the
 *     set is 7 days old — by its set date, else the day the sync discovered
 *     it — so 1001tracklists users have time to fill the IDs in; then it
 *     renders with "ID" shown. The panel's "Render now" sets `skip_id_wait`
 *     on the request, which skips that wait (never the verification).
 *   - Anything else that is pending and past its retry backoff is ready; the
 *     daily cap then decides whether it goes today.
 *
 * Verification itself belongs to the fetch layer (lib/verification.ts): a
 * list is verified when a second fetch by a different pool account agrees on
 * every row. `mkvid_request_tracks.trusted` (what the claim's `tracksTrusted`
 * is read from) is 1 only for a list saved while its set was verified, and is
 * reset to 0 whenever verification starts over; the claim checks both.
 */

import type { Env } from '../types'
import { dbOf } from './db'
import { isVerified } from './verification'

/** A verified list with ID rows is held until the set is this old. */
export const ID_WAIT_SECONDS = 7 * 86400

/** The fetch layer's verdict (lib/verification.ts), re-exported for the panel and tests. */
export { isVerified }

export type MkvidReadiness =
  | { state: 'ready' }
  /** No verified track list yet: nothing is rendered until there is one. */
  | { state: 'unverified' }
  /** Verified, but `idRows` rows are still ID: held until `until` (unix seconds) unless Render now is pressed. */
  | { state: 'waiting_ids'; until: number; idRows: number }
  /** A failed attempt's retry backoff. */
  | { state: 'backoff'; until: number }

/** What readiness is computed from: the request plus its stored list's summary. */
export type ReadinessInput = {
  status: string
  notBefore: number | null
  setDate: string | null
  /** tracklists.discovered_at of the set (earliest across DJs), else the request's created_at. */
  discoveredAt: number
  skipIdWait: boolean
  verified: boolean
  /** Rows in the stored list; 0 = none stored. */
  listRows: number
  /** ID rows in the stored list. */
  idRows: number
}

/** Unix seconds the set's age is counted from: its date, else when it was discovered. */
export function setAgeReference(setDate: string | null, discoveredAt: number): number {
  if (setDate && /^\d{4}-\d{2}-\d{2}$/.test(setDate)) {
    const t = Date.parse(`${setDate}T00:00:00Z`)
    if (Number.isFinite(t)) return Math.floor(t / 1000)
  }
  return discoveredAt
}

export function mkvidReadiness(r: ReadinessInput, now = Math.floor(Date.now() / 1000)): MkvidReadiness {
  if (!r.verified || r.listRows <= 0) return { state: 'unverified' }
  if (r.idRows > 0 && !r.skipIdWait) {
    const until = setAgeReference(r.setDate, r.discoveredAt) + ID_WAIT_SECONDS
    if (now < until) return { state: 'waiting_ids', until, idRows: r.idRows }
  }
  if (r.status === 'pending' && r.notBefore !== null && r.notBefore > now) return { state: 'backoff', until: r.notBefore }
  return { state: 'ready' }
}

/** SQL for the set's discovery time: the earliest tracklists row for the URL, else the request's own creation. */
export const DISCOVERED_SQL = '(COALESCE((SELECT MIN(tl.discovered_at) FROM tracklists tl WHERE tl.url = r.set_url), r.created_at))'

/**
 * SQL condition (over `mkvid_requests r JOIN mkvid_request_tracks t`) for the
 * parts of readiness that live in D1: a stored, non-empty, trusted (=
 * verified, see above) list whose ID wait is over or skipped. Binds one
 * value: the cut-off `now - ID_WAIT_SECONDS`.
 */
export const CLAIM_READY_SQL = `t.track_count > 0 AND t.trusted = 1
  AND (COALESCE(t.id_rows, 1) = 0 OR r.skip_id_wait = 1
       OR (CASE WHEN r.set_date IS NOT NULL AND r.set_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'
                THEN CAST(strftime('%s', r.set_date) AS INTEGER) ELSE ${DISCOVERED_SQL} END) <= ?)`

/**
 * Panel "Render now": this request skips the wait for IDs (it still needs a
 * verified list, and keeps its place in the queue). Any request that has not
 * been rendered yet — or is being recreated — can take it.
 */
export async function setSkipIdWait(env: Env, id: string): Promise<boolean> {
  const r = await dbOf(env)
    .prepare("UPDATE mkvid_requests SET skip_id_wait = 1, updated_at = ? WHERE id = ? AND status IN ('pending', 'claimed', 'failed', 'banned')")
    .bind(Math.floor(Date.now() / 1000), id)
    .run()
  return (r.meta.changes ?? 0) > 0
}

/** Readiness of a page of requests for the panel, in one query. Requests with no stored list are `unverified`. */
export async function readinessFor(
  env: Env,
  requests: ReadonlyArray<{ id: string; status: string; notBefore: number | null; setDate: string | null; skipIdWait: boolean }>,
  now = Math.floor(Date.now() / 1000),
): Promise<Map<string, MkvidReadiness>> {
  const out = new Map<string, MkvidReadiness>()
  if (!requests.length) return out
  const res = await dbOf(env)
    .prepare(
      `SELECT r.id AS id, ${DISCOVERED_SQL} AS discovered, t.trusted AS trusted, t.track_count AS n, t.id_rows AS id_rows
         FROM mkvid_requests r LEFT JOIN mkvid_request_tracks t ON t.request_id = r.id
        WHERE r.id IN (${requests.map(() => '?').join(', ')})`,
    )
    .bind(...requests.map((r) => r.id))
    .all<{ id: string; discovered: number; trusted: number | null; n: number | null; id_rows: number | null }>()
  const byId = new Map(res.results.map((x) => [x.id, x]))
  for (const r of requests) {
    const x = byId.get(r.id)
    out.set(
      r.id,
      mkvidReadiness(
        {
          status: r.status,
          notBefore: r.notBefore,
          setDate: r.setDate,
          discoveredAt: Number(x?.discovered ?? now),
          skipIdWait: r.skipIdWait,
          verified: Number(x?.trusted ?? 0) === 1,
          listRows: Number(x?.n ?? 0),
          // Not counted yet (a list stored before migration 0009): assume IDs, the claim does the same.
          idRows: x?.id_rows == null ? (Number(x?.n ?? 0) > 0 ? 1 : 0) : Number(x.id_rows),
        },
        now,
      ),
    )
  }
  return out
}
