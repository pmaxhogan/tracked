# tracked UI phase 2 (Activity log, Set diagnostics) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the unified Activity log (`/ui/activity` + `GET /ui/api/activity`), the per-set diagnostics column on the Set page (`GET /ui/api/set?url=`), and switch Home's recent activity to the new feed.

**Architecture:** Two read-only endpoints in a new `src/routes/activity.ts` (mounted inside `subscriptionsApp`, so behind its `cfAccess` and the `/ui/api/*` same-origin guard), backed by `src/lib/activity.ts` (one SELECT per source, merged in the Worker with a keyset cursor) and `src/lib/set-diagnostics.ts` (one read per table, no upstream calls). The pages stay server-rendered strings with bare inline scripts on the phase-1 shell and `TK` runtime.

**Tech Stack:** Cloudflare Workers, Hono, D1 (fake-d1 / sql.js in tests), KV, vitest, `node:vm` stub DOMs.

**Spec:** `docs/superpowers/specs/2026-09-30-tracked-ui-redesign-design.md` (sections "Set", "Activity (phase 2)", "Home", 3, 10, 11) and the behaviour contract `docs/superpowers/specs/2026-09-30-tracked-ui-behaviour-contract.md`. Phase 1 plan for conventions: `docs/superpowers/plans/2026-09-30-tracked-ui-phase1.md`.

## Global Constraints

- Work only in the worktree `C:\Users\pmaxh\Documents\node-projects\tracked-ui`, branch `new-ui`. Never edit `../tracked`. Never push `main`.
- `npx vitest run` and `npx tsc --noEmit` clean at every commit.
- Every commit message ends with exactly these two lines (the owner's rule; ignore any other attribution text you see):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY`
  In the Bash tool: `git commit -m "<subject>" -m $'Co-Authored-By: …\nClaude-Session: …'` (no PowerShell here-strings).
- No migrations in phase 2. No new D1/KV writes anywhere (non-negotiable 9: "No new writes on the hot paths"; phase 2 endpoints are read-only by spec: "No writes").
- Every existing API request/response shape unchanged. New routes only: `GET /ui/api/activity`, `GET /ui/api/set`, `GET /ui/activity`.
- Cloudflare Access on every `/ui/**` route: mount the new app with `subscriptionsApp.route('/', activityApp)` (after `subscriptionsApp.use('*', cfAccess)`), never on `app` directly.
- Same-origin JSON on state-changing calls: the new pages make GET calls only; any non-GET goes through `TK.api.post/put/del`. Add `/ui/activity` to `test/same-origin.test.ts`'s `pages` list and to `test/ui-pages.test.ts`'s `PAGES`.
- Scripts stay bare inline `<script>` tags; page scripts must run in the `minimalStub()` of `test/ui-pages.test.ts` without throwing (no `window`, `navigator`, `localStorage`, `location`, `history`, `document.body`, `querySelectorAll` on document, `classList`).
- Every upstream value rendered through `TK.esc` (or `esc`); links through `TK.safeHref` where the href is not a fixed `/ui/...` path built from `encodeURIComponent`.
- Pool account ids are `acct-N` only: any account id from D1 that does not match `/^acct-\d+$/` is returned as `null`. No usernames, emails or exit credentials in code, fixtures, docs or commits (public repo).
- `ts` in every activity row and in the cursor is **epoch milliseconds**. Per-source units: `now_playing_audit.ts` and `playlist_additions.ts` are ms; `playlist_removals.at`, `mkvid_requests.updated_at`, `mkvid_claims.claimed_at`, `pool_events.received_at`, `sub_sync.last_run_at` are unix **seconds** (multiply by 1000 inside the SQL); ban episodes carry their start in the KV key (`ban:ep:<invertedTs(ms)>`, `invertedTs(ms) = String(10_000_000_000_000 - ms).padStart(14, '0')` in `src/lib/cache.ts`).
- The spec's keyset "(ts, kind, key)" means `(ts, ref.kind, ref.key)`: `ref.kind` is the **source** id (`audit`, `addition`, `removal`, `mkvid`, `claim`, `pool`, `sync`, `ban`), unique per SELECT; the display `kind` (`request`, `playlist`, `hygiene`, `mkvid`, `pool`, `sync`, `ban`) is not unique (`mkvid` has two sources).
- There is no mkvid transitions log and no sync history: the `mkvid` source is "each request's current status at `updated_at`" and `sync` is "each DJ's last run". Do not add tables to change that.
- Set diagnostics never calls YouTube, tlpool or 1001tracklists: `readCachedVideoMeta` (not `getVideoMeta`), `loadSetFacts`, `judgeVideo`, `rejectVerticalEnabled`, `isOverridden`, `readinessFor`, plain SELECTs.
- Malformed query parameters are a `400 { error: 'invalid_request', message }`, never a 500 or a silently empty page (the `mkvidQuery` stance in `src/routes/subscriptions.ts`).
- SDD ledger: `.superpowers/sdd/2026-10-01-tracked-ui-phase2/` (gitignored).

## Review Focus

1. Paging across sources with equal `ts` at a page boundary: rows from two sources share a millisecond and the page ends between them. Expect "Load older" to return each row exactly once, none skipped, none repeated. (Task 1, test "pages a mixed feed with ts ties exactly once".)
2. Unit mixing: a `playlist_removals` row at `at = 1000` (s) and an audit row at `ts = 999_999` (ms). Expect the removal (1_000_000 ms) to sort first. (Task 1, test "orders seconds and milliseconds sources on one clock".)
3. `dj=` combined with `problems=1`: sources without a DJ (requests, pool, ban) return nothing; DJ sources return only that DJ's problem rows. (Task 1, test "dj filter drops the DJ-less sources".)
4. A set whose mkvid request is `done`, or that has none: `position` is `null`, never `0`. A b2b set listed under two DJs shows both. (Task 2, tests "position is null unless pending" and "lists every DJ that discovered the set".)
5. A pasted URL in a non-canonical form (no scheme, `?query`, no `www`) gets the same diagnostics as the canonical one, and the column still renders when the track-list fetch fails (IP block). (Task 2 test "normalizes the URL"; Task 4 test "diagnostics render when the track list fails".)

---

### Task 1: Activity feed library and `GET /ui/api/activity`

**Files:**
- Create: `src/lib/activity.ts`
- Create: `src/routes/activity.ts`
- Modify: `src/routes/subscriptions.ts` (one import + one `subscriptionsApp.route('/', activityApp)` line right after the `hygieneApp` mount, near line 99)
- Test: `test/activity.test.ts`

**Interfaces:**
- Consumes: `dbOf` (whatever `src/lib/now-playing-audit.ts` imports it from), `parseJson`, `invertedTs` semantics, `listEpisodes`-style KV access (`env.CACHE.list({ prefix: 'ban:ep:', limit })`, `env.CACHE.get(key, 'json')`), `REASON_LABELS` from `src/lib/playlist-hygiene.ts`, `parseDjSlug` from `src/lib/subscriptions.ts` (check its signature; it returns the slug or null).
- Produces (later tasks rely on these exact names):
  - `export const ACTIVITY_KINDS = ['request', 'playlist', 'hygiene', 'mkvid', 'pool', 'sync', 'ban'] as const`
  - `export type ActivityKind = (typeof ACTIVITY_KINDS)[number]`
  - `export const ACTIVITY_SOURCES = ['audit', 'addition', 'removal', 'mkvid', 'claim', 'pool', 'sync', 'ban'] as const`
  - `export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]`
  - `export type ActivityRow = { ts: number; kind: ActivityKind; status: string; problem: boolean; title: string; detail: string | null; dj: string | null; setUrl: string | null; videoId: string | null; ref: { kind: ActivitySource; key: string } }`
  - `export type ActivityQuery = { kinds: ActivityKind[]; problems: boolean; dj: string | null; since: number | null; cursor: ActivityCursor | null; limit: number }`
  - `export type ActivityCursor = { ts: number; src: ActivitySource; key: string }`
  - `export function parseActivityQuery(params: URLSearchParams): ActivityQuery | { error: string }`
  - `export function encodeActivityCursor(c: ActivityCursor): string` / `export function decodeActivityCursor(s: string): ActivityCursor | null`
  - `export async function listActivity(env: Env, q: ActivityQuery): Promise<{ rows: ActivityRow[]; cursor: string | null }>`
  - `export function labelFromSetUrl(url: string | null): string` (server twin of `setLabel` in `src/ui/runtime.ts`)
  - Route: `GET /ui/api/activity?kind=a,b&problems=1&dj=&since=&cursor=&limit=` returns `{ rows: ActivityRow[], cursor: string | null }`.

**Ordering and keyset (write this as the file's header comment):** rows sort by `ts` DESC, then by source rank ASC (index in `ACTIVITY_SOURCES`), then by key DESC. Keys of `audit`, `addition`, `removal`, `claim`, `pool` are integer row ids compared numerically; keys of `mkvid` (request uuid), `sync` (slug) and `ban` (KV key) compare as strings. A row is "after" cursor `(cts, csrc, ckey)` when `ts < cts`, or `ts = cts` and (its rank > rank(csrc), or same source and key < ckey). Each source turns that into SQL: rank(S) > rank(csrc) → `T <= cts`; S = csrc → `(T < cts OR (T = cts AND K < ckey))`; rank(S) < rank(csrc) → `T < cts`, where `T` is the source's ms expression and `K` its key column. Each source SELECTs `limit + 1` rows ordered `T DESC, K DESC`; the Worker concatenates, sorts with the same comparator, keeps `limit`, and returns a cursor of the last kept row when more than `limit` rows came back in total.

**Sources** (display kind / ms expression / key / problem / dj column):

| src | kind | table | T (ms) | key | status | problem when | dj |
| --- | --- | --- | --- | --- | --- | --- | --- |
| audit | request | now_playing_audit | `ts` | `id` | `status` | `status IN ('no_video','no_tracklist','upstream_error') OR json_extract(summary,'$.impossible') = 1` | none |
| addition | playlist | playlist_additions | `ts` | `id` | `status` | `status IN ('failed','abandoned')` | `slug` |
| removal | hygiene | playlist_removals | `at * 1000` | `id` | `status` | `status = 'failed'` | `slug` |
| mkvid | mkvid | mkvid_requests (`status IN ('done','failed','banned','superseded')`) | `updated_at * 1000` | `id` | `status` | `status IN ('failed','banned')` | `slug` |
| claim | mkvid | mkvid_claims c LEFT JOIN mkvid_requests r ON r.id = c.request_id | `c.claimed_at * 1000` | `c.id` | `refunded` if `c.refunded_at` not null else `claimed` | never | `r.slug` |
| pool | pool | pool_events | `received_at * 1000` | `id` | `type` | `type IN ('account.flagged','account.retired','challenge.expired') OR push_status = 'failed'` | none |
| sync | sync | sub_sync (`last_run_at IS NOT NULL`) | `last_run_at * 1000` | `slug` | `error` if `last_error` else `ok` | `last_error IS NOT NULL` | `slug` |
| ban | ban | KV `ban:ep:*` (first 100 keys, newest first) | from the key | the KV key | `open` if `endedAt` null else `ended` | `!simulated` | none |

When `dj` is set, sources with no dj column are skipped. When `problems` is set, the problem condition is added to the WHERE (ban/sync: filtered in the Worker). `since` (ms) adds `T >= since`. Kinds not in `q.kinds` are skipped.

Titles and details (server-side, plain text; the page escapes):
- audit: title `summary.title || '(no title)'`; detail joins with ` · `: `clock(cs)` + (`dur` ? ` / clock(dur)` : ''), `via <via>` when present, `position past end of video` when `impossible`, `Δ<clock(skew)> from track start` when `|skew| > 600`. `clock(s)` = `m:ss` or `h:mm:ss`, `?` for null.
- addition: title `labelFromSetUrl(set_url)`; detail `summary.msg`, else `video <video_id>` when present, else null; plus ` · combined <cmb>` when `summary.cmb` is `failed` or `unavailable`. `setUrl` = `set_url`, `videoId` = `video_id`.
- removal: title `${SOURCE_LABEL[source]}: ${REASON_LABELS[reason] ?? reason}` with `SOURCE_LABEL = { sweep: 'Sweep', owner: 'Removed by owner', dead: 'Video died', button: 'Remove and replace' }`; detail `detail` (≤ 200 chars) plus ` · ${playlist_kind} playlist`.
- mkvid: title `set_title || labelFromSetUrl(set_url)`; detail by status: done `uploaded <video_id>`, failed `error`, banned `banned from mkvid`, superseded `superseded by an official recording`.
- claim: title `(recreate ? 'Recreate claimed: ' : 'Claimed for render: ') + (r.set_title || labelFromSetUrl(r.set_url))`; detail `${account} account` + (refunded ? ' · given back (failed before upload)' : '').
- pool: title from `POOL_TITLES = { 'challenge.created': 'Challenge opened', 'challenge.solved': 'Challenge solved', 'challenge.expired': 'Challenge expired', 'account.flagged': 'Account flagged', 'account.created': 'Account created', 'account.retired': 'Account retired', 'account.rested': 'Account rested' }` (fallback: the type); detail joins `account_id` (only if `/^acct-\d+$/`), `challenge <challenge_id>` when present, `payload.reason` when a string, `push <push_status>` when `push_status` is `failed` or `not_configured`.
- sync: title `Sync: ${artist_name || slug}`; detail `last_error` (≤ 200 chars) or null.
- ban: title `simulated ? 'Simulated IP block' : 'IP block'`; detail joins `blocked <duration>` when `blockedForMs` (format `Xh Ym` / `Ym`), `cleared by <clearedBy>` when set, `ongoing` when `endedAt` is null.

- [ ] **Step 1: Write the failing tests** in `test/activity.test.ts`. Use the `makeEnv()` / `get()` helpers from `test/audit-routes.test.ts` (copy them). Seed with direct `env.DB.prepare(...).bind(...).run()` inserts so every source's columns are explicit. Tests (each an `it`):

```ts
import { describe, it, expect } from 'vitest'
import { app } from '../src/index'
import type { Env } from '../src/types'
import { fakeKV } from './helpers/fake-kv'
import { fakeD1 } from './helpers/fake-d1'
import { parseActivityQuery, encodeActivityCursor, decodeActivityCursor, labelFromSetUrl } from '../src/lib/activity'

function makeEnv(): Env {
  return { CACHE: fakeKV(), DB: fakeD1(), SUBS: fakeKV(), API_TOKEN: 't', YOUTUBE_API_KEY: 'k', DEV_BYPASS_CF_ACCESS: '1' } as Env
}
const get = (env: Env, path: string) => app.request(`http://x${path}`, { method: 'GET' }, env)
type Page = { rows: Array<{ ts: number; kind: string; status: string; problem: boolean; title: string; detail: string | null; dj: string | null; setUrl: string | null; ref: { kind: string; key: string } }>; cursor: string | null }
const SET = 'https://www.1001tracklists.com/tracklist/abc123/dj-one-live-at-somewhere-2026-09-01.html'

async function audit(env: Env, id: number, tsMs: number, status = 'ok', extra: Record<string, unknown> = {}) {
  const summary = { t: new Date(tsMs).toISOString(), status, title: `req ${id}`, cs: 61, dur: 3600, via: 'search', skew: null, impossible: false, ms: 1, ...extra }
  await env.DB.prepare('INSERT INTO now_playing_audit (id, t, ts, req_id, status, summary, record) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .bind(id, summary.t, tsMs, `r${id}`, status, JSON.stringify(summary), JSON.stringify({ t: summary.t, status })).run()
}
async function addition(env: Env, id: number, tsMs: number, status = 'added', slug = 'dj-one') {
  const summary = { t: new Date(tsMs).toISOString(), status, slug, artist: 'DJ One', set: SET, vid: 'vid00000001', via: 'pool', trg: 'test', msg: null, ms: 1, cmb: 'added' }
  await env.DB.prepare('INSERT INTO playlist_additions (id, t, ts, status, slug, set_url, video_id, summary, record) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, summary.t, tsMs, status, slug, SET, 'vid00000001', JSON.stringify(summary), '{}').run()
}
async function removal(env: Env, id: number, atSec: number, status = 'removed') {
  await env.DB.prepare("INSERT INTO playlist_removals (id, at, source, status, slug, set_url, video_id, playlist_id, playlist_kind, reason, detail) VALUES (?, ?, 'sweep', ?, 'dj-one', ?, ?, 'PL1', 'artist', 'short', 'video 10:00 < last cue 60:00 - 5:00')")
    .bind(id, atSec, status, SET, `vid${id}`).run()
}
```

  - `parses and rejects query parameters`: `parseActivityQuery(new URLSearchParams(''))` → `{ kinds: [...ACTIVITY_KINDS], problems: false, dj: null, since: null, cursor: null, limit: 50 }`; `kind=request,ban&problems=1&limit=500` → kinds `['request','ban']`, problems true, limit `100` (clamped); each of `kind=nope`, `limit=abc`, `since=-5`, `since=1e9`, `cursor=garbage`, `dj=Bad Slug!` → an object with `error`. And `GET /ui/api/activity?kind=nope` → 400 with `error: 'invalid_request'`.
  - `round-trips the cursor`: `decodeActivityCursor(encodeActivityCursor({ ts: 5, src: 'sync', key: 'dj-one' }))` deep-equals the input; `decodeActivityCursor('5|audit|x')` → null (numeric source, non-numeric key); `decodeActivityCursor('5|nope|1')` → null.
  - `labels a set URL like the client does`: `labelFromSetUrl(SET)` → `'dj one live at somewhere 2026 09 01'`; `labelFromSetUrl(null)` → `'(unknown set)'`; `labelFromSetUrl('not a url')` → `'not a url'`.
  - `orders seconds and milliseconds sources on one clock`: `audit(env, 1, 999_999)`, `removal(env, 1, 1000)` → rows `[removal (ts 1_000_000), audit (ts 999_999)]` by `ref.kind`.
  - `pages a mixed feed with ts ties exactly once`: five rows all at `ts = 2_000_000` ms: audits id 1 and 2 (`ts 2_000_000`), additions id 1 and 2 (`ts 2_000_000`), removal id 1 (`at 2000`). Walk with `limit=2` following `cursor` until null; collect `ref.kind + ':' + ref.key`. Expect exactly `['audit:2','audit:1','addition:2','addition:1','removal:1']` (rank order: audit < addition < removal; keys DESC) and three pages.
  - `marks problems and filters to them`: audit 1 `ok`, audit 2 `no_video`, audit 3 `ok` with `impossible: true`, addition 1 `failed`, addition 2 `added`. `?problems=1` returns refs `audit:3, audit:2, addition:1` in ts order you seed (seed ts so that is the order) and every row has `problem: true`; the `impossible` row's `detail` contains `position past end of video`.
  - `dj filter drops the DJ-less sources`: audit 1, addition 1 (`dj-one`), addition 2 (slug `dj-two`), a pool event, a ban episode. `?dj=dj-one` → only `addition:1`. `?dj=dj-one&problems=1` → `[]` (addition 1 is `added`).
  - `reads every source`: seed one row of each source (mkvid request `done` with `video_id`, a claim joined to it with `account 'shared'`, `refunded_at` set; pool event `account.flagged` with `account_id 'acct-3'` and payload `{"reason":"captcha loop"}`; a second pool event with `account_id 'someone@example.com'`; sub_sync row with `last_error 'boom'`; ban episode written as `env.CACHE.put('ban:ep:' + String(10_000_000_000_000 - tsMs).padStart(14, '0'), JSON.stringify({ key, startedAt, endedAt: null, blockedForMs: null, simulated: false, clearedBy: null, ... }))`). Assert per `ref.kind`: kinds map as in the table; claim `status === 'refunded'` and `detail` contains `shared account`; the flagged pool row `problem === true` and `detail` contains `acct-3` and `captcha loop`; the second pool row's `detail` does not contain `@`; sync `status === 'error'`, `problem === true`, `detail === 'boom'`; ban `status === 'open'`, `problem === true`, `ts` equals the seeded ms.
  - `since cuts every source`: rows at 1_000 ms and 5_000_000 ms across audit and removal; `?since=2000000` returns only the newer ones.
  - `never writes`: wrap `env.DB.prepare` to record SQL; after a full `GET /ui/api/activity`, no recorded statement matches `/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i`; wrap `env.CACHE.put` and `delete` to throw.

- [ ] **Step 2: Run them to see them fail**

Run: `npx vitest run test/activity.test.ts`
Expected: FAIL (cannot resolve `../src/lib/activity`).

- [ ] **Step 3: Implement `src/lib/activity.ts`.** Skeleton with the parts every source shares; write the eight source functions from the table above in the same shape as `auditSource`:

```ts
// Unified activity log (spec "Activity (phase 2)"): one SELECT per source,
// merged in the Worker. <the Ordering and keyset paragraph above, verbatim>
// Read-only: nothing here writes D1 or KV.
import type { Env } from '../types'
import { dbOf, parseJson } from './db'           // use the same import path now-playing-audit.ts uses
import { REASON_LABELS } from './playlist-hygiene'

export const ACTIVITY_KINDS = ['request', 'playlist', 'hygiene', 'mkvid', 'pool', 'sync', 'ban'] as const
export type ActivityKind = (typeof ACTIVITY_KINDS)[number]
export const ACTIVITY_SOURCES = ['audit', 'addition', 'removal', 'mkvid', 'claim', 'pool', 'sync', 'ban'] as const
export type ActivitySource = (typeof ACTIVITY_SOURCES)[number]
export type ActivityRow = { ts: number; kind: ActivityKind; status: string; problem: boolean; title: string; detail: string | null; dj: string | null; setUrl: string | null; videoId: string | null; ref: { kind: ActivitySource; key: string } }
export type ActivityCursor = { ts: number; src: ActivitySource; key: string }
export type ActivityQuery = { kinds: ActivityKind[]; problems: boolean; dj: string | null; since: number | null; cursor: ActivityCursor | null; limit: number }

const NUMERIC_KEYS: ReadonlySet<ActivitySource> = new Set(['audit', 'addition', 'removal', 'claim', 'pool'])
const rank = (s: ActivitySource) => ACTIVITY_SOURCES.indexOf(s)
const DEFAULT_LIMIT = 50
const MAX_LIMIT = 100
const SLUG_RE = /^[a-z0-9][a-z0-9._-]{0,99}$/i
const ACCT_RE = /^acct-\d+$/

export function encodeActivityCursor(c: ActivityCursor): string {
  return `${c.ts}|${c.src}|${c.key}`
}

export function decodeActivityCursor(s: string): ActivityCursor | null {
  const m = /^(\d{1,15})\|([a-z]+)\|(.{1,200})$/.exec(s)
  if (!m) return null
  const src = m[2] as ActivitySource
  if (!ACTIVITY_SOURCES.includes(src)) return null
  if (NUMERIC_KEYS.has(src) && !/^\d+$/.test(m[3]!)) return null
  return { ts: Number(m[1]), src, key: m[3]! }
}

export function parseActivityQuery(p: URLSearchParams): ActivityQuery | { error: string } {
  const kindsRaw = (p.get('kind') || '').split(',').map((k) => k.trim()).filter(Boolean)
  for (const k of kindsRaw) if (!ACTIVITY_KINDS.includes(k as ActivityKind)) return { error: `unknown kind: ${k}` }
  const dj = p.get('dj') || null
  if (dj && !SLUG_RE.test(dj)) return { error: 'bad dj' }
  const sinceRaw = p.get('since')
  if (sinceRaw && !/^\d{1,15}$/.test(sinceRaw)) return { error: 'bad since' }
  const limitRaw = p.get('limit')
  if (limitRaw && !/^\d{1,6}$/.test(limitRaw)) return { error: 'bad limit' }
  const cursorRaw = p.get('cursor')
  const cursor = cursorRaw ? decodeActivityCursor(cursorRaw) : null
  if (cursorRaw && !cursor) return { error: 'bad cursor' }
  return {
    kinds: kindsRaw.length ? (kindsRaw as ActivityKind[]) : [...ACTIVITY_KINDS],
    problems: p.get('problems') === '1',
    dj,
    since: sinceRaw ? Number(sinceRaw) : null,
    cursor,
    limit: Math.min(Math.max(limitRaw ? Number(limitRaw) : DEFAULT_LIMIT, 1), MAX_LIMIT),
  }
}

/** Server twin of setLabel in src/ui/runtime.ts. */
export function labelFromSetUrl(u: string | null): string {
  if (!u) return '(unknown set)'
  try {
    const seg = new URL(u).pathname.split('/').filter(Boolean).pop() || ''
    const name = seg.replace(/\.html?$/i, '').replace(/[-_]+/g, ' ').trim()
    return name || u
  } catch {
    return u
  }
}

/** The keyset WHERE for one source, given its ms expression and key column. */
function keyset(src: ActivitySource, T: string, K: string, c: ActivityCursor | null): { sql: string; binds: (string | number)[] } {
  if (!c) return { sql: '1 = 1', binds: [] }
  const key: string | number = NUMERIC_KEYS.has(src) ? Number(c.key) : c.key
  if (rank(src) > rank(c.src)) return { sql: `${T} <= ?`, binds: [c.ts] }
  if (rank(src) < rank(c.src)) return { sql: `${T} < ?`, binds: [c.ts] }
  return { sql: `(${T} < ? OR (${T} = ? AND ${K} < ?))`, binds: [c.ts, c.ts, key] }
}

function compare(a: ActivityRow, b: ActivityRow): number {
  if (a.ts !== b.ts) return b.ts - a.ts
  const r = rank(a.ref.kind) - rank(b.ref.kind)
  if (r !== 0) return r
  if (NUMERIC_KEYS.has(a.ref.kind)) return Number(b.ref.key) - Number(a.ref.key)
  return a.ref.key < b.ref.key ? 1 : a.ref.key > b.ref.key ? -1 : 0
}

type Where = { parts: string[]; binds: (string | number)[] }
function where(q: ActivityQuery, src: ActivitySource, T: string, K: string, problemSql: string | null, djCol: string | null): Where {
  const ks = keyset(src, T, K, q.cursor)
  const w: Where = { parts: [ks.sql], binds: [...ks.binds] }
  if (q.since != null) { w.parts.push(`${T} >= ?`); w.binds.push(q.since) }
  if (q.problems && problemSql) w.parts.push(`(${problemSql})`)
  if (q.dj && djCol) { w.parts.push(`${djCol} = ?`); w.binds.push(q.dj) }
  return w
}

async function auditSource(env: Env, q: ActivityQuery): Promise<ActivityRow[]> {
  if (q.dj) return []
  const problemSql = "status IN ('no_video','no_tracklist','upstream_error') OR json_extract(summary, '$.impossible') = 1"
  const w = where(q, 'audit', 'ts', 'id', problemSql, null)
  const res = await dbOf(env)
    .prepare(`SELECT id, ts, status, summary FROM now_playing_audit WHERE ${w.parts.join(' AND ')} ORDER BY ts DESC, id DESC LIMIT ?`)
    .bind(...w.binds, q.limit + 1)
    .all<{ id: number; ts: number; status: string; summary: string }>()
  return res.results.map((r) => {
    const s = parseJson<Record<string, unknown>>(r.summary, {})
    const impossible = s.impossible === true
    return {
      ts: Number(r.ts), kind: 'request', status: r.status,
      problem: ['no_video', 'no_tracklist', 'upstream_error'].includes(r.status) || impossible,
      title: typeof s.title === 'string' && s.title ? s.title : '(no title)',
      detail: auditDetail(s), dj: null, setUrl: null, videoId: null,
      ref: { kind: 'audit', key: String(r.id) },
    }
  })
}
// …additionSource, removalSource, mkvidSource, claimSource, poolSource, syncSource, banSource per the table…

const SOURCES: Array<{ src: ActivitySource; kind: ActivityKind; run: (env: Env, q: ActivityQuery) => Promise<ActivityRow[]> }> = [
  { src: 'audit', kind: 'request', run: auditSource },
  // … one entry per source, in ACTIVITY_SOURCES order
]

export async function listActivity(env: Env, q: ActivityQuery): Promise<{ rows: ActivityRow[]; cursor: string | null }> {
  const parts = await Promise.all(SOURCES.filter((s) => q.kinds.includes(s.kind)).map((s) => s.run(env, q)))
  const all = parts.flat().sort(compare)
  const rows = all.slice(0, q.limit)
  const last = rows[rows.length - 1]
  return { rows, cursor: all.length > q.limit && last ? encodeActivityCursor({ ts: last.ts, src: last.ref.kind, key: last.ref.key }) : null }
}
```

  `banSource`: `if (q.dj) return []`; `const page = await env.CACHE.list({ prefix: 'ban:ep:', limit: 100 })`; for each key compute `ts = 10_000_000_000_000 - Number(key.slice(7))`; drop keys that fail `since` or are not "after" the cursor (apply the same rule as `compare`, string keys) **before** any `get`; take the first `q.limit + 1` survivors, `get(key, 'json')` each, drop nulls, map, then apply `problems`. `syncSource` applies `problems` in SQL (`last_error IS NOT NULL`). `poolSource` never puts a non-`acct-N` `account_id` into `detail`.

- [ ] **Step 4: Implement `src/routes/activity.ts` and mount it**

```ts
// Read-only Activity and Set diagnostics endpoints (spec "Activity (phase 2)",
// "Set"). Mounted inside subscriptionsApp, so behind its cfAccess gate and the
// /ui/api/* same-origin guard.
import { Hono } from 'hono'
import type { Env } from '../types'
import { listActivity, parseActivityQuery } from '../lib/activity'

export const activityApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

activityApp.get('/api/activity', async (c) => {
  const q = parseActivityQuery(new URL(c.req.url).searchParams)
  if ('error' in q) return c.json({ error: 'invalid_request', message: q.error }, 400)
  return c.json(await listActivity(c.env, q))
})
```

  In `src/routes/subscriptions.ts`, after `subscriptionsApp.route('/', hygieneApp)`: `// Activity log + set diagnostics (routes/activity.ts). Behind cfAccess above.` then `subscriptionsApp.route('/', activityApp)`.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run test/activity.test.ts test/ui-pages.test.ts test/same-origin.test.ts`
Expected: PASS. The Access walk in `test/ui-pages.test.ts` ("Access gate on every /ui route") now includes `/ui/api/activity` automatically (it walks `app.routes`); confirm it is in the printed test names.

- [ ] **Step 6: Full checks and commit**

Run: `npx vitest run` and `npx tsc --noEmit` (both clean).
```bash
git add src/lib/activity.ts src/routes/activity.ts src/routes/subscriptions.ts test/activity.test.ts
git commit -m "Activity feed: GET /ui/api/activity merges eight read-only sources with one keyset cursor" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY'
```
(Both trailer lines go in the last `-m` as one `$'…\n…'` string so they form one trailer block.)

---

### Task 2: Set diagnostics library and `GET /ui/api/set`

**Files:**
- Create: `src/lib/set-diagnostics.ts`
- Modify: `src/lib/mkvid.ts` (add `mkvidQueuePosition` next to `listMkvidQueuePage`)
- Modify: `src/routes/activity.ts` (add the route)
- Test: `test/set-diagnostics.test.ts`

**Interfaces:**
- Consumes: `normalizeTracklistUrl` (`src/lib/tracklists1001.ts`), `getVerification` (`src/lib/verification.ts`, returns `VerificationRow | null`), `loadSetFacts(env, [url]): Map<string, SetFacts>` + `judgeVideo(facts, meta, { rejectVertical })` + `rejectVerticalEnabled(env)` + `REASON_LABELS` (`src/lib/playlist-hygiene.ts`), `readCachedVideoMeta(env, ids): Map<string, VideoMeta>` (`src/lib/video-meta.ts`), `isOverridden(env, videoId)` (`src/lib/playlist-blocklist.ts`), `getMkvidRequestForSet(env, url): MkvidRequest | null` and `readinessFor(env, [req])` (`src/lib/mkvid.ts`, `src/lib/mkvid-readiness.ts`).
- Produces:
  - `export async function mkvidQueuePosition(env: Env, id: string): Promise<number | null>` in `src/lib/mkvid.ts`
  - `export type SetDiagnostics` (shape below) and `export async function setDiagnostics(env: Env, url: string): Promise<SetDiagnostics>` in `src/lib/set-diagnostics.ts` (expects an already-normalized URL)
  - Route: `GET /ui/api/set?url=<any form>` → 400 `{ error: 'invalid_request', message: 'not a 1001tracklists tracklist URL' }` when `normalizeTracklistUrl` returns null, else 200 `SetDiagnostics`.

```ts
export type SetDiagnostics = {
  url: string                       // normalized
  now: number                       // unix seconds
  discovered: Array<{ slug: string; artistName: string | null; discoveredAt: number; processed: boolean; abandoned: boolean; failureCount: number; videoKnown: boolean; videoId: string | null; videoSource: string | null; checkedAt: number | null }>
  schedule: { setDate: string | null; nextDueAt: number | null; lastFetchedAt: number | null; hasIdRows: boolean; noGoodVideo: boolean; retryAt: number | null; attemptDay: string | null; attemptsToday: number } | null
  verification: { state: 'pending' | 'verified'; rowCount: number; firstAccount: string | null; firstFetchedAt: number; verifyDueAt: number | null; secondAccount: string | null; secondFetchedAt: number | null; verifiedAt: number | null; mismatches: number } | null
  media: { videoId: string | null; noFullNotice: boolean; lastCueSeconds: number | null; audioMaxSeconds: number | null; audioKind: string | null; setTitle: string | null; setDate: string | null; trackCount: number | null; idedCount: number | null; fetchedAt: number } | null
  video: { id: string; from: 'tracklists' | 'media' | 'mkvid'; meta: { durationSeconds: number | null; embedWidth: number | null; embedHeight: number | null; privacy: string | null; uploadStatus: string | null; alive: boolean; fetchedAt: number } | null; verdict: { ok: true } | { ok: false; reason: string; label: string; detail: string } | null; override: boolean } | null
  playlist: { additions: Array<{ key: string; ts: number; status: string; slug: string; videoId: string | null; message: string | null }>; confirmed: Array<{ playlistId: string; state: 'in' | 'out'; source: string; at: number }> }
  hygiene: { removed: Array<{ playlistId: string; reason: string; at: number; slug: string | null }>; removals: Array<{ id: number; at: number; source: string; status: string; playlistKind: string; reason: string; detail: string | null }> }
  mkvid: { id: string; status: string; position: number | null; readiness: unknown | null; attempts: number; notBefore: number | null; error: string | null; videoId: string | null; style: string | null; account: string; skipIdWait: boolean; list: { trackCount: number; idRows: number | null; trusted: boolean; named: number; mismatched: number; scrapedAt: number } | null } | null
}
```

Reads (every one a SELECT; `artistName` from `sub_sync.artist_name` via LEFT JOIN on slug): `tracklists WHERE url = ?` (all rows: a b2b set has one per DJ); `set_schedule WHERE url = ?`; `getVerification`; `loadSetFacts(env, [url]).get(url)`; the video id is the first non-null of `discovered[].videoId` (`from: 'tracklists'`), `media.videoId` (`'media'`), `mkvid.videoId` (`'mkvid'`); for it `readCachedVideoMeta`, `isOverridden`, `judgeVideo(facts ?? null, meta ?? null, { rejectVertical: rejectVerticalEnabled(env) })` (verdict `null` when there are no facts and no meta), `playlist_confirmed WHERE video_id = ?`, `removed_videos WHERE video_id = ?`, `playlist_removals WHERE video_id = ? ORDER BY at DESC, id DESC LIMIT 20`; `playlist_additions WHERE set_url = ? ORDER BY ts DESC, id DESC LIMIT 10` (`message` from `summary.msg`); mkvid via `getMkvidRequestForSet`, `mkvidQueuePosition` (only when `status === 'pending'`, else `null`), `readinessFor(env, [req]).get(req.id) ?? null`, `mkvid_request_tracks WHERE request_id = ?`. Account ids in `verification` pass through `/^acct-\d+$/` or become `null`.

```ts
/** 1-based place of a pending request in the whole queue (claim order); null when it is not pending. */
export async function mkvidQueuePosition(env: Env, id: string): Promise<number | null> {
  const row = await dbOf(env)
    .prepare(`SELECT position FROM (SELECT id, ROW_NUMBER() OVER (${QUEUE_ORDER}) AS position FROM mkvid_requests WHERE status = 'pending') WHERE id = ?`)
    .bind(id)
    .first<{ position: number }>()
  return row ? Number(row.position) : null
}
```
(`QUEUE_ORDER` is declared further down the file as a `const`; place the function after it, or move the function below line 766. Do not export `QUEUE_ORDER`.)

- [ ] **Step 1: Write the failing tests** in `test/set-diagnostics.test.ts` (same `makeEnv`/`get` helpers; seed with direct inserts; the mkvid helpers in `test/helpers/mkvid-lists.ts` may already enqueue requests, check them first):
  - `rejects a non-tracklist URL`: `GET /ui/api/set?url=https://example.com/x` → 400 `invalid_request`; missing `url` → 400.
  - `normalizes the URL`: seed `tracklists` for `https://www.1001tracklists.com/tracklist/abc123/x.html`; `GET /ui/api/set?url=` + `encodeURIComponent('1001tracklists.com/tracklist/abc123/x.html?ref=1')` → 200, `url` is the canonical form, `discovered` has the row.
  - `an unknown set is all empty, not an error`: 200 with `discovered: []`, `schedule/verification/media/video/mkvid: null`, empty playlist and hygiene arrays.
  - `lists every DJ that discovered the set`: two `tracklists` rows (slugs `dj-one`, `dj-two`, same url) and a `sub_sync` row giving `dj-one` an `artist_name` → `discovered` has both, `dj-one.artistName` set, `dj-two.artistName` null.
  - `judges the video from cached facts only`: tracklists row with `video_id 'vid00000001'`, `set_media_facts` with `last_cue_seconds 3600`, `video_meta` with `duration_seconds 600` → `video.from === 'tracklists'`, `video.verdict.ok === false`, `video.verdict.reason === 'short'`, `video.verdict.label` is `REASON_LABELS.short`. Stub `globalThis.fetch` with a spy that throws; expect it never called.
  - `an override wins`: same plus `video_overrides (video_id, allow, at)` → `video.override === true`.
  - `position is null unless pending`: two pending requests (newer `sort_key` first) and one done; the second pending set's `mkvid.position === 2`; the done set's `mkvid.position === null`; `mkvidQueuePosition(env, doneId)` → null.
  - `reports readiness and the stored list`: a pending request with `mkvid_request_tracks` `trusted 0` → `mkvid.readiness.state === 'unverified'`, `mkvid.list.trusted === false`.
  - `hides non-acct account ids`: `set_verification` with `first_account 'acct-2'`, `second_account 'someone@example.com'` → `firstAccount 'acct-2'`, `secondAccount null`; the JSON text of the response contains no `@`.
  - `collects playlist and hygiene evidence`: one `playlist_additions` row for the url, one `playlist_confirmed` and one `removed_videos` and one `playlist_removals` row for the video → each shows up in its array.
  - `never writes`: same SQL recorder as Task 1 over a fully seeded set.

- [ ] **Step 2: Run them to see them fail** — `npx vitest run test/set-diagnostics.test.ts` → FAIL (module not found).
- [ ] **Step 3: Implement `mkvidQueuePosition`, `src/lib/set-diagnostics.ts` and the route**:

```ts
activityApp.get('/api/set', async (c) => {
  const url = normalizeTracklistUrl(c.req.query('url') || '')
  if (!url) return c.json({ error: 'invalid_request', message: 'not a 1001tracklists tracklist URL' }, 400)
  return c.json(await setDiagnostics(c.env, url))
})
```
  Run the reads with `Promise.all` where they do not depend on each other (tracklists, schedule, verification, facts, additions, mkvid request), then the video-dependent reads.
- [ ] **Step 4: Run the tests** — `npx vitest run test/set-diagnostics.test.ts test/mkvid.test.ts test/ui-pages.test.ts` → PASS.
- [ ] **Step 5: Full checks and commit**

```bash
git add src/lib/set-diagnostics.ts src/lib/mkvid.ts src/routes/activity.ts test/set-diagnostics.test.ts
git commit -m "Set diagnostics: GET /ui/api/set reads discovery, schedule, verification, full-recording rule, playlist, hygiene and mkvid for one set" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY'
```

---

### Task 3: Activity page (and the shared detail renderers)

**Files:**
- Create: `src/ui/pages/activity-detail.ts` (moved out of `home.ts`)
- Create: `src/ui/pages/activity.ts`
- Modify: `src/ui/pages/home.ts` (import the moved renderers; no behaviour change in this task)
- Modify: `src/ui/shell.ts` (NAV entry; drop the "joins the Pipeline group in phase 2" comment)
- Modify: `src/routes/activity.ts` (serve the page)
- Modify: `test/ui-pages.test.ts` (`PAGES` += `['/ui/activity', 'Activity']`; stub-DOM test), `test/same-origin.test.ts` (`pages` += `'/ui/activity'`)

**Interfaces:**
- Consumes: `GET /ui/api/activity` (Task 1), `GET /ui/api/list` (`{ subscriptions: [{ slug, ... }] }`), `/ui/api/audit-detail?key=`, `/ui/api/playlist-addition-detail?key=`, `shell()`, `TK.api.get`, `TK.qs.get/set`, `TK.drawer.open`, `TK.fmt.rel`, `TK.fmt.setLabel`, `TK.esc`, `TK.safeHref`, `icon()`.
- Produces:
  - `export const ACTIVITY_DETAIL_JS: string` defining, inside the page IIFE scope, `dl(pairs)`, `auditDetailHtml(r)`, `plDetailHtml(r)` and the `link`/`clock` helpers they need (move them verbatim from `home.ts`, keep their names), and `export const ACTIVITY_DETAIL_CSS: string` (the `.h-dl`, `.h-grp`, `.h-detail` rules from home's CSS).
  - `export const ACTIVITY_PAGE: UiPage` with `path: '/activity'`.
  - `export const ACTIVITY_ROW_JS: string` defining `activityRowHtml(r, i)` (used by Home in Task 5) and `export const ACTIVITY_ROW_CSS: string`.

Page spec:
- `shell({ nav: 'activity', title: 'Activity', description: 'Everything tracked did, newest first: requests, playlist additions, hygiene, mkvid, pool, sync and IP blocks.', actions: '<button id="a-refresh" type="button" class="btn">Refresh</button>', body, css, js })`.
- NAV entry: `{ key: 'activity', label: 'Activity', href: '/ui/activity', icon: 'activity', group: 'Pipeline' }` placed right after mkvid (no `tab`: the phone tabs stay Home, DJs, Search, mkvid, Pool).
- Filter bar (`<div class="tk-filters" id="a-filters">`): kind chips (`<button type="button" class="chip" data-kind="request" aria-pressed="false">Requests</button>` for request/Requests, playlist/Playlist, hygiene/Hygiene, mkvid/mkvid, pool/Pool, sync/Sync, ban/IP blocks; none pressed = all kinds), a `Problems only` toggle (`<button id="a-problems" class="chip" aria-pressed>`), a DJ `<select id="a-dj">` (first option `All DJs`, value ''; options from `/ui/api/list`, value slug, label slug, loaded after first render, failure leaves only `All DJs`), range chips `24h`/`7d`/`30d`/`90d` (`data-range`, exactly one pressed, default `7d`).
- State ↔ query string with `TK.qs.set({ kind: kinds.join(','), problems: problems ? '1' : '', dj, range })` on every change; on load read `TK.qs.get('kind' | 'problems' | 'dj' | 'range')`, ignoring unknown kinds and ranges. The API call: `/ui/api/activity?` + `kind=` (only when some chip pressed) + `&problems=1` + `&dj=` + `&since=` + `(Date.now() - RANGE_MS[range])` + `&limit=50` (+ `&cursor=` + `encodeURIComponent(cursor)` for Load older).
- List (`<div id="a-list" class="tk-card a-list" role="list">`), rows from `activityRowHtml(r, i)`: a `<button type="button" class="a-row' + (r.problem ? ' err' : '') + '" data-i="i">` with `icon(kind)` (kind → icon: request `play`, playlist `playlist`, hygiene `removed`, mkvid `mkvid`, pool `pool`, sync `refresh`, ban `ban`; render the SVG strings server-side into a JS object literal `KIND_ICON` via `JSON.stringify`), a badge (`bad` when `problem`, `ok` for statuses `ok, added, done, claimed, verified, challenge.solved, account.created, ended`, else `neutral`), the escaped title, the escaped detail in `.muted`, a DJ link `/ui/dj/<encodeURIComponent(dj)>` when `dj`, a set link `/ui/set?url=<encodeURIComponent(setUrl)>` when `setUrl` (both links stop propagation so they do not open the drawer: put them outside the button, in the row wrapper `<div class="a-item" role="listitem">`), and the time `TK.fmt.rel(new Date(r.ts).toISOString())` with the ISO string in `title`.
- Below the list: `<button id="a-more" class="btn" hidden>Load older</button>`; `<div id="a-empty" class="empty" hidden>`: "Nothing in this range." (with filters: "Nothing matches these filters in this range."); errors render `TK.errText(res, ...)` in `#a-empty` with a Retry button (`#a-retry`).
- A new filter or Refresh replaces the list; Load older appends; a response that arrives after a newer request was started is dropped (sequence counter, as `openDetail` does on Home).
- Row click opens the drawer: `audit` → `/ui/api/audit-detail?key=` + `auditDetailHtml`; `addition` → `/ui/api/playlist-addition-detail?key=` + `plDetailHtml`; anything else → `dl()` of the row's own fields (When, Kind, Status, Title, Detail, DJ, Set, Video) with no fetch.
- Phone (< 800px): rows wrap; the time moves under the title; chips scroll horizontally inside the filter bar (`overflow-x: auto`) so the page never scrolls sideways.

- [ ] **Step 1: Write the failing tests** in `test/ui-pages.test.ts`:
  - add `['/ui/activity', 'Activity']` to `PAGES` and `'/ui/activity'` to `test/same-origin.test.ts`'s `pages`;
  - `describe('Activity page')`: run the page's scripts in the full stub used by the other page tests in that file (find the helper the DJs/Home stub-DOM tests use and reuse it) with `fetch` answering `/ui/api/activity` with two rows (one `problem: true` audit row, one `addition` row with `dj` and `setUrl`) and `cursor: 'x'`, and `/ui/api/list` with one subscription. Assert: the first fetch URL starts with `/ui/api/activity?` and contains `&since=` and `limit=50` and no `kind=`; `#a-list` innerHTML contains `class="a-row err"` once, `/ui/dj/dj-one`, `/ui/set?url=`; `#a-more.hidden === false`; a title containing `<img src=x onerror=1>` is rendered escaped (`&lt;img`).
  - same harness with `TK.qs` returning `kind=pool,ban&problems=1&range=24h&dj=dj-one`: the fetch URL contains `kind=pool%2Cban` or `kind=pool,ban`, `problems=1`, `dj=dj-one`, and a `since` within 1 s of `Date.now() - 86_400_000`.
  - `ACTIVITY_DETAIL_JS` is the code Home used: `home.ts` no longer contains `function auditDetailHtml`, and the Home stub-DOM tests still pass.
  - NAV: `shell({ nav: 'activity', ... })` contains `href="/ui/activity"` with `class="on"`, and the phone tab bar still lists exactly the five destinations (extend the existing "narrow pages… five destinations" test with `expect(h).not.toMatch(/tk-tabs[\s\S]*\/ui\/activity/)` or the equivalent for how the tab bar is marked up).
- [ ] **Step 2: Run them to see them fail** — `npx vitest run test/ui-pages.test.ts test/same-origin.test.ts` → FAIL (`/ui/activity` 404).
- [ ] **Step 3: Implement** `activity-detail.ts` (pure move), `activity.ts`, the NAV entry, and `activityApp.get('/activity', (c) => servePage(c, ACTIVITY_PAGE.html))` in `src/routes/activity.ts`.
- [ ] **Step 4: Run** `npx vitest run test/ui-pages.test.ts test/same-origin.test.ts test/ui-icons.test.ts` → PASS.
- [ ] **Step 5: Full checks and commit**

```bash
git add src/ui/pages/activity-detail.ts src/ui/pages/activity.ts src/ui/pages/home.ts src/ui/shell.ts src/routes/activity.ts test/ui-pages.test.ts test/same-origin.test.ts
git commit -m "Activity page: unified log with kind, problems, DJ and range filters in the URL, Load older, detail drawer" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY'
```

---

### Task 4: Set page diagnostics column

**Files:**
- Create: `src/ui/pages/set-diag.ts`
- Modify: `src/ui/pages/set.ts`
- Test: `test/ui-pages.test.ts` (new `describe('Set diagnostics')`)

**Interfaces:**
- Consumes: `GET /ui/api/set?url=` (Task 2, `SetDiagnostics`), `REASON_LABELS` already applied server-side (`verdict.label`).
- Produces: `export const SET_DIAG_JS: string` defining `function setDiagRows(d)` → `Array<{ key: string; label: string; tone: 'ok' | 'warn' | 'bad' | 'info' | 'neutral'; finding: string; facts: Array<[string, string]> }>` (plain text, not HTML; the renderer escapes) and `function renderDiag(d)` → HTML; `export const SET_DIAG_CSS: string`.

Rows, in this order, with these findings (times through `TK.fmt.rel`/`TK.fmt.until` of `new Date(sec * 1000).toISOString()`):
1. `discovered` "Discovered": none → `warn` "No subscribed DJ lists this set."; any `abandoned` → `bad` "Given up after N failed fetches."; any `failureCount > 0` → `warn` "N failed fetches so far."; else `ok` "Listed under <artistName || slug, joined ', '>.". Facts per row: DJ, discovered, processed, checked.
2. `recording` "Recording": `video` from `tracklists`/`media` → `ok` "YouTube <id> from the set page."; from `mkvid` → `ok` "YouTube <id>, rendered by mkvid."; any discovered `videoKnown` with no video → `warn` "The set page had no YouTube recording."; else `info` "Set page not fetched yet.". Facts: next due (`schedule.nextDueAt` null → "never: old set, good video, no ID rows"), last fetched, retry at, attempts today (`attemptsToday` of 3 on `attemptDay`), has ID rows, no good video.
3. `verification` "Verification": null → `info` "Not fetched through the pool yet."; `pending` → `warn` "First fetch by <firstAccount || 'an account'>, second fetch due <until(verifyDueAt)>." (no `verifyDueAt` → "second fetch not scheduled"); `verified` → `ok` "Verified <rel(verifiedAt)> (<rowCount> rows)."; `mismatches > 0` appends " <n> earlier pair(s) disagreed.". Facts: both accounts and times.
4. `rule` "Full-recording rule": no `video` → `neutral` "No video to judge."; `override` → `ok` "Owner override: the rule is not applied to this video."; `verdict` null → `info` "Not judged yet: the set page or the video facts have not been seen."; `verdict.ok` → `ok` "Full recording."; else `bad` "<verdict.label>: <verdict.detail>.". Facts: video duration, last cue, longest audio, notice, embed size, alive.
5. `playlist` "Playlist": no additions → `info` "No playlist addition recorded (kept 90 days)."; latest `added`/`replaced`/`duplicate` → `ok` "<status> <rel(ts)>."; latest `failed`/`abandoned` → `bad` "<status>: <message || 'no message'>."; `no_youtube` → `warn` "No YouTube recording when last processed.". Facts: every addition (status, when, message) and every confirmed membership (`in`/`out`, source, playlist id).
6. `hygiene` "Hygiene": `removed` non-empty → `bad` "Blocked from N playlist(s): <reasons>." with reasons owner → "removed by you", dead → "video died", button → "remove and replace"; else any removal `failed` → `bad` "A removal failed: <detail>."; any `would_remove` → `warn` "The sweep would remove it (dry run)."; else `ok` "Nothing removed.". Facts: each removal (source, status, reason, when). When non-empty, a link "Removed videos" to `/ui/removed`.
7. `mkvid` "mkvid": null → `neutral` "Not queued for mkvid."; `pending` + readiness `ready` → `ok` "#<position> in the queue, ready."; `unverified` → `warn` "#<position> in the queue; waits because the track list is not verified."; `waiting_ids` → `warn` "#<position>; waits for IDs until <until> (<idRows> ID rows)."; `backoff` → `warn` "#<position>; retry backoff until <until>."; `claimed` → `info` "Rendering now."; `done` → `ok` "Uploaded <videoId>."; `failed` → `bad` "Failed: <error>."; `banned` → `bad` "Banned from mkvid."; `superseded` → `neutral` "Superseded by an official recording.". Facts: attempts, account, style, skip ID wait, stored list (rows, ID rows, trusted/untrusted, named, mismatched, scraped). Link "Open mkvid" to `/ui/mkvid`.

Layout: `<div class="set-layout">` with the existing track column and `<aside id="diag" class="tk-card set-diag" aria-label="Diagnostics" hidden>`; from 1100px a two-column grid (tracks `1fr`, diagnostics `24rem`), below that the diagnostics stack **above** the tracks (they answer "why isn't it in my playlist" without scrolling past 40 tracks). Each row: `<details class="diag-row">` with `<summary>` = label + badge(tone) + finding, body = a `<dl>` of facts. DJ links in the Discovered facts go to `/ui/dj/<slug>`.

Behaviour: `load(url)` starts `TK.api.get('/ui/api/set?url=' + encodeURIComponent(url))` in parallel with the existing `POST /ui/api/tracklist`, independently: the diagnostics render even when the track-list call fails (and vice versa); a 400 hides the column; any other failure shows "Diagnostics unavailable: <errText>" in the column. A newer `load` drops an older response (sequence counter). No new buttons: actions stay the existing Refresh track list and Load links.

- [ ] **Step 1: Write the failing tests** (`describe('Set diagnostics')` in `test/ui-pages.test.ts`):
  - Run `SET_DIAG_JS` in a `vm` context with a minimal `TK` stub (`fmt.rel`, `fmt.until` returning fixed strings) and call `setDiagRows` with: an empty response (all null / empty) → keys in order `['discovered','recording','verification','rule','playlist','hygiene','mkvid']`, tones `['warn','info','info','neutral','info','ok','neutral']`; a pending mkvid with `position: 3` and readiness `{ state: 'waiting_ids', until: 1_800_000_000, idRows: 2 }` → mkvid finding starts `#3;` and contains `2 ID rows`; a `verdict: { ok: false, reason: 'short', label: 'Shorter than the set', detail: 'video 10:00 < last cue 60:00 - 5:00' }` → rule tone `bad`, finding contains both strings; `override: true` with the same verdict → tone `ok`; `removed: [{ reason: 'owner', ... }]` → hygiene tone `bad`, finding contains `removed by you`.
  - `renderDiag` escapes: a `setTitle`/`message`/`error` containing `<img src=x onerror=1>` never appears unescaped in the HTML.
  - `diagnostics render when the track list fails`: run the Set page scripts in the page stub with `TK.qs.get('url')` returning a URL, `fetch` answering `POST /ui/api/tracklist` with 502 and `/ui/api/set?url=` with a minimal diagnostics object; after microtasks, `#diag.hidden === false` and its innerHTML contains `Discovered`, and `#error` holds the track-list error.
  - `a 400 hides the column`: `/ui/api/set` answers 400 → `#diag.hidden === true`.
- [ ] **Step 2: Run them to see them fail.**
- [ ] **Step 3: Implement** `set-diag.ts` and the `set.ts` changes (description becomes "Paste a 1001tracklists tracklist URL to see its tracks, links and why it is or is not in your playlists.").
- [ ] **Step 4: Run** `npx vitest run test/ui-pages.test.ts test/same-origin.test.ts` → PASS.
- [ ] **Step 5: Full checks and commit**

```bash
git add src/ui/pages/set-diag.ts src/ui/pages/set.ts test/ui-pages.test.ts
git commit -m "Set page: diagnostics column (discovery, recording, verification, full-recording rule, playlist, hygiene, mkvid) from /ui/api/set" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY'
```

---

### Task 5: Home recent activity from the feed, README, screenshot seed

**Files:**
- Modify: `src/ui/pages/home.ts`
- Modify: `README.md` ("Admin UI (/ui)" section)
- Modify: `.superpowers/sdd/2026-09-30-tracked-ui-phase1/tools/seed.sql` copied to `.superpowers/sdd/2026-10-01-tracked-ui-phase2/tools/seed.sql` (gitignored; not committed)
- Test: `test/ui-pages.test.ts` (Home stub-DOM tests)

**Interfaces:**
- Consumes: `ACTIVITY_ROW_JS`/`ACTIVITY_ROW_CSS`, `ACTIVITY_DETAIL_JS` (Task 3), `GET /ui/api/activity?limit=12`.

Home changes: the two side-by-side cards (`Recent requests`, `Recent playlist additions`, ids `req-list`, `pl-list`, `req-empty`, `pl-empty`) become one card "Recent activity" (`<div id="act-list">`, `<div id="act-empty">`) with a header link "View all" to `/ui/activity` and a second link "Problems" to `/ui/activity?problems=1`. It loads `/ui/api/activity?limit=12` once (no `since`), renders rows with `activityRowHtml`, and opens the same drawer as the Activity page on click (same `audit`/`addition`/inline split). Remove the now-unused `PROBLEM`, `PL_PROBLEM`, `renderReq`, `renderPl`, `loadReq`, `loadPl` and their CSS. Update the file's header comment (data sources). The needs-attention list, tiles and quick actions are untouched.

README: in "Admin UI (/ui)", Home's description says it shows the last 12 events from the Activity log with links to the full log and to problems only; add an Activity entry (path, filters, Load older, drawer); the Set entry mentions the diagnostics column and that it reads only stored data (no fetch); the moved-features line that said requests and playlist additions are on Home now says Activity. No secrets, emails, usernames.

Seed (for local screenshots only): add rows to `playlist_removals`, `pool_events` (account ids `acct-1`, `acct-2` only), `mkvid_claims`, `set_verification`, `set_media_facts`, `set_schedule`, `video_meta`, `playlist_confirmed`, `removed_videos` and `sub_sync.last_error` for one DJ, plus two ban-episode KV keys documented in a comment for `wrangler kv key put --local`.

- [ ] **Step 1: Update the Home tests first**: wherever `test/ui-pages.test.ts` (or `test/ui-runtime.test.ts`) expects `/ui/api/audit?limit=6` or `/ui/api/playlist-additions?limit=6` from Home, expect `/ui/api/activity?limit=12` instead; add: Home's `#act-list` renders an `err` row for a `problem` row and links `/ui/activity?problems=1`.
- [ ] **Step 2: Run to see them fail.**
- [ ] **Step 3: Implement** the Home change and the README edit; write the seed file.
- [ ] **Step 4: Run** `npx vitest run` and `npx tsc --noEmit` → clean.
- [ ] **Step 5: Commit**

```bash
git add src/ui/pages/home.ts README.md test/ui-pages.test.ts
git commit -m "Home: recent activity from /ui/api/activity with links to the full log and problems; README for Activity and Set diagnostics" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY'
```

---

### Task 6: Local screenshots and whole-branch review

**Files:** none committed unless the review finds something.

- [ ] **Step 1:** Start the local stack as in phase 1 (`.superpowers/sdd/2026-09-30-tracked-ui-phase1/tools/`: fake tlpool, `wrangler dev` with the seeded local D1 using the phase 2 seed). Use the gstack `/browse` skill (from a cwd without `.gstack`), never the claude-in-chrome tools. Screenshot `/ui/activity` (no filter, `?problems=1`, `?kind=mkvid&range=30d`), an open drawer for an audit row and for a pool row, `/ui/set?url=<seeded set>` for a set with a video verdict failure and one with a pending mkvid request, and Home, each at 1440 px and 360 px. Confirm no page scrolls sideways. Stop `wrangler dev` and kill leftover `workerd` processes afterwards.
- [ ] **Step 2:** Whole-branch review (opus) of `origin/main..new-ui` against this plan, the spec and Global Constraints; fix wave for its findings; re-review.
- [ ] **Step 3:** Send the pool session ("tracked-mkvid-continue") the branch head for its review of `src/lib/mkvid.ts` (`mkvidQueuePosition`), the new routes, and the account-id handling. Then report to the owner and wait for the merge ok. No migrations: the pre-merge check is rebase, vitest, tsc, `npx wrangler d1 migrations list tracked --remote` showing nothing to apply.
