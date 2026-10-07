import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { fakeD1 } from './helpers/fake-d1'
import { fakeKV } from './helpers/fake-kv'
import type { Env } from '../src/types'
import { parseTracklist, type ScrapedTracklist } from '../src/lib/tracklists1001'
import { DEFAULT_POOL_SETTINGS } from '../src/lib/pool-settings'
import { dueVerifications, excludeAccountsOf, getVerification, isVerified, noteSetFetch, passesDecoyCheck, tracklistFingerprint } from '../src/lib/verification'
import { enqueueMkvidRequest, getMkvidRequestForSet, getMkvidTracks, saveMkvidTracks } from '../src/lib/mkvid'
import { saveSubState } from '../src/lib/sync-store'

const fx = (name: string) => readFileSync(resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', name), 'utf8')
const URL1 = 'https://www.1001tracklists.com/tracklist/1pqq0hst/matroda-2025-06-01.html'
const real = parseTracklist(URL1, fx('tracklist-matroda.html'))
const decoy = parseTracklist(URL1, fx('tracklist-decoy-dcr839.html'))
const T0 = 1_790_000_000
const H = 3600

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k' } as Env
}

/** A fake tlpool that records retest requests and answers /status with `status`. */
function retestRecorder(status: unknown = {}) {
  const retests: string[] = []
  const fetchImpl = (async (input: RequestInfo | URL) => {
    const m = String(input).match(/\/accounts\/([^/]+)\/retest$/)
    if (m) retests.push(decodeURIComponent(m[1]!))
    if (String(input).endsWith('/status')) return new Response(JSON.stringify(status), { status: 200 })
    return new Response('{}', { status: 200 })
  }) as unknown as typeof fetch
  return { retests, pool: { url: 'https://tlpool.example', token: 't', fetchImpl } }
}

const note = (env: Env, parsed: ScrapedTracklist, accountId: string, fetchedAt: number, pool: ReturnType<typeof retestRecorder>['pool'] | null = null) =>
  noteSetFetch(env, { setUrl: URL1, parsed, accountId, fetchedAt, settings: DEFAULT_POOL_SETTINGS, pool, random: () => 0.5 })

/** The same page with one row's title changed — what a decoy re-randomization or an edit looks like. */
function withTitle(p: ScrapedTracklist, i: number, title: string): ScrapedTracklist {
  return { ...p, rows: p.rows.map((r, k) => (k === i ? { ...r, title } : r)) }
}

describe('fingerprint (decision 2: same artist and title on every row, same count, cues, layering)', () => {
  it('is stable for the same rows and changes with a name, a cue or the layering', async () => {
    const a = await tracklistFingerprint(real)
    expect(await tracklistFingerprint(parseTracklist(URL1, fx('tracklist-matroda.html')))).toBe(a)
    expect(await tracklistFingerprint(withTitle(real, 3, 'Something Else'))).not.toBe(a)
    expect(await tracklistFingerprint({ rows: real.rows.map((r, k) => (k === 2 ? { ...r, startSeconds: (r.startSeconds ?? 0) + 1 } : r)) })).not.toBe(a)
    expect(await tracklistFingerprint({ rows: real.rows.map((r, k) => (k === 2 ? { ...r, isMashupLinked: !r.isMashupLinked } : r)) })).not.toBe(a)
    expect(await tracklistFingerprint({ rows: real.rows.slice(1) })).not.toBe(a)
    // Case and spacing do not matter (the decoy detector compares the same way).
    expect(await tracklistFingerprint(withTitle(real, 0, `  ${real.rows[0]!.title.toUpperCase()} `))).toBe(a)
  })

  it('the decoy fixture fails the decoy check; the real one passes', () => {
    expect(passesDecoyCheck(real)).toBe(true)
    expect(passesDecoyCheck(decoy)).toBe(false)
    expect(passesDecoyCheck({ rows: [], decoy: { named: 0, mismatched: 0, nearMismatched: 0, suspected: false } })).toBe(false)
  })
})

describe('noteSetFetch', () => {
  it('first passing fetch → pending with the second fetch due 2 h (+ jitter) later, excluding that account', async () => {
    const env = makeEnv()
    expect(await note(env, real, 'acct-1', T0)).toEqual({ outcome: 'first', verified: false, reported: null })
    const row = (await getVerification(env, URL1))!
    expect(row).toMatchObject({ state: 'pending', first_account: 'acct-1', first_fetched_at: T0, row_count: real.rows.length })
    expect(row.verify_due_at).toBe(T0 + 2 * H + 1 * H) // minGap 2 h + 0.5 × 2 h jitter
    expect(excludeAccountsOf(row)).toEqual(['acct-1'])
    expect(await isVerified(env, URL1)).toBe(false)
  })

  it('a second fetch by another account >= 2 h later with the same rows verifies', async () => {
    const env = makeEnv()
    await note(env, real, 'acct-1', T0)
    expect(await note(env, real, 'acct-2', T0 + 2 * H)).toEqual({ outcome: 'verified', verified: true, reported: null })
    expect(await isVerified(env, URL1)).toBe(true)
    expect(await getVerification(env, URL1)).toMatchObject({ state: 'verified', second_account: 'acct-2', verified_at: T0 + 2 * H, verify_due_at: null })
    // Later rechecks that agree change nothing.
    expect((await note(env, real, 'acct-3', T0 + 30 * H)).outcome).toBe('unchanged')
  })

  it('the same account, or less than 2 h, does not verify', async () => {
    const env = makeEnv()
    await note(env, real, 'acct-1', T0)
    expect((await note(env, real, 'acct-1', T0 + 5 * H)).outcome).toBe('still_pending')
    expect((await note(env, real, 'acct-2', T0 + 2 * H - 1)).outcome).toBe('still_pending')
    expect(await isVerified(env, URL1)).toBe(false)
    // An unknown account can never count.
    expect((await noteSetFetch(env, { setUrl: URL1, parsed: real, accountId: 'unknown', fetchedAt: T0 + 9 * H, settings: DEFAULT_POOL_SETTINGS, pool: null })).outcome).toBe('no_account')
  })

  it('a disagreeing pair reports the FIRST account to the pool and starts over from the second, excluding both', async () => {
    const env = makeEnv()
    const { retests, pool } = retestRecorder()
    await note(env, real, 'acct-1', T0, pool)
    const r = await note(env, withTitle(real, 5, 'Randomized Name'), 'acct-2', T0 + 3 * H, pool)
    expect(r).toEqual({ outcome: 'mismatch', verified: false, reported: 'acct-1' })
    expect(retests).toEqual(['acct-1'])
    const row = (await getVerification(env, URL1))!
    expect(row).toMatchObject({ state: 'pending', first_account: 'acct-2', first_fetched_at: T0 + 3 * H, mismatches: 1 })
    expect(excludeAccountsOf(row).sort()).toEqual(['acct-1', 'acct-2'])
    // A third account agreeing with the second verifies.
    expect((await note(env, withTitle(real, 5, 'Randomized Name'), 'acct-3', T0 + 6 * H, pool)).outcome).toBe('verified')
  })

  it('a disagreeing second fetch that carries a near-mismatch row starts over without reporting the first account', async () => {
    const env = makeEnv()
    const { retests, pool } = retestRecorder()
    await note(env, real, 'acct-1', T0, pool)
    const second = { ...withTitle(real, 5, 'Randomized Name'), decoy: { ...real.decoy, nearMismatched: 1 } }
    expect(passesDecoyCheck(second)).toBe(true)
    const r = await note(env, second, 'acct-2', T0 + 3 * H, pool)
    expect(r).toEqual({ outcome: 'mismatch', verified: false, reported: null })
    expect(retests).toEqual([])
    const row = (await getVerification(env, URL1))!
    expect(row).toMatchObject({ state: 'pending', first_account: 'acct-2', mismatches: 1 })
    expect(excludeAccountsOf(row).sort()).toEqual(['acct-1', 'acct-2'])
  })

  it('a verified list that changes later (users identify IDs) resets without accusing anyone', async () => {
    const env = makeEnv()
    const { retests, pool } = retestRecorder()
    await note(env, real, 'acct-1', T0, pool)
    await note(env, real, 'acct-2', T0 + 2 * H, pool)
    const r = await note(env, withTitle(real, 1, 'Now Identified'), 'acct-3', T0 + 48 * H, pool)
    expect(r).toEqual({ outcome: 'changed', verified: false, reported: null })
    expect(retests).toEqual([])
    expect(await isVerified(env, URL1)).toBe(false)
    expect(await getVerification(env, URL1)).toMatchObject({ state: 'pending', first_account: 'acct-3' })
  })

  it('a decoy page reports its account and leaves the state untouched', async () => {
    const env = makeEnv()
    const { retests, pool } = retestRecorder()
    await note(env, real, 'acct-1', T0, pool)
    await note(env, real, 'acct-2', T0 + 2 * H, pool)
    expect(await note(env, decoy, 'acct-4', T0 + 10 * H, pool)).toEqual({ outcome: 'decoy', verified: true, reported: 'acct-4' })
    expect(retests).toEqual(['acct-4'])
    expect(await isVerified(env, URL1)).toBe(true)
  })

  it('a page with a few far mismatches accuses nobody and verifies only when another account sees the same ones (2026-10-07)', async () => {
    const env = makeEnv()
    const { retests, pool } = retestRecorder()
    const quirk = (far: string) => ({ ...real, decoy: { ...real.decoy, mismatched: 1, suspected: false, far: [far] } })
    const tones = quirk('tones & i - dance monkey ⇄ tones and i - dance monkey')
    expect(passesDecoyCheck(tones)).toBe(false)
    expect(await note(env, tones, 'acct-1', T0, pool)).toEqual({ outcome: 'first', verified: false, reported: null })
    // The same quirk from another account: a site quirk, not a decoy.
    expect(await note(env, tones, 'acct-2', T0 + 2 * H, pool)).toEqual({ outcome: 'verified', verified: true, reported: null })
    expect(retests).toEqual([])
    // Another far pair (a decoy draws new names every fetch) never matches, and accuses nobody.
    const env2 = makeEnv()
    await note(env2, tones, 'acct-1', T0, pool)
    expect(await note(env2, quirk('x - y ⇄ x - z'), 'acct-2', T0 + 2 * H, pool)).toMatchObject({ outcome: 'mismatch', verified: false, reported: null })
    // Nor does the clean form of the list: the far pairs are part of what has to agree.
    const env3 = makeEnv()
    await note(env3, tones, 'acct-1', T0, pool)
    // The clean page is the evidence here, so the first account is reported, as for any pair that disagrees.
    expect(await note(env3, real, 'acct-2', T0 + 2 * H, pool)).toMatchObject({ outcome: 'mismatch', reported: 'acct-1' })
  })

  it('a clean page keeps its fingerprint (rows only); far pairs change it', async () => {
    const { tracklistFingerprint } = await import('../src/lib/verification')
    const clean = await tracklistFingerprint(real)
    expect(await tracklistFingerprint({ ...real, decoy: { ...real.decoy, far: [] } })).toBe(clean)
    expect(await tracklistFingerprint({ ...real, decoy: { ...real.decoy, far: ['a ⇄ b'] } })).not.toBe(clean)
  })

  it('reports nobody while more than half of the non-passive pool rests', async () => {
    const acct = (id: string, state: string, passive = false) => ({ id, state, passive })
    const busyPool = { accounts: [acct('a1', 'resting'), acct('a2', 'resting'), acct('a3', 'resting'), acct('a4', 'active'), acct('a5', 'warming'), acct('p1', 'resting', true), acct('p2', 'resting', true), acct('r1', 'retired'), acct('n1', 'new')] }
    const env = makeEnv()
    const { retests, pool } = retestRecorder(busyPool)
    expect(await note(env, decoy, 'acct-4', T0, pool)).toEqual({ outcome: 'decoy', verified: false, reported: null })
    expect(retests).toEqual([])
    // Exactly half resting (passive, retired and new accounts do not count) still reports.
    const half = retestRecorder({ accounts: [acct('a1', 'resting'), acct('a2', 'resting'), acct('a3', 'active'), acct('a4', 'active'), acct('p1', 'resting', true)] })
    expect((await note(makeEnv(), decoy, 'acct-4', T0, half.pool)).reported).toBe('acct-4')
    expect(half.retests).toEqual(['acct-4'])
  })

  it('sends at most reports.maxPerDay reports per UTC day of the fetch', async () => {
    const env = makeEnv()
    const { retests, pool } = retestRecorder()
    const settings = { ...DEFAULT_POOL_SETTINGS, reports: { maxPerDay: 1, maxRestingShare: 0.5 } }
    const send = (accountId: string, fetchedAt: number) => noteSetFetch(env, { setUrl: URL1, parsed: decoy, accountId, fetchedAt, settings, pool })
    expect((await send('acct-1', T0)).reported).toBe('acct-1')
    expect((await send('acct-2', T0 + 60)).reported).toBeNull()
    expect((await send('acct-3', T0 + 24 * H)).reported).toBe('acct-3')
    expect(retests).toEqual(['acct-1', 'acct-3'])
    // 0 = never report.
    const never = retestRecorder()
    const off = { ...DEFAULT_POOL_SETTINGS, reports: { maxPerDay: 0, maxRestingShare: 0.5 } }
    expect((await noteSetFetch(makeEnv(), { setUrl: URL1, parsed: decoy, accountId: 'acct-1', fetchedAt: T0, settings: off, pool: never.pool })).reported).toBeNull()
    expect(never.retests).toEqual([])
  })

  it('losing verification downgrades a stored mkvid list (trusted = 1 only while verified)', async () => {
    const env = makeEnv()
    await enqueueMkvidRequest(env, { slug: 's', setUrl: URL1, artistName: 'M', setTitle: null, setDate: null, source: { kind: 'soundcloud', url: 'https://api.soundcloud.com/tracks/1' }, lastCueSeconds: null, trackCount: 1, idedCount: 1 })
    const id = (await getMkvidRequestForSet(env, URL1))!.id
    await note(env, real, 'acct-1', T0)
    await note(env, real, 'acct-2', T0 + 2 * H)
    await saveMkvidTracks(env, URL1, real)
    expect((await getMkvidTracks(env, id)).tracksTrusted).toBe(true)
    await note(env, withTitle(real, 1, 'Edited'), 'acct-3', T0 + 50 * H)
    expect((await getMkvidTracks(env, id)).tracksTrusted).toBe(false)
  })
})

describe('dueVerifications', () => {
  it('lists pending sets whose second fetch is due, with a DJ to run them under and the accounts to avoid', async () => {
    const env = makeEnv()
    await env.DB.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, 0, 0)').bind('dj', 'https://www.1001tracklists.com/dj/dj/').run()
    await saveSubState(env, 'dj', { discoveredTracklistUrls: [URL1], processedTracklistUrls: [URL1], tracklistVideos: { [URL1]: { videoId: null, checkedAt: T0 } } })
    await note(env, real, 'acct-1', T0)
    expect(await dueVerifications(env, T0 + H, 10)).toEqual([])
    expect(await dueVerifications(env, T0 + 3 * H, 10)).toEqual([{ url: URL1, slug: 'dj', excludeAccounts: ['acct-1'] }])
    await note(env, real, 'acct-2', T0 + 3 * H)
    expect(await dueVerifications(env, T0 + 9 * H, 10)).toEqual([])
  })
})
