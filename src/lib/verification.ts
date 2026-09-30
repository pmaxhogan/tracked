/**
 * Verified track lists (quest decision 2).
 *
 * Since ~2026-09-22 1001tracklists serves flagged accounts decoy pages: real
 * cues, ids and artwork, randomized names. The in-page decoy detector
 * (`DecoySignal`, lib/tracklists1001.ts) catches most of them; this module is
 * the second, independent check. A list is `verified` only when:
 *   1. a fetch passes the decoy detector (no row contradicts itself), and
 *   2. a second fetch at least `verify.minGapHours` (2 h) later, served by a
 *      DIFFERENT pool account, also passes it, and
 *   3. both give the same rows: row count, artist and title on every row,
 *      cues, own cues and layering ("w/" rows), anonymous rows in place.
 * Decoy names are re-randomized per fetch and per account, so two agreeing
 * fetches from two accounts are the evidence the names are real.
 *
 * State per set URL in `set_verification` (migration 0007):
 *   - no row: nothing trustworthy fetched yet
 *   - `pending`: one passing fetch recorded; the scheduler asks for the
 *     second one (priority `verify`, `excludeAccounts`) once `verify_due_at`
 *     passes
 *   - `verified`
 *
 * Disagreements:
 *   - The pair disagrees (pending, different account, different rows): the
 *     first account may be flagged, so it is reported to tlpool
 *     (`POST /accounts/:id/retest`) and verification starts over from the
 *     second fetch, which must now be confirmed by a third account.
 *   - A verified list changes on a later recheck: 1001tracklists users edit
 *     lists (IDs get identified), so this resets verification without
 *     accusing anyone.
 *   - Any fetch the decoy detector rejects reports its account to tlpool and
 *     leaves the state untouched.
 *
 * `isVerified(env, setUrl)` is the gate W7's render eligibility and
 * `mkvidTracksTrusted` use: names are only burned into a video from a
 * verified list.
 */

import { dbOf, parseJson } from './db'
import type { Logger } from './log'
import { poolRetestAccount, type PoolConfig } from './pool'
import type { PoolSettings } from './pool-settings'
import type { ScrapedTracklist } from './tracklists1001'
import type { Env } from '../types'

export type VerificationState = 'pending' | 'verified'

export type VerificationRow = {
  url: string
  state: VerificationState
  fingerprint: string
  row_count: number
  first_account: string
  first_fetched_at: number
  verify_due_at: number | null
  second_account: string | null
  second_fetched_at: number | null
  verified_at: number | null
  exclude_accounts: string
  mismatches: number
  updated_at: number
}

type Parsed = Pick<ScrapedTracklist, 'rows' | 'decoy'>

/** Case- and whitespace-insensitive, like the decoy detector's own comparison. */
const norm = (s: string | null | undefined): string => (s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim()

/** The rows reduced to what "the same list" means (decision 2). */
export function fingerprintInput(parsed: Pick<ScrapedTracklist, 'rows'>): string {
  return JSON.stringify(
    parsed.rows.map((r) => [
      norm(r.artist),
      norm(r.title),
      r.startSeconds ?? null,
      r.ownStartSeconds ?? null,
      r.isMashupLinked ? 1 : 0,
      (r as { anonymous?: boolean }).anonymous ? 1 : 0,
    ]),
  )
}

export async function tracklistFingerprint(parsed: Pick<ScrapedTracklist, 'rows'>): Promise<string> {
  const bytes = new TextEncoder().encode(fingerprintInput(parsed))
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** A fetch whose rows may count towards verification: rows present, not one of them contradicting itself. */
export function passesDecoyCheck(parsed: Parsed): boolean {
  return parsed.rows.length > 0 && !parsed.decoy.suspected && parsed.decoy.mismatched === 0
}

export async function getVerification(env: Env, setUrl: string): Promise<VerificationRow | null> {
  return dbOf(env).prepare('SELECT * FROM set_verification WHERE url = ?').bind(setUrl).first<VerificationRow>()
}

/** Whether the set's track list is verified (decision 2). False when unknown or on any read error. */
export async function isVerified(env: Env, setUrl: string): Promise<boolean> {
  try {
    const row = await dbOf(env).prepare('SELECT state FROM set_verification WHERE url = ?').bind(setUrl).first<{ state: string }>()
    return row?.state === 'verified'
  } catch {
    return false
  }
}

/** Accounts the next (verification) fetch of this set must avoid. */
export function excludeAccountsOf(row: Pick<VerificationRow, 'exclude_accounts'> | null): string[] {
  const a = parseJson<unknown>(row?.exclude_accounts ?? null, [])
  return Array.isArray(a) ? a.filter((x): x is string => typeof x === 'string').slice(0, 20) : []
}

export type VerificationOutcome =
  | 'no_account' // the fetch did not say which account served it: cannot count
  | 'decoy' // failed the decoy detector: account reported, state untouched
  | 'first' // first passing fetch recorded; second fetch scheduled
  | 'verified' // this fetch confirmed the pending one
  | 'still_pending' // same rows but same account or too soon: waits for a proper second fetch
  | 'mismatch' // the pair disagreed: first account reported, restarted from this fetch
  | 'changed' // a verified list changed (or a same-account refetch differed): restarted, nobody accused
  | 'unchanged' // verified, and this fetch agrees

export type VerificationResult = { outcome: VerificationOutcome; verified: boolean; reported: string | null }

type NoteInput = {
  setUrl: string
  parsed: Parsed
  /** Opaque tlpool account id that served this fetch. */
  accountId: string | null | undefined
  /** Unix seconds of the fetch. */
  fetchedAt: number
  settings: PoolSettings
  pool: PoolConfig | null
  log?: Logger
  random?: () => number
}

/**
 * Fold one successful set-page fetch into the set's verification state. Call
 * it for every fetch the sync makes (new, verify, recheck) before anything
 * reads `isVerified` for that set.
 */
export async function noteSetFetch(env: Env, input: NoteInput): Promise<VerificationResult> {
  const { setUrl, parsed, fetchedAt, settings, pool, log } = input
  const random = input.random ?? Math.random
  const account = input.accountId && input.accountId !== 'unknown' ? input.accountId : null
  const db = dbOf(env)
  const row = await getVerification(env, setUrl)
  const wasVerified = row?.state === 'verified'
  if (!account) {
    log?.warn('verify.no_account', { setUrl })
    return { outcome: 'no_account', verified: wasVerified, reported: null }
  }
  if (!passesDecoyCheck(parsed)) {
    if (parsed.decoy.suspected || parsed.decoy.mismatched > 0) {
      log?.error('verify.decoy_fetch', { setUrl, accountId: account, named: parsed.decoy.named, mismatched: parsed.decoy.mismatched })
      await poolRetestAccount(pool, account, 'decoy page', log)
      return { outcome: 'decoy', verified: wasVerified, reported: account }
    }
    // Zero rows: nothing to compare, nobody to blame.
    return { outcome: 'no_account', verified: wasVerified, reported: null }
  }
  const fingerprint = await tracklistFingerprint(parsed)
  const rowCount = parsed.rows.length
  const dueAt = fetchedAt + Math.round(settings.verify.minGapHours * 3600 + random() * settings.verify.jitterHours * 3600)

  const startOver = async (exclude: string[], mismatches: number) => {
    await db
      .prepare(
        `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at,
                                       second_account, second_fetched_at, verified_at, exclude_accounts, mismatches, updated_at)
         VALUES (?, 'pending', ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)
         ON CONFLICT(url) DO UPDATE SET
           state = 'pending', fingerprint = excluded.fingerprint, row_count = excluded.row_count,
           first_account = excluded.first_account, first_fetched_at = excluded.first_fetched_at,
           verify_due_at = excluded.verify_due_at, second_account = NULL, second_fetched_at = NULL,
           verified_at = NULL, exclude_accounts = excluded.exclude_accounts, mismatches = excluded.mismatches,
           updated_at = excluded.updated_at`,
      )
      .bind(setUrl, fingerprint, rowCount, account, fetchedAt, dueAt, JSON.stringify([...new Set(exclude)].slice(0, 20)), mismatches, fetchedAt)
      .run()
    // Not verified any more (or not yet): a list stored for mkvid must not
    // stay trusted (mkvid_request_tracks.trusted = 1 only for verified lists).
    await db
      .prepare('UPDATE mkvid_request_tracks SET trusted = 0 WHERE trusted = 1 AND request_id IN (SELECT id FROM mkvid_requests WHERE set_url = ?)')
      .bind(setUrl)
      .run()
  }

  if (!row) {
    await startOver([account], 0)
    log?.info('verify.first', { setUrl, accountId: account, rows: rowCount, verifyDueAt: dueAt })
    return { outcome: 'first', verified: false, reported: null }
  }

  if (row.state === 'verified') {
    if (row.fingerprint === fingerprint) return { outcome: 'unchanged', verified: true, reported: null }
    await startOver([account], row.mismatches)
    log?.warn('verify.changed_after_verified', { setUrl, accountId: account, rowsBefore: row.row_count, rowsNow: rowCount })
    return { outcome: 'changed', verified: false, reported: null }
  }

  // Pending: is this the confirming second fetch?
  const gapOk = fetchedAt - row.first_fetched_at >= settings.verify.minGapHours * 3600
  const otherAccount = account !== row.first_account
  if (row.fingerprint === fingerprint) {
    if (otherAccount && gapOk) {
      // Only over the pending row this fetch was compared with: a concurrent
      // fetch that restarted verification in between must not be overwritten.
      const upd = await db
        .prepare(
          `UPDATE set_verification SET state = 'verified', verify_due_at = NULL, second_account = ?, second_fetched_at = ?,
                  verified_at = ?, updated_at = ?
            WHERE url = ? AND state = 'pending' AND fingerprint = ? AND first_account = ? AND first_fetched_at = ?`,
        )
        .bind(account, fetchedAt, fetchedAt, fetchedAt, setUrl, row.fingerprint, row.first_account, row.first_fetched_at)
        .run()
      if ((upd.meta.changes ?? 0) === 0) {
        log?.warn('verify.lost_race', { setUrl, accountId: account })
        return { outcome: 'still_pending', verified: false, reported: null }
      }
      log?.info('verify.verified', { setUrl, firstAccount: row.first_account, secondAccount: account, gapSeconds: fetchedAt - row.first_fetched_at })
      return { outcome: 'verified', verified: true, reported: null }
    }
    log?.info('verify.still_pending', { setUrl, accountId: account, sameAccount: !otherAccount, gapOk })
    return { outcome: 'still_pending', verified: false, reported: null }
  }
  if (otherAccount) {
    // The pair disagrees. Which side is the decoy is unknown; the spec says the
    // first account is the one to report. Start over from this fetch and make
    // a third account confirm it.
    log?.error('verify.mismatch', { setUrl, firstAccount: row.first_account, secondAccount: account, rowsFirst: row.row_count, rowsSecond: rowCount })
    await poolRetestAccount(pool, row.first_account, 'verification mismatch', log)
    await startOver([account, row.first_account, ...excludeAccountsOf(row)], row.mismatches + 1)
    return { outcome: 'mismatch', verified: false, reported: row.first_account }
  }
  // Same account, different rows: the list was edited in between (or the
  // account turned). Restart from the newer rows without accusing anyone.
  await startOver([account], row.mismatches)
  log?.warn('verify.changed_same_account', { setUrl, accountId: account })
  return { outcome: 'changed', verified: false, reported: null }
}

/** Pending verifications whose second fetch is due, oldest first, with a DJ slug to run them under. */
export async function dueVerifications(env: Env, nowSec: number, limit: number): Promise<Array<{ url: string; slug: string; excludeAccounts: string[] }>> {
  const res = await dbOf(env)
    .prepare(
      `SELECT v.url AS url, MIN(t.slug) AS slug, v.exclude_accounts AS exclude_accounts
         FROM set_verification v JOIN tracklists t ON t.url = v.url AND t.processed = 1 AND t.abandoned = 0
                                  AND t.slug IN (SELECT slug FROM subscriptions)
        WHERE v.state = 'pending' AND v.verify_due_at IS NOT NULL AND v.verify_due_at <= ?
        GROUP BY v.url ORDER BY MIN(v.verify_due_at) LIMIT ?`,
    )
    .bind(nowSec, limit)
    .all<{ url: string; slug: string; exclude_accounts: string }>()
  return res.results.map((r) => ({ url: r.url, slug: r.slug, excludeAccounts: excludeAccountsOf(r) }))
}

/** Push a pending verification's next attempt back (the scheduler claims it before fetching, so a failure does not retry every tick). */
export async function deferVerification(env: Env, setUrl: string, untilSec: number): Promise<void> {
  await dbOf(env).prepare(`UPDATE set_verification SET verify_due_at = ? WHERE url = ? AND state = 'pending'`).bind(untilSec, setUrl).run()
}
