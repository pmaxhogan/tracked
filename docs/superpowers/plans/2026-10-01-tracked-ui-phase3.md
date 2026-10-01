# tracked UI phase 3 (Search) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fuzzy search over every verified tracklist: tracks, sets and DJs from one box (`/ui/search`, `GET /ui/api/search`), fed by verified fetches and a Tools backfill. The search index lives in its own D1 database.

**Architecture:**
- **Storage:**
  - The index lives in a separate D1 database, `tracked-search`, bound as `SEARCH_DB`, with migrations in `migrations-search/`.
  - It holds two base tables (`search_sets`, `search_tracks`), a link table, a vocabulary, and three FTS5 tables.
- **Writers:**
  - A fire-and-forget indexer runs after `noteSetFetch` reports `verified` or `unchanged`. It is drained through `waitUntil`, never awaited by the fetch path.
  - An admin backfill reads trusted mkvid track lists.
- **Search request:** one Worker request runs the whole pipeline. It normalizes and corrects the query against the vocabulary, recalls candidates from FTS5 with `bm25`, re-ranks them in the Worker, and matches DJs against the subscription list.
- **UI:** the Search page and the shell's search box use the phase-1 `TK` runtime and bare inline scripts.

**Tech Stack:** Cloudflare Workers, Hono, D1 with FTS5 (`unicode61 remove_diacritics 2` and `trigram` tokenizers), vitest, `@sqlite.org/sqlite-wasm` for the test D1, `node:vm` stub DOMs.

**Spec:** `docs/superpowers/specs/2026-09-30-tracked-ui-redesign-design.md`: sections "Search (phase 3)" (§6), §9, "Tools", §3 non-negotiables, and §10. The phase 2 plan has the conventions: `docs/superpowers/plans/2026-10-01-tracked-ui-phase2.md`.

**Deviations from the spec, decided 2026-10-01:**
1. **The index lives in its own D1 database, `tracked-search`, not in migration `0013` of `tracked`.**
   - Cloudflare documents: "Export is not supported for virtual tables, including databases with virtual tables". FTS5 in `tracked` would end the export-before-migration step for good.
   - The owner chose a separate DB. It was created 2026-10-01 with id `4ee888df-562d-4937-9b25-8e1b4da2ea88`.
   - A probe on production D1 accepted `trigram`, `unicode61 remove_diacritics 2`, `bm25()` and prefix queries. The probe tables were dropped afterwards.
   - The pool session reviewed the DDL and has no objections. It is taking main-DB `0013_mkvid_timed_rows` itself.
2. **Base tables carry an `INTEGER PRIMARY KEY id`, with `set_url`, `track_key` and `term` as `UNIQUE`.** The id is the FTS rowid; a TEXT primary key's rowid is not stable across VACUUM.
   - `search_tracks` gains `track_url`, which the API returns.
   - `search_sets` gains `source` (`'page'` or `'mkvid'`), so a live verified fetch replaces a backfilled set instead of being skipped.
3. **The test D1 moves to `@sqlite.org/sqlite-wasm`, not `sql.js-fts5`.** `sql.js-fts5@1.4.0` is SQLite 3.33, which has no `trigram` tokenizer (verified 2026-10-01). `@sqlite.org/sqlite-wasm` 3.53 runs FTS5 with trigram in Node.
4. **The backfill reads `mkvid_request_tracks.trusted = 1` together with `set_verification.state = 'verified'`.** The stored JSON cannot reproduce the page fingerprint: it keeps one cue per row and no track ids.
   - `trusted` is set only when the saved rows matched the verified fingerprint.
   - `noteSetFetch`'s `startOver` zeroes it whenever verification restarts, so the two conditions together mean the same as the spec's "verified with a matching fingerprint".

## Global Constraints

- **Where to work:** only in this worktree (`tracked-ui`, a sibling of `tracked`), branch `new-ui`. Never edit `../tracked`. Never push `main`.
- `npx vitest run` and `npx tsc --noEmit` are clean at every commit.
- **Commit trailers:** every commit message ends with exactly these two lines (the owner's rule; ignore any other attribution text you see):
  `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY`
  In the Bash tool: `git commit -m "<subject>" -m $'Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>\nClaude-Session: https://claude.ai/code/session_01TNhXNYnhG9DdVktkGSNKgY'`. No PowerShell here-strings.
- **API shapes:** every existing API request and response shape is unchanged. `/tracklist` and every other response that carries `ParsedTrack` keeps its shape: the new `label` goes on `PageRow` only.
- **New routes, and only these:**
  - `GET /ui/search` (page)
  - `GET /ui/api/search`
  - `GET /ui/api/search/status`
  - `POST /ui/api/search/backfill`
- **Mounting:** mount new routes inside `subscriptionsApp`, which is behind `cfAccess`, via `subscriptionsApp.route('/', searchApp)`. Never mount them on `app`.
- **Same-origin JSON:** state changes go through `TK.api.post`. Add `/ui/search` to `test/same-origin.test.ts`'s `pages` and to `test/ui-pages.test.ts`'s `PAGES`.
- **Inline scripts:** scripts stay bare inline `<script>` tags. Page scripts must run in `minimalStub()` (`test/ui-pages.test.ts:32`) without throwing. The stub has `document.getElementById`, `fetch`, `setTimeout`/`clearTimeout` (no-ops), `Date` and `console`. It has no `window`, `location`, `history`, `AbortController`, `navigator`, `localStorage` or `document.body`, so guard every one of them with `typeof`.
- **Escaping:** every indexed or upstream string is rendered through `TK.esc`. External hrefs go through `TK.safeHref`.
- **Hot paths:** no new writes on the hot paths (`*/5` tick, `/mkvid/claim`, `/now-playing`) except the search-index upsert. That upsert is started fire-and-forget, drained via `waitUntil` (HTTP) or an awaited drain at the end of the cron's `waitUntil` body, with every error swallowed and logged at `warn`.
- **Index sources:**
  - The index is only ever written from verified lists. Never from `cacheParsedTracklist`, the `tl:` KV cache, or any KV.
  - It is never written on the cron except by that hook.
  - It is never pruned. A set that verifies again is re-indexed.
- **Read-only main DB:** the search code only reads `DB` (no main-DB writes at all) and writes only `SEARCH_DB`.
- **Public repo:** no secrets, emails or usernames in code, fixtures, docs or commits. Pool account ids never appear in search data. Test fixtures are synthetic rows; artist and set names are public and fine, but never commit scraped HTML.
- **Bad input:** malformed query parameters return `400 { error: 'invalid_request', message }`. An empty `q` returns `200` with empty groups.
- **SDD ledger:** `.superpowers/sdd/2026-10-01-tracked-ui-phase3/` (gitignored).

## Review Focus

1. **Recheck storm.** `unchanged` fires on every recheck of every verified set. A set already indexed from a page fetch at or after its `verified_at`, with the same `video_id`, must cost a few reads and no writes. (Task 2 test "skips a set already indexed since it verified".)
2. **Backfill, then live.** A backfilled set (hash keys, no labels) later indexed from a verified page fetch (track ids) must leave each track once in that set's results. The old hash-keyed tracks drop to `sets_count = 0` and never appear in results. (Task 2 test "a live index replaces a backfilled set's tracks"; Task 3 test "orphan tracks are not returned".)
3. **b2b set.** A URL under two subscribed slugs is indexed once, under `MIN(slug)`, with the stored `artist_name` of that slug, whichever slug's sync fetched it. (Task 2 test "a b2b set is indexed under the smallest slug".)
4. **Indexer failure.** A throwing `SEARCH_DB` (or none bound) never changes `recordSetFetch`'s result, never throws into `syncOne`, and never fails the cron. (Task 2 test "a failing index write is swallowed".)
5. **Backfill budget.** A backfill press that runs out of its time budget returns `{ cursor, done: false }` with what it finished, not a 500. A press with `limit` beyond 500 or below 1 gets a 400. (Task 4 tests "stops at the deadline with a cursor" and "rejects a bad limit".)
6. **FTS syntax in user input.** Queries with FTS5 syntax characters (`"`, `*`, `(`, `-`, `:`, `NEAR`, `AND`) return results or nothing, never a 500. (Task 3 test "FTS syntax in the query is inert".)

---

### Task 0: Test D1 on `@sqlite.org/sqlite-wasm`

**Model:** opus. Every test in the suite depends on this harness.

**Files:**
- Modify: `test/helpers/fake-d1.ts` (engine swap; keep every exported name)
- Modify: `test/migrations.test.ts` (it imports `sql.js` directly)
- Modify: `test/mkvid.test.ts:241` (comment mentions sql.js; reword only)
- Modify: `package.json`, `package-lock.json`: add `@sqlite.org/sqlite-wasm` (pin the exact installed version) to devDependencies; remove `sql.js` and `@types/sql.js` after `grep -rn "sql.js" src test scripts` shows no other importer.
- Test: `test/fake-d1.test.ts` (new)

**Interfaces:**
- Produces:
  - `fakeD1(opts?: { migrations?: 'main' | 'search' }): FakeD1`. The default is `'main'`, which reads `migrations/`. `'search'` reads `migrations-search/`; if that directory does not exist yet, it applies nothing.
  - `applyMigrations(db, dir?)`
  - `FakeD1 = D1Database & { _db: <the oo1 DB> }`
  - Callers that used `_db` must keep working. Grep `_db` in `test/` and adapt every caller in this task.

**Behaviour to keep (the fake's contract, from its header comment):**
- An `undefined` or boolean bind throws the D1 messages verbatim.
- `first()` returns `null` on a miss, and `first(col)` returns the column or `null`.
- `bind()` returns a fresh statement.
- `batch()` is one transaction: `BEGIN`, then `COMMIT`, or `ROLLBACK` and rethrow.
- `run()` meta reports `changes` (`db.changes()`), `last_row_id` (`sqlite3.capi.sqlite3_last_insert_rowid(db)`, as a Number) and `changed_db`.
- `raw({ columnNames })` behaves as today.
- Reads are detected by the same `READS` regex.
- Integers come back as JS numbers, never bigint. Use `rowMode: 'object'`, and pass `{ bigIntEnabled: false }` at init or convert.

- [ ] **Step 1: Write the failing test** `test/fake-d1.test.ts`

```ts
import { describe, it, expect } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'

describe('fakeD1 engine', () => {
  it('has FTS5 with unicode61 remove_diacritics and trigram, and bm25', async () => {
    const db = fakeD1()
    await db.exec(`CREATE VIRTUAL TABLE t_u USING fts5(a, b, tokenize='unicode61 remove_diacritics 2')`)
    await db.exec(`CREATE VIRTUAL TABLE t_g USING fts5(term, tokenize='trigram')`)
    await db.prepare('INSERT INTO t_u (rowid, a, b) VALUES (?, ?, ?)').bind(7, 'Café Ünïcode', 'x').run()
    await db.prepare('INSERT INTO t_g (rowid, term) VALUES (?, ?)').bind(1, 'palmer').run()
    expect(await db.prepare(`SELECT rowid AS id, bm25(t_u, 3.0, 1.0) AS s FROM t_u WHERE t_u MATCH ?`).bind('"cafe" "unico"*').first('id')).toBe(7)
    expect(await db.prepare(`SELECT term FROM t_g WHERE t_g MATCH ?`).bind('"alm"').first('term')).toBe('palmer')
  })
  it('keeps D1 strictness: undefined/boolean binds throw, first() is null on a miss', async () => {
    const db = fakeD1()
    expect(() => db.prepare('SELECT 1').bind(undefined)).toThrow(/D1_TYPE_ERROR/)
    expect(() => db.prepare('SELECT 1').bind(true)).toThrow(/D1_TYPE_ERROR/)
    expect(await db.prepare('SELECT slug FROM subscriptions WHERE slug = ?').bind('none').first()).toBeNull()
  })
  it('batch is one transaction and run() reports changes and last_row_id as numbers', async () => {
    const db = fakeD1()
    const ins = db.prepare('INSERT INTO subscriptions (slug, source_url, added_at, position) VALUES (?, ?, ?, ?)')
    const r = await ins.bind('a', 'u', 1, 1).run()
    expect(r.meta.changes).toBe(1)
    expect(typeof r.meta.last_row_id).toBe('number')
    await expect(db.batch([ins.bind('b', 'u', 1, 2), ins.bind('a', 'u', 1, 3)])).rejects.toThrow()
    expect(await db.prepare('SELECT COUNT(*) AS n FROM subscriptions').first('n')).toBe(1)
  })
  it('opens the search migrations on request', async () => {
    const db = fakeD1({ migrations: 'search' })
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'subscriptions'`).first('n')).toBe(0)
  })
})
```

- [ ] **Step 2: Run it.** `npx vitest run test/fake-d1.test.ts`. Expected: FAIL. sql.js has no fts5 ("no such module: fts5"), and `fakeD1` takes no options.

- [ ] **Step 3: Swap the engine.**
  - `npm i -D @sqlite.org/sqlite-wasm@<exact>`
  - Rewrite the internals of `fake-d1.ts` on `sqlite3InitModule()` and `new sqlite3.oo1.DB(':memory:')`. Use top-level await once per module, as today.
  - Statement execution goes through `db.exec({ sql, bind, rowMode: 'object', returnValue: 'resultRows' })` or prepared statements (`db.prepare(sql)`, `.bind(values)`, `.step()`, `.get({})`, `.finalize()`), so a statement with zero binds works too.
  - Port `test/migrations.test.ts` to the same engine. Export a tiny `openRawDb()` from the helper so the test does not import the wasm module itself.
  - Update the header comment: name the engine and say why ("FTS5 + trigram; sql.js builds have no FTS5, sql.js-fts5 is SQLite 3.33 without trigram").
  - If the oo1 init prints a `localStorage`/OPFS warning, silence it at init (the `print`/`printErr` options) so test output stays pristine.

- [ ] **Step 4: Run the whole suite.** `npx vitest run` and `npx tsc --noEmit`. Expected: all green, same test count as before plus the new file. Fix any test that leaned on a sql.js-only quirk (e.g. integer types, `created_at` second resolution) by adapting the fake, not the test's assertion, unless the test was asserting a sql.js artefact.

- [ ] **Step 5: Prove Node 20** (CI runs Node 20 and only on PRs to main): `npx -y -p node@20 node node_modules/vitest/vitest.mjs run`. Expected: green. Paste the summary line in the report.

- [ ] **Step 6: Commit** `Test D1 on @sqlite.org/sqlite-wasm: FTS5 with trigram for the search index (sql.js has no FTS5)` plus the trailers.

---

### Task 1: Search DB binding, schema, normalizer, track keys, row labels

**Model:** sonnet.

**Files:**
- Create: `migrations-search/0001_search.sql`
- Modify: `wrangler.jsonc` (second `d1_databases` entry)
- Modify: `src/types.ts` (`SEARCH_DB?: D1Database` with a doc comment)
- Create: `src/lib/search/normalize.ts`
- Create: `src/lib/search/db.ts`
- Modify: `src/lib/tracklists1001.ts` (`PageRow` gains `label`; the parser fills it)
- Test: `test/search-normalize.test.ts`, `test/search-schema.test.ts`; extend the existing parser test file (`grep -ln "parseTracklist" test`) with label assertions.

**Interfaces:**
- Consumes: `fakeD1({ migrations: 'search' })` (Task 0).
- Produces:
  - `searchDbOf(env: Env): D1Database`. Returns `env.SEARCH_DB`; throws `Error('search_db_missing')` when unbound.
  - `normalizeText(s: string | null | undefined): string[]`: the token list.
  - `normalizedJoin(s): string`: `normalizeText(s).join(' ')`.
  - `slugWords(url: string): string`: normalized words of the 1001tl URL's last path segment, without `.html` and without the date.
  - `trackKey(t: { trackId: string | null; artist: string; title: string }): Promise<string>`. Returns `'t:' + trackId` when `trackId` matches `/^\d{1,12}$/`. Otherwise it returns `'h:' + sha256hex(normalizedJoin(artist) + '\u0000' + normalizedJoin(title)).slice(0, 32)`.
  - `PageRow = ParsedTrack & { anonymous: boolean; label: string | null }`.

- [ ] **Step 1: Schema file** `migrations-search/0001_search.sql`, exactly:

```sql
-- Search index (docs/superpowers/specs/2026-09-30-tracked-ui-redesign-design.md §9),
-- in its own D1 database: FTS5 virtual tables would stop `wrangler d1 export`
-- working for the main database. Everything here is rebuildable from verified
-- lists (src/lib/search/index.ts), so this database is never exported.
-- FTS rows are keyed by the base row's integer id (rowid). Text in the FTS
-- columns is already normalized (src/lib/search/normalize.ts); display text
-- comes from the base tables.
CREATE TABLE search_sets (
  id INTEGER PRIMARY KEY,
  set_url TEXT NOT NULL UNIQUE,
  dj_slug TEXT NOT NULL,
  dj_name TEXT NOT NULL,
  title TEXT NOT NULL,
  set_date TEXT,
  video_id TEXT,
  video_source TEXT,
  track_count INTEGER NOT NULL DEFAULT 0,
  ided_count INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'page',      -- 'page' (a verified fetch) | 'mkvid' (backfill from a trusted mkvid list)
  indexed_at INTEGER NOT NULL               -- unix seconds
);
CREATE TABLE search_tracks (
  id INTEGER PRIMARY KEY,
  track_key TEXT NOT NULL UNIQUE,           -- 't:<1001tl track id>' or 'h:<hash of normalized artist + title>'
  track_id TEXT,
  track_url TEXT,
  artist TEXT NOT NULL,
  title TEXT NOT NULL,
  label TEXT,
  youtube_link TEXT,
  sets_count INTEGER NOT NULL DEFAULT 0,    -- 0 = orphaned by a re-index; never returned
  updated_at INTEGER NOT NULL
);
CREATE INDEX search_tracks_track_id ON search_tracks(track_id) WHERE track_id IS NOT NULL;
CREATE TABLE search_track_sets (
  track_key TEXT NOT NULL,
  set_url TEXT NOT NULL,
  pos INTEGER NOT NULL,
  cue_seconds INTEGER,
  layered INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (track_key, set_url)
);
CREATE INDEX search_track_sets_set ON search_track_sets(set_url);
CREATE TABLE search_vocab (
  id INTEGER PRIMARY KEY,
  term TEXT NOT NULL UNIQUE,
  df INTEGER NOT NULL DEFAULT 0             -- index writes that carried the term; approximate, orders correction candidates
);
CREATE VIRTUAL TABLE sets_fts USING fts5(title, dj, slug_words, tokenize='unicode61 remove_diacritics 2');
-- Column order is the bm25() weight order: artist 3, title 3, label 1, djs 2, set_titles 1.
CREATE VIRTUAL TABLE tracks_fts USING fts5(artist, title, label, djs, set_titles, tokenize='unicode61 remove_diacritics 2');
CREATE VIRTUAL TABLE vocab_fts USING fts5(term, tokenize='trigram');
```

- [ ] **Step 2: Binding.** In `wrangler.jsonc` `d1_databases`, add:
  `{ "binding": "SEARCH_DB", "database_name": "tracked-search", "database_id": "4ee888df-562d-4937-9b25-8e1b4da2ea88", "migrations_dir": "migrations-search" }`.
  In `src/types.ts`, add `SEARCH_DB?: D1Database` after `DB`, with this doc comment: "Search index (migrations-search/); optional so a Worker without it still serves everything else (search returns 503 search_unavailable)."

- [ ] **Step 3: Write the failing tests** `test/search-normalize.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { normalizeText, slugWords, trackKey } from '../src/lib/search/normalize'

describe('normalizeText', () => {
  it('lowercases, strips diacritics, drops apostrophes, & to and', () => {
    expect(normalizeText("Don't Stop")).toEqual(['dont', 'stop'])
    expect(normalizeText('Tiësto & Sevenn')).toEqual(['tiesto', 'and', 'sevenn'])
    expect(normalizeText('Rian Wood & Version 34')).toEqual(['rian', 'wood', 'and', 'version', '34'])
    expect(normalizeText('l’amour')).toEqual(['lamour'])
  })
  it('maps synonyms: feat/ft/featuring, rmx/remix, vs/versus, w/ to with, pt/part', () => {
    expect(normalizeText('A ft. B featuring C feat D')).toEqual(['a', 'feat', 'b', 'feat', 'c', 'feat', 'd'])
    expect(normalizeText('X (Y Rmx)')).toEqual(['x', 'y', 'remix'])
    expect(normalizeText('A vs. B versus C')).toEqual(['a', 'vs', 'b', 'vs', 'c'])
    expect(normalizeText('A w/ B')).toEqual(['a', 'with', 'b'])
    expect(normalizeText('Pt. 2 part 3')).toEqual(['part', '2', 'part', '3'])
  })
  it('splits on non-alphanumerics and drops empties; null and blank give []', () => {
    expect(normalizeText('Mau P - Neck [BLACK BOOK]')).toEqual(['mau', 'p', 'neck', 'black', 'book'])
    expect(normalizeText('  ')).toEqual([])
    expect(normalizeText(null)).toEqual([])
  })
})

describe('slugWords', () => {
  it('reads the set slug without the date and extension', () => {
    expect(slugWords('https://www.1001tracklists.com/tracklist/2abc/eli-brown-mainstage-ultra-music-festival-miami-united-states-2026-03-28.html'))
      .toBe('eli brown mainstage ultra music festival miami united states')
  })
})

describe('trackKey', () => {
  it('uses the 1001tl id when there is one, else a stable hash of normalized artist + title', async () => {
    expect(await trackKey({ trackId: '909720', artist: 'Mau P', title: 'Neck' })).toBe('t:909720')
    const a = await trackKey({ trackId: null, artist: 'Mau P', title: 'Neck' })
    expect(a).toMatch(/^h:[0-9a-f]{32}$/)
    expect(await trackKey({ trackId: null, artist: 'MAU  P', title: 'neck' })).toBe(a)
    expect(await trackKey({ trackId: 'abc', artist: 'Mau P', title: 'Neck' })).toBe(a)
  })
})
```

  `test/search-schema.test.ts`: open `fakeD1({ migrations: 'search' })` and assert:
  - all seven tables exist;
  - the `tracks_fts` columns are in the order `artist, title, label, djs, set_titles` (read `PRAGMA table_info(tracks_fts)`);
  - a `vocab_fts` trigram MATCH finds `'palmer'` from `'"alm"'`.

  Parser test: the label of a fixture row comes from the row's `trackLabel` span. Take one known row from `tracklist-matroda.html`:
  - Its first row's `publisher` meta carries `Not On Label`, so `label` is `null` (treat "Not On Label" as none).
  - A row with `BLACK BOOK` gives `'BLACK BOOK'`. Find one with `grep -o 'trackLabel noWrap&quot;&gt;&lt;a[^;]*;[^&]*' test/fixtures/tracklist-*.html | head`.
  - An anonymous row's `label` is `null`.
  - `tracks` entries (`ParsedTrack`) have no `label` key: `expect('label' in parsed.tracks[0]).toBe(false)`.

- [ ] **Step 4: Run.** `npx vitest run test/search-normalize.test.ts test/search-schema.test.ts <parser test>`. Expected: FAIL (module missing, label missing).

- [ ] **Step 5: Implement** `src/lib/search/normalize.ts`:

```ts
/**
 * One normalization for both sides of search (spec §9): the text written to
 * the FTS columns and the vocabulary, and the query. Lowercase, diacritics
 * stripped, apostrophes dropped (don't → dont), & → and, "w/" → with, split on
 * anything not a letter or digit, then the synonym map.
 */
const SYNONYMS: Record<string, string> = { ft: 'feat', featuring: 'feat', rmx: 'remix', versus: 'vs', pt: 'part' }

export function normalizeText(s: string | null | undefined): string[] {
  if (!s) return []
  const t = s
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/['’‘`´]/g, '')
    .replace(/&/g, ' and ')
    .replace(/(^|[^\p{L}\p{N}])w\//gu, '$1with ')
  return t
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .map((w) => SYNONYMS[w] ?? w)
}

export const normalizedJoin = (s: string | null | undefined): string => normalizeText(s).join(' ')

/** Words of a 1001tracklists set URL's slug, date and extension dropped. */
export function slugWords(url: string): string {
  const last = url.split(/[?#]/)[0]!.split('/').filter(Boolean).pop() ?? ''
  return normalizedJoin(last.replace(/\.html$/i, '').replace(/-\d{4}-\d{2}-\d{2}$/, '').replace(/-/g, ' '))
}

async function sha256hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s))
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** The index key of a track: its 1001tracklists id, else a hash of normalized artist + title. */
export async function trackKey(t: { trackId: string | null; artist: string; title: string }): Promise<string> {
  if (t.trackId && /^\d{1,12}$/.test(t.trackId)) return `t:${t.trackId}`
  return `h:${(await sha256hex(`${normalizedJoin(t.artist)}\u0000${normalizedJoin(t.title)}`)).slice(0, 32)}`
}
```

  `src/lib/search/db.ts`:

```ts
import type { Env } from '../../types'
/** The search index database (migrations-search/). Throws when the binding is missing. */
export function searchDbOf(env: Env): D1Database {
  if (!env.SEARCH_DB) throw new Error('search_db_missing')
  return env.SEARCH_DB
}
```

  **Parser:** in `parseTracklist`, read each row's label and put it on its `PageRow` only.
  - Source: the visible `span.trackLabel` text in the row. Where the label lives only in the entity-encoded `meta[itemprop=publisher]`, decode that with `decodeEntities` and take the `.trackLabel` text out of it.
  - Several labels: join them with `' / '`.
  - `"Not On Label"` (case-insensitive), empty, or an anonymous row: `null`.
  - Strip `label` before pushing the row into `tracks`, the same way `anonymous` is stripped today (`const { anonymous: _, ...track } = r`). `tracks` must keep the `ParsedTrack` shape.
  - Check with `grep -rn "\.rows\b" src` that no route serialises `rows` into a response or a KV value a test pins. List the hits in your report. `CachedTracklist` gaining a field is acceptable only if no test pins its exact shape; otherwise strip it there too.
  - Leave `fingerprintInput` untouched.

- [ ] **Step 6: Run** the three test files, then `npx vitest run` and `npx tsc --noEmit`. Expected: green.

- [ ] **Step 7: Commit** `Search DB (tracked-search, SEARCH_DB) schema, normalizer and track keys; set-page rows carry their label` plus the trailers.

---

### Task 2: The indexer and its hook on verified fetches

**Model:** opus. This is the sync path; a mistake here costs fetches or index integrity.

**Files:**
- Create: `src/lib/search/index.ts`
- Modify: `src/lib/fetch-scheduler.ts` (`recordSetFetch`: one call after `noteSetFetch`)
- Modify: `src/index.ts` (drain in the `*` middleware next to `drainPageCaptures`; an awaited drain at the end of the `scheduled` `waitUntil` body)
- Test: `test/search-index.test.ts`

**Interfaces:**
- Consumes: `searchDbOf`, `normalizeText`, `normalizedJoin`, `slugWords`, `trackKey` (Task 1); `verifiedFingerprint`, `tracklistFingerprint` (`src/lib/verification.ts`); `extractSetTitle`, `extractSetDate` (`src/lib/mkvid.ts`); `prettifySlug` (`src/lib/sync.ts`; if importing sync.ts into lib/search creates an import cycle, move `prettifySlug` to a small shared module and re-export it from sync.ts); `dbOf` (`src/lib/db.ts`); `PageRow` with `label`.
- Produces:
  - `export type IndexTrack = { trackId: string | null; trackUrl: string | null; artist: string; title: string; label: string | null; cueSeconds: number | null; layered: boolean }`
  - `export type IndexSetInput = { setUrl: string; djSlug: string; djName: string; title: string; setDate: string | null; videoId: string | null; videoSource: string | null; trackCount: number; idedCount: number; source: 'page' | 'mkvid'; tracks: IndexTrack[] }`
  - `export async function indexSet(env: Env, input: IndexSetInput, nowSec: number): Promise<{ tracks: number }>`: one `SEARCH_DB.batch()` plus at most two reads. It throws on DB errors; callers swallow them.
  - `export function tracksFromRows(rows: readonly PageRow[]): IndexTrack[]`: drops `anonymous` and `isUnidentified` rows and rows with an empty artist or title. `cueSeconds` is `ownStartSeconds` on a layered row, otherwise `startSeconds`. Keeps the first occurrence of a `trackKey` per set (dedupe happens in `indexSet`).
  - `export async function indexVerifiedFetch(env: Env, f: { setUrl: string; html: string; parsed: ScrapedTracklist; videoId: string | null; nowSec?: number; log?: Logger }): Promise<'indexed' | 'skipped' | 'not_verified'>`
  - `export function queueSearchIndex(env: Env, f: Parameters<typeof indexVerifiedFetch>[1], outcome: VerificationOutcome | undefined): void`: fire-and-forget. It does nothing unless `outcome` is `'verified'` or `'unchanged'` and `env.SEARCH_DB` is bound. Errors are caught and logged as `log?.warn('search.index_failed', { setUrl, ...errorFields(e) })`.
  - `export async function drainSearchIndex(): Promise<void>`

**`indexVerifiedFetch` steps:**
1. `const fp = await verifiedFingerprint(env, setUrl)`. If `fp` is null or `fp !== await tracklistFingerprint(parsed)`, return `'not_verified'`.
2. One main-DB read for `MIN(t.slug)`, the `artist_name` of that slug, the URL's `video_source`, and the verification time:

   ```sql
   SELECT t.slug AS slug, s.artist_name AS artist_name, t.video_source AS video_source, v.verified_at AS verified_at
     FROM tracklists t
     LEFT JOIN sub_sync s ON s.slug = t.slug
     LEFT JOIN set_verification v ON v.url = t.url
    WHERE t.url = ? AND t.slug IN (SELECT slug FROM subscriptions)
    ORDER BY t.slug LIMIT 1
   ```

   No row means `'not_verified'`.
3. One `SEARCH_DB` read: `SELECT source, indexed_at, video_id FROM search_sets WHERE set_url = ?`. Skip with `'skipped'` when `source = 'page' AND indexed_at >= verified_at AND video_id IS videoId`.
4. Build the input and call `indexSet`.
   - `title`: `extractSetTitle(html) ?? slugWords(setUrl)`.
   - `setDate`: `extractSetDate(setUrl, html)`.
   - `djName`: `artist_name ?? prettifySlug(slug)`.
   - `trackCount`: `parsed.rows.length`.
   - `idedCount`: `parsed.rows.filter(r => !r.anonymous && !r.isUnidentified).length`.
   - `source`: `'page'`.

**`indexSet` (one batch, in this order):**
1. **Read first**, outside the batch: the track keys this set had, `SELECT track_key FROM search_track_sets WHERE set_url = ?`, so their counts and FTS rows get recomputed.
2. **Set row:** upsert `search_sets` (`ON CONFLICT(set_url) DO UPDATE SET` every column). Then `DELETE FROM sets_fts WHERE rowid = (SELECT id FROM search_sets WHERE set_url = ?)` and `INSERT INTO sets_fts (rowid, title, dj, slug_words) SELECT id, ?, ?, ? FROM search_sets WHERE set_url = ?`. The values are `normalizedJoin(title)`, `normalizedJoin(djName) + ' ' + normalizedJoin(djSlug.replace(/[._-]+/g, ' '))` and `slugWords(setUrl)`.
3. **Old links:** `DELETE FROM search_track_sets WHERE set_url = ?`.
4. **Each new track,** first occurrence of a key only:
   - Upsert `search_tracks`: `ON CONFLICT(track_key) DO UPDATE SET artist, title, track_url = COALESCE(excluded.track_url, track_url), label = COALESCE(excluded.label, label), updated_at`. Never overwrite `youtube_link` with null.
   - `INSERT INTO search_track_sets (...)`.
5. **Every touched key** (old ∪ new):
   - `UPDATE search_tracks SET sets_count = (SELECT COUNT(*) FROM search_track_sets WHERE track_key = ?) WHERE track_key = ?`.
   - Refresh its FTS row: `DELETE FROM tracks_fts WHERE rowid = (SELECT id FROM search_tracks WHERE track_key = ?)`, then:

     ```sql
     INSERT INTO tracks_fts (rowid, artist, title, label, djs, set_titles)
     SELECT t.id, ?, ?, ?,
            (SELECT group_concat(DISTINCT f.dj) FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url JOIN sets_fts f ON f.rowid = s.id WHERE ts.track_key = t.track_key),
            (SELECT group_concat(f.title, ' ') FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url JOIN sets_fts f ON f.rowid = s.id WHERE ts.track_key = t.track_key)
       FROM search_tracks t WHERE t.track_key = ? AND t.sets_count > 0
     ```

   - The first three binds are the normalized artist, title and label. For an old key not in the new list, read them in step 1 as well: extend the read to `SELECT ts.track_key, t.artist, t.title, t.label FROM search_track_sets ts JOIN search_tracks t USING (track_key) WHERE ts.set_url = ?`.
6. **Vocabulary:** every distinct normalized term of length ≥ 3 from the set title, the DJ name and each track's artist, title and label.
   - `INSERT INTO search_vocab (term, df) VALUES (?, 1) ON CONFLICT(term) DO UPDATE SET df = df + 1`.
   - Then `INSERT INTO vocab_fts (rowid, term) SELECT id, term FROM search_vocab WHERE term = ? AND id NOT IN (SELECT rowid FROM vocab_fts)`.

**Hook** in `recordSetFetch`, right after `out.verification = await noteSetFetch(...)`:

```ts
      // Search index (lib/search/index.ts): verified lists only, fire-and-forget, drained via waitUntil.
      queueSearchIndex(env, { setUrl: f.setUrl, html: f.html, parsed, videoId: f.videoId, log: f.log }, out.verification.outcome)
```

**Drains** (`src/index.ts`):
- In the `*` middleware, change `c.executionCtx.waitUntil(drainPageCaptures())` to `c.executionCtx.waitUntil(Promise.all([drainPageCaptures(), drainSearchIndex()]))`.
- In `scheduled`, add `await drainSearchIndex()` as the last statement inside the existing `try` of the `waitUntil` body, wrapped in its own `try/catch` so a drain can never fail the tick.

- [ ] **Step 1: Write the failing tests** `test/search-index.test.ts`.
  - Build `env = { DB: fakeD1(), SEARCH_DB: fakeD1({ migrations: 'search' }), CACHE: fakeKV(), SUBS: fakeKV(), ... } as Env`.
  - Seed through SQL inserts: `subscriptions`, `sub_sync.artist_name`, `tracklists` (url, slug, `video_source`), and `set_verification` (state `verified`, `fingerprint = await tracklistFingerprint(parsed)`, `verified_at`).
  - Build `parsed` by hand as a `ScrapedTracklist` whose `rows` are `PageRow`s with labels, and a minimal `html` of `<title>Lilly Palmer @ circuitGROUNDS, EDC Las Vegas, United States 2026-05-16</title>`.

  Tests (names are the contract):
  - **"indexes a verified fetch: set row, tracks, links, FTS rows, vocabulary"**
    - `search_sets` has the title, `dj_name` `'Lilly Palmer'` and `source` `'page'`.
    - `search_tracks` has `t:<id>` with its label.
    - `search_track_sets` has `pos` and `cue_seconds`.
    - `tracks_fts` MATCH `'"lilly"'` on `djs` finds the track.
    - `vocab_fts` MATCH `'"alm"'` finds `palmer`.
  - **"skips a set already indexed since it verified"**
    - Index once, then call `indexVerifiedFetch` again with the same input.
    - It returns `'skipped'` and `search_sets.indexed_at` is unchanged.
    - A third call with a different `videoId` returns `'indexed'`.
  - **"does not index a list whose fingerprint is not the verified one"**: a changed row means `'not_verified'` and no `search_sets` row.
  - **"does not index pending sets"**: `state = 'pending'` means `'not_verified'`.
  - **"a live index replaces a backfilled set's tracks"**
    - `indexSet` with `source: 'mkvid'` and trackId-less tracks (hash keys).
    - Then `indexVerifiedFetch` with the same names carrying ids.
    - `search_track_sets` for the URL holds only `t:` keys, each once.
    - The `h:` tracks have `sets_count = 0` and no `tracks_fts` row.
    - It returns `'indexed'`, not `'skipped'`, even though `indexed_at >= verified_at`.
  - **"a track in two sets aggregates both DJs and set titles"**
    - Index two sets from two DJs that share track id 909720.
    - `sets_count = 2`.
    - `tracks_fts` MATCH `'djs:"brown"'` and `'djs:"palmer"'` both find it.
  - **"a b2b set is indexed under the smallest slug"**
    - Seed the URL under `zeta` and `alpha`, both subscribed.
    - `dj_slug = 'alpha'` and `dj_name` is alpha's `artist_name`.
  - **"anonymous, unidentified and duplicate rows are not indexed"**: an anonymous row, an `isUnidentified` row and a repeated track id give one `search_tracks` row, with `pos` from its first occurrence.
  - **"queueSearchIndex ignores outcomes other than verified/unchanged and a missing SEARCH_DB"**
    - `first`, `mismatch` and `changed` write nothing after `drainSearchIndex()`.
    - With no `SEARCH_DB`, `verified` writes nothing and does not throw.
  - **"a failing index write is swallowed"**
    - `SEARCH_DB.batch` is replaced with one that rejects.
    - `queueSearchIndex(..., 'verified')` followed by `await drainSearchIndex()` resolves, and the logger got `search.index_failed` at warn.
    - `recordSetFetch` with the same failing env returns `verification.outcome === 'verified'`. Seed a pending row from another account so the fetch verifies.

- [ ] **Step 2: Run.** `npx vitest run test/search-index.test.ts`. Expected: FAIL (module missing).

- [ ] **Step 3: Implement** `src/lib/search/index.ts` as specified above.
  - The file header comment states the rules: verified lists only; never from KV; never pruned; re-index replaces the set's links; the recheck skip rule.
  - The pending set mirrors `src/lib/page-store.ts:197-208`:

    ```ts
    const pending = new Set<Promise<unknown>>()
    export function queueSearchIndex(env: Env, f: VerifiedFetch, outcome: VerificationOutcome | undefined): void {
      if (outcome !== 'verified' && outcome !== 'unchanged') return
      if (!env.SEARCH_DB) return
      const p: Promise<unknown> = indexVerifiedFetch(env, f)
        .catch((e) => f.log?.warn('search.index_failed', { setUrl: f.setUrl, ...errorFields(e) }))
        .finally(() => pending.delete(p))
      pending.add(p)
    }
    export async function drainSearchIndex(): Promise<void> {
      while (pending.size) await Promise.allSettled([...pending])
    }
    ```

  - Then wire the hook and the two drains.

- [ ] **Step 4: Run** the new file, then the full suite and `tsc`. Expected: green. The existing `fetch-scheduler`, `sync` and cron tests must pass unchanged. Their envs have no `SEARCH_DB`, so the hook is a no-op there.

- [ ] **Step 5: Commit** `Search index: verified set fetches are indexed in the background (one batch per set, skipped when already indexed since verification), drained via waitUntil` plus the trailers.

---

### Task 3: Query pipeline and `GET /ui/api/search`

**Model:** opus. Ranking quality is the feature.

**Files:**
- Create: `src/lib/search/score.ts` (Damerau-Levenshtein, per-field matching, final score)
- Create: `src/lib/search/query.ts` (expand, recall, re-rank, assemble)
- Create: `src/routes/search.ts` (`searchApp`: `GET /api/search`; Task 4 adds more)
- Modify: `src/routes/subscriptions.ts` (import, plus `subscriptionsApp.route('/', searchApp)` right after the `activityApp` mount)
- Test: `test/search-score.test.ts`, `test/search-query.test.ts`

**Interfaces:**
- Consumes: Task 1 and Task 2 exports (tests index fixtures through `indexSet`).
- Produces:
  - `export function damerauLevenshtein(a: string, b: string, max: number): number`: optimal string alignment distance. It returns `max + 1` as soon as the distance must exceed `max`.
  - `export type MatchKind = 'exact' | 'prefix' | 'corrected'`
  - `export type QueryToken = { text: string; variants: Array<{ term: string; kind: MatchKind; distance: number }> }`
  - `export function tokenFieldScore(token: QueryToken, fieldTokens: readonly string[]): number`: exact 1.0, prefix 0.9, corrected `0.7 - 0.1 * (distance - 1)`, best variant wins, 0 when none matches.
  - `export function rankScore(tokens: QueryToken[], fields: Array<{ tokens: readonly string[]; weight: number }>, boosts: { youtube?: boolean; recencyDays?: number | null; subscribed?: boolean }): number`
    - The base is, per token, the max over fields of `tokenFieldScore × weight`, summed over tokens.
    - That base is multiplied by `(matchedTokens / tokens.length) ** 2`.
    - Then by `1.05` when `youtube`, by `1 + 0.1 * max(0, 1 - recencyDays / 730)`, and by `1.05` when `subscribed`.
  - `export type SearchKind = 'all' | 'sets' | 'tracks' | 'djs'`
  - `export function parseSearchQuery(p: URLSearchParams): { q: string; kind: SearchKind; limit: number; exact: boolean } | { error: string }`
    - `q` is trimmed and capped at 200 chars.
    - `kind` defaults to `all`; any other value is an error.
    - `limit` is an integer from 1 to 20, default 20; anything else is an error.
    - `exact` is `'1'` (skip correction) or absent; anything else is an error.
  - `export async function search(env: Env, q: { q: string; kind: SearchKind; limit: number; exact: boolean }, nowMs?: number): Promise<SearchResponse>`
  - `export type SearchResponse` is the spec's shape exactly, plus nothing:

    ```
    { q, corrected: [{from,to}],
      tracks: [{ trackKey, trackId, artist, title, label, youtubeLink, trackUrl,
                 sets: [{ url, title, djSlug, djName, date, cueSeconds }] }],
      sets: [{ url, title, djSlug, djName, date, videoId, trackCount, idedCount }],
      djs: [{ slug, name, subscribed, sets }] }
    ```

  - Route `GET /ui/api/search` returns:
    - `200 SearchResponse`;
    - `400 { error: 'invalid_request', message }` on bad parameters;
    - `503 { error: 'search_unavailable', message: 'The search index is not bound to this Worker.' }` when `SEARCH_DB` is unbound.

**Pipeline (`search`):**
1. **Normalize.** `tokens = normalizeText(q).slice(0, 8)`, deduped. Empty means an empty response, with `q` echoed.
2. **Expand each token.**
   - Variants: exact; `prefix` when length ≥ 3.
   - Correction runs unless `exact`, and only when the token has length ≥ 3 and is not in `search_vocab`.
   - To correct, take the token's trigrams, query `SELECT v.term AS term, v.df AS df FROM vocab_fts f JOIN search_vocab v ON v.id = f.rowid WHERE vocab_fts MATCH ? LIMIT 50` with the MATCH string `trigrams.map(g => '"' + g + '"').join(' OR ')`.
   - Keep terms with `damerauLevenshtein(token, term, max) <= max`, where `max = token.length >= 7 ? 2 : 1`. Sort by distance, then `df` DESC; keep 5.
   - Push each kept term to `corrected` as `{ from: token, to: term }`, but only the best one per token.
   - For 3-letter tokens the trigram OR is a single trigram and finds only supersets. That is accepted: corrections need length ≥ 4 to be useful.
3. **Build the FTS MATCH for one kind.**
   - Each token becomes a group `("t" OR "t"* OR "c1" OR "c2")`, every term double-quoted with `"` doubled inside. Tokens are `[\p{L}\p{N}]` only after normalization, but quote anyway.
   - Groups are joined with ` AND `.
   - If that recall returns fewer than 10 rows, run again with ` OR ` and merge, dedupe by rowid.
   - Tracks:

     ```sql
     SELECT t.*, f.artist AS n_artist, f.title AS n_title, f.label AS n_label, f.djs AS n_djs, f.set_titles AS n_set_titles,
            bm25(tracks_fts, 3.0, 3.0, 1.0, 2.0, 1.0) AS bm
       FROM tracks_fts f JOIN search_tracks t ON t.id = f.rowid
      WHERE tracks_fts MATCH ? AND t.sets_count > 0
      ORDER BY bm LIMIT 200
     ```

   - Sets: the same over `sets_fts`, with weights `bm25(sets_fts, 3.0, 2.0, 1.0)`.
4. **Re-rank in the Worker** with `rankScore`.
   - Track fields: artist 3, title 3, label 1, djs 2, set_titles 1. These are the `n_*` columns split on spaces and commas.
   - Set fields: title 3, dj 2, slug_words 1.
   - Recency: a track's newest set date (read with its sets in step 5); a set's own date.
   - `subscribed`: the set's `dj_slug` is in the subscription list (for a track, any of its sets' is).
   - Track youtube boost: `youtube_link` is not null. Set boost: `video_id` is not null.
   - Ties break by `bm` ascending, then `id`.
   - Keep `limit` per kind.
5. **Sets of each returned track.** One query for all returned keys:

   ```sql
   SELECT ts.track_key, s.set_url, s.title, s.dj_slug, s.dj_name, s.set_date, ts.cue_seconds
     FROM search_track_sets ts JOIN search_sets s ON s.set_url = ts.set_url
    WHERE ts.track_key IN (...)
    ORDER BY s.set_date DESC, s.set_url
   ```

   Every set is listed ("with every set it appears on"); no cap below 50 per track.
6. **DJs** (kind `all` or `djs`).
   - Read `SELECT s.slug, ss.artist_name FROM subscriptions s LEFT JOIN sub_sync ss ON ss.slug = s.slug` and set counts `SELECT slug, COUNT(*) AS n FROM tracklists WHERE processed = 1 GROUP BY slug` from the main DB.
   - Fields: name (weight 3) and slug words (weight 1). Use the same `QueryToken`s, so a corrected token matches too.
   - Keep `rankScore > 0` with the matched fraction ≥ 0.5, best first, `limit`.
   - `subscribed: true` for all (they come from the subscription list). `trackUrl` for tracks is `track_url`.
7. **Kind filtering.** `kind = tracks` runs only the tracks recall; `sets` only sets; `djs` only DJs. The other groups come back as `[]`.

- [ ] **Step 1: Write failing unit tests** `test/search-score.test.ts`:
  - `damerauLevenshtein('plamer', 'palmer', 2) === 1` (transposition).
  - `('lily', 'lilly', 1) === 1` (insertion).
  - `('dont', 'dont', 1) === 0`.
  - `('eli', 'ultra', 1) > 1` (early exit).
  - `tokenFieldScore`: exact beats prefix, which beats corrected at distance 1, which beats corrected at distance 2. A field without the token gives 0.
  - `rankScore`: two of three tokens matched scores below all three matched with the same per-token scores, by a factor of `(2/3)^2`. The boosts multiply and never apply to a zero score.
  - `parseSearchQuery`: `kind=bogus`, `limit=0`, `limit=21`, `limit=abc` and `exact=2` are errors. Missing `q` gives `''`.

- [ ] **Step 2: Write the failing route tests** `test/search-query.test.ts`.
  - Index the fixture through `indexSet` with `source: 'page'`. Use synthetic, public names. Every distractor is required.

  | set (url slug, date) | dj (slug / name) | tracks (artist - title [label], trackId) |
  |---|---|---|
  | `lilly-palmer-circuitgrounds-edc-las-vegas-united-states-2026-05-16` | `lillypalmer` / Lilly Palmer | `Rian Wood & Version 34 - Don't Stop [RAVE WORLD]` (1001), `Mau P - Neck [BLACK BOOK]` (2002), `Lilly Palmer - Before I Go [Spannung]` (1003) |
  | `lilly-palmer-awakenings-festival-netherlands-2025-06-28` | `lillypalmer` / Lilly Palmer | `Lilly Palmer - Before I Go [Spannung]` (1003), `Amelie Lens - Feel It [LENSKE]` (1004) |
  | `eli-brown-mainstage-ultra-music-festival-miami-united-states-2026-03-28` | `elibrown` / Eli Brown | `Mau P - Neck [BLACK BOOK]` (2002), `Eli Brown - Me & U [Repopulate Mars]` (1005) |
  | `eli-brown-mainstage-ultra-music-festival-miami-united-states-2025-03-29` | `elibrown` / Eli Brown | `Eli Brown - Diamonds [Repopulate Mars]` (1006) |
  | `eli-brown-hi-ibiza-spain-2026-07-04` | `elibrown` / Eli Brown | `Mau P - Neck [BLACK BOOK]` (2002) |
  | `john-summit-ultra-music-festival-miami-united-states-2026-03-29` | `johnsummit` / John Summit | `Dom Dolla - Don't Stop [Sweat It Out]` (1007), `Neck Deep - December [Hopeless]` (1008) |

  - Each set's title is the 1001tl-style `<title>` text, for example `Eli Brown @ Mainstage, Ultra Music Festival Miami, United States 2026-03-28`.
  - Seed `subscriptions` and `sub_sync` in the main DB for the three DJs.

  Tests:
  - **"lily plamer dont ranks Rian Wood & Version 34 - Don't Stop in the top 3 tracks, above Dom Dolla's Don't Stop"**
    - `corrected` contains `{ from: 'lily', to: 'lilly' }` and `{ from: 'plamer', to: 'palmer' }`.
  - **"Eli Brown Ultra ranks the Ultra Miami 2026 set first"**
    - `sets[0].url` is the 2026-03-28 URL.
    - The 2025 Ultra set ranks above Hi Ibiza and above John Summit's Ultra set.
  - **"mau p neck returns Mau P - Neck with every set it appears on"**
    - `tracks[0].trackKey === 't:2002'`, `label === 'BLACK BOOK'`.
    - `sets` has exactly the three URLs, newest first.
    - Neck Deep - December is not first.
  - **"djs match subscription names with corrections"**: `q=eli brwn` returns `djs[0].slug === 'elibrown'` with `sets` from `tracklists`.
  - **"exact=1 skips correction"**: `q=plamer&exact=1` gives `corrected: []` and no Lilly Palmer track first.
  - **"kind=sets returns only sets"**: `tracks` and `djs` are `[]`.
  - **"orphan tracks are not returned"**: set one track's `sets_count = 0` and remove its links; a query for its title does not return it.
  - **"FTS syntax in the query is inert"**: each of `'"'`, `'neck*'`, `'(mau'`, `'mau -neck'`, `'title:neck'`, `'NEAR(mau neck)'`, `'AND'` and `'mau AND OR neck'` returns 200.
  - **"an empty q is 200 with empty groups; bad kind is 400; no SEARCH_DB is 503"**
  - **"Access guards /ui/api/search"**: extend the Access-gate sweep in the existing gate test (`grep -rln "ui/api/activity" test`) with `/ui/api/search`.

  - Route tests call `app.request('/ui/api/search?q=…', {}, env)` the way `test/activity.test.ts` does.

- [ ] **Step 3: Run** both files. Expected: FAIL.

- [ ] **Step 4: Implement** `score.ts`, `query.ts` and `routes/search.ts`, then mount the app. The header comment in `query.ts` describes the pipeline steps above in four or five lines.

- [ ] **Step 5: Run** both files, then the full suite and `tsc`. Expected: green. If an acceptance test fails, fix the scorer, not the fixture. Report any weight you changed and why.

- [ ] **Step 6: Commit** `Search API: normalized, corrected query over the FTS5 index, re-ranked in the Worker (tracks with every set, sets, DJs)` plus the trailers.

---

### Task 4: Backfill, index status, links write-back

**Model:** sonnet.

**Files:**
- Create: `src/lib/search/backfill.ts`
- Modify: `src/routes/search.ts` (`GET /api/search/status`, `POST /api/search/backfill`)
- Modify: `src/routes/subscriptions.ts` (the lazy-links handler: write back found YouTube links)
- Modify: `src/ui/pages/tools.ts` (a "Search index" card)
- Test: `test/search-backfill.test.ts`; extend `test/ui-pages.test.ts` (Tools card ids)

**Interfaces:**
- Consumes: `indexSet`, `IndexTrack`, `searchDbOf` (Tasks 1 and 2); `prettifySlug`.
- Produces:
  - `export async function backfillSearch(env: Env, opts: { cursor: string | null; limit: number; deadlineMs: number; nowSec?: number }): Promise<{ indexed: number; skipped: number; cursor: string | null; done: boolean }>`
  - `export async function searchIndexStatus(env: Env): Promise<{ sets: number; tracks: number; vocab: number; lastIndexedAt: number | null }>`
  - `export async function noteTrackYoutubeLinks(env: Env, links: Record<string, { youtubeLink: string | null }>): Promise<void>`. It runs `UPDATE search_tracks SET youtube_link = ? WHERE track_id = ? AND (youtube_link IS NULL OR youtube_link <> ?)` for each id with a link, in one batch. Errors are swallowed.
  - Routes:
    - `GET /ui/api/search/status` returns `{ sets, tracks, vocab, lastIndexedAt }`.
    - `POST /ui/api/search/backfill`, body `{ cursor?: string | null, limit?: number }`, returns `{ indexed, skipped, cursor, done }`.
      - A `limit` outside 1 to 500 is a 400 `invalid_request`.
      - A `cursor` that is not a string or null is a 400.
      - The default `limit` is 500.
      - The deadline is `Date.now() + 20_000`.
    - Both routes return 503 `search_unavailable` without `SEARCH_DB`.

**Backfill rules** (put them in the file header):
- **Source:**

  ```sql
  SELECT r.set_url, r.slug, r.artist_name, r.set_title, r.set_date, r.video_id, k.tracks, k.track_count, v.verified_at
    FROM mkvid_request_tracks k
    JOIN mkvid_requests r ON r.id = k.request_id
    JOIN set_verification v ON v.url = r.set_url AND v.state = 'verified'
   WHERE k.trusted = 1 AND r.set_url > ?
   ORDER BY r.set_url LIMIT ?
  ```

  - The cursor is the last `set_url` handled; `''` starts from the beginning.
  - Comment why `trusted = 1` with `verified` stands in for the fingerprint match (deviation 4 above).
  - Never read KV. Never run on the cron.
- **Skip** (counts as `skipped`, no writes): a `search_sets` row exists with `source = 'page'`, or with `source = 'mkvid'` and `indexed_at >= verified_at`. Read existing rows for the whole page in one `SELECT … WHERE set_url IN (…)` (chunk at 50 binds).
- **Tracks:** parse `tracks` JSON defensively (`parseJson`, array check). Keep rows with `!isId` and non-empty `artist` and `title`.
  - `trackId: null`, `trackUrl: null`, `label: null`.
  - `cueSeconds`: the row's `cueSeconds`. `layered`: the row's `layered`.
  - `trackCount: k.track_count`, `idedCount`: the number of non-`isId` rows, `source: 'mkvid'`.
  - `title: set_title ?? slugWords(set_url)`.
  - `djName: artist_name ?? prettifySlug(slug)`, `djSlug: slug`, `videoSource: 'mkvid'` when `video_id` is set, else null.
- **One `indexSet` per set**, sequential. Check `Date.now() >= deadlineMs` before each set; on the deadline, return `done: false` with the cursor of the last finished set.
- **Errors:** an `indexSet` error on one set is logged at warn (`search.backfill_set_failed`), counted as skipped, and the backfill moves on.
- **Done:** `done: true` when the page returned fewer than `limit` rows and the loop finished.

**Links write-back:** in `POST /api/tracklist/links`, after the loop (and in the 502 partial branch, before returning), run `await noteTrackYoutubeLinks(c.env, links)` inside `try { … } catch {}`. It does nothing when `SEARCH_DB` is unbound. `/now-playing`'s `resolveLinks` is not touched.

**Tools card**, between "Migration status" and the end. Keep the card style of `tools.ts`:

```html
<div class="tk-card" id="search-card">
  <h2>Search index</h2>
  <p class="muted tl-note">Verified track lists are indexed as they verify. Rebuild adds sets from trusted mkvid track lists, 500 per press.</p>
  <dl class="kv" id="si-stats"><dt>Sets</dt><dd id="si-sets">—</dd><dt>Tracks</dt><dd id="si-tracks">—</dd><dt>Last indexed</dt><dd id="si-last">—</dd></dl>
  <button class="btn primary" id="si-rebuild" type="button">Rebuild 500 more</button>
  <div class="tl-status muted" id="si-status" role="status"></div>
</div>
```

- If `dl.kv` is not an existing class, use the phase-2 `dl` style from `ACTIVITY_DETAIL_CSS`, or plain `<p>` lines. Do not add a new component.
- JS on load: `TK.api.get('/ui/api/search/status')` fills the counts; a 503 shows "Search index not bound".
- The button runs `TK.busy(btn, 'Rebuilding…', …)` posting `{ cursor, limit: 500 }`, keeps the returned `cursor` in a page variable, refreshes the counts, and says "Indexed N, skipped M." plus "Done: every trusted list is indexed." or "Press again for more."
- Errors use `TK.errText`.

- [ ] **Step 1: Write the failing tests** `test/search-backfill.test.ts`:
  - **"backfills trusted lists of verified sets only"**: seed three mkvid requests with tracks:
    - trusted + verified is indexed with `source = 'mkvid'` and hash keys;
    - trusted but verification pending is not;
    - untrusted + verified is not.
  - **"skips sets already indexed from a page"**: it returns `skipped: 1` and makes no writes. Compare `search_sets.indexed_at` before and after.
  - **"pages with a keyset cursor"**: with `limit: 1`, the first call returns the first URL as `cursor` and `done: false`, and the next call continues.
  - **"stops at the deadline with a cursor"**: with `deadlineMs: Date.now() - 1`, it returns `{ indexed: 0, done: false }` and a cursor equal to the input cursor.
  - **"rejects a bad limit"**: the route with `limit: 0`, `501` or `'x'` returns 400.
  - **"status counts sets and tracks"**
  - **"lazy links write found YouTube links back to the index"**
    - Stub `resolveTrackMediaLinks` the way the existing links-route test does (`grep -rn "tracklist/links" test`).
    - After the call, `search_tracks.youtube_link` is set for `t:<id>`.
    - Without `SEARCH_DB` the route still returns 200.
  - **"the backfill route requires same-origin JSON"**: covered by the `sameOriginJson` mount on `/ui/api/*`. Add one assertion that a POST without `content-type: application/json` gets the guard's rejection, as other same-origin tests do.

  In `test/ui-pages.test.ts`, the Tools page contains `id="si-rebuild"` and its script runs in `minimalStub()`.

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the module, the routes, the write-back and the card.
- [ ] **Step 4: Run** the new tests, then the full suite and `tsc`. Expected: green.
- [ ] **Step 5: Commit** `Search index: Tools card with counts and a 500-set rebuild from trusted mkvid lists; lazy links write YouTube links back to the index` plus the trailers.

---

### Task 5: Search page, shell search box, README

**Model:** sonnet.

**Files:**
- Create: `src/ui/pages/search.ts` (`SEARCH_PAGE: UiPage`, `SEARCH_JS`, `SEARCH_CSS`)
- Modify: `src/routes/search.ts` (`GET /search` serves the page with `servePage`)
- Modify: `src/ui/shell.ts` (`SEARCH_HREF = '/ui/search'`; the top form becomes `action="/ui/search"`, placeholder and aria-label `Search tracks, sets, DJs`, `name="q"` kept; fix the comment that says "until the Search page ships")
- Modify: `src/ui/runtime.ts` (`TK.api.get(path, opts?)` passes `opts.signal` to `fetch`; an aborted request resolves to `{ ok: false, status: 0, aborted: true }` with no toast, and never throws)
- Modify: `test/ui-pages.test.ts` (shell form assertions at lines 58-62 and 72; `PAGES` gains `['/ui/search', 'Search']`), `test/same-origin.test.ts` (`pages` gains `'/ui/search'`)
- Modify: `README.md` (a Search section: what is indexed and when, the Tools rebuild, the separate DB and why, `npx wrangler d1 migrations apply tracked-search --remote`)
- Test: `test/search-page.test.ts`

**Interfaces:**
- Consumes: `GET /ui/api/search` and its `SearchResponse` (Task 3); `TRACK_ROW_JS`'s `lazyLinkButton` and `fetchLinks` from `src/ui/pages/track-row.ts` for the per-track "links" button.
- Produces:
  - `SEARCH_PAGE = { path: '/search', html: shell({ nav: 'search', title: 'Search', … }) }`
  - The page script defines `renderResults(data, groupKind)`, `highlight(text, tokens)` and `searchUrl(q, kind, exact)`.

**Page behaviour (spec §6 "Search"):**
- **The input.** `<input id="sq" type="search" autofocus aria-label="Search tracks, sets, DJs" placeholder="Track, set or DJ">` is prefilled from `TK.qs.get('q')`, and a non-empty value searches on load. It searches as you type with a 150 ms debounce (`setTimeout`/`clearTimeout`). Each new request aborts the previous one when `typeof AbortController !== 'undefined'`, and a sequence number guards out-of-order replies either way.
- **Query string.** `q` and `kind` are mirrored to the URL with `history.replaceState`, guarded by `typeof history !== 'undefined'`.
- **Group tabs.** `All / Tracks / Sets / DJs` are `.tk-chip` buttons with `aria-pressed`. "All" shows three sections (Tracks, Sets, DJs), each with up to 5 rows and a "Show all N" link that switches the tab. A tab other than All requests `kind=<tab>`.
- **Corrected-query notice.** When `corrected` is non-empty, `#sq-corrected` shows "Showing results for **lilly palmer dont**." plus a "Search exactly for lily plamer dont" button that re-runs with `exact=1`.
- **Highlights.** `highlight()` escapes first, then wraps each case-insensitive, diacritic-insensitive match of a query token or its correction in `<mark>`, over the escaped text. Do it by normalizing a copy for matching and mapping indexes back, or match on the escaped text with a regex built from escaped tokens. It must never inject markup from data. Test it with `<b>` in a title.
- **Track result.** Artist – title, then the label as a muted badge.
  - Links: 1001tracklists track (`TK.safeHref(trackUrl)`); YouTube when `youtubeLink`, else the lazy "links" button (only when `trackId` is numeric).
  - Then "N sets", expandable. Each set line has the DJ, the date, the cue `TK.fmt.clock(cueSeconds)`, a "Set page" link (`/ui/set?url=` + `encodeURIComponent`) and a 1001tl link.
- **Set result.** Title, DJ (link `/ui/dj/<slug>`), date, completeness `idedCount/trackCount IDs`, a video badge (`ok` when `videoId`, else `warn` "no video"), a Set page link and a 1001tl link.
- **DJ result.** Name, a "subscribed" badge, the set count and a profile link `/ui/dj/<slug>`.
- **Keyboard.**
  - Up and Down move a highlighted result (`aria-activedescendant` on the input, `role="listbox"` and `role="option"` on rows). Enter opens its primary link (track: Set page of its newest set; set: Set page; DJ: profile).
  - Escape clears the input.
  - `/` from the shell focuses `#tk-search`. On the Search page, focus `#sq` instead: when `#sq` exists, the shell's handler focuses it. Change `SHELL_JS` to prefer `#sq`, then `#tk-search`.
- **Empty states.** No query: "Search every verified track list: tracks, sets and DJs." No results: "Nothing found for …". A 503: "The search index is not set up on this Worker." Other errors: `TK.errText`.
- **Layout.** Width from the shell. Result rows are cards in one column, with chips wrapping under 800px. Use the phase-2 `.tk-chip` and the badge classes; add only `mark` styling (`background: var(--accent-soft); color: inherit`).

- [ ] **Step 1: Write the failing tests** `test/search-page.test.ts`. Extract `SEARCH_PAGE`'s page script and run it in a richer stub. Copy the `scriptsOf` and stub style from `test/activity-page` tests (`grep -ln "ACTIVITY_PAGE" test`).
  - **"renders the three groups from a response, escaped and highlighted"**: a `SearchResponse` fixture with a `<b>x</b>` title shows `&lt;b&gt;` and a `<mark>` around the query token.
  - **"shows the corrected notice with a search-exactly button that requests exact=1"**: capture the `fetch` URL.
  - **"debounces typing and drops a stale reply"**: fire two inputs and resolve the second reply before the first; the first reply's rows never render.
  - **"a track with no YouTube link and a numeric id gets a links button; one with a link gets a YouTube pill"**
  - **"tabs request kind= and All shows Show all links"**
  - The page script runs in `minimalStub()`: covered by adding the page to `PAGES`.
  - `shell()`: the form is `action="/ui/search"` with `name="q"`. `SEARCH_HREF` is `/ui/search`. The phone tabs still list Home, DJs, Search, mkvid and Pool, and Search's tab links to `/ui/search`.

- [ ] **Step 2: Run them.** Expected: FAIL.
- [ ] **Step 3: Implement** the page, the route, the shell changes and the runtime `signal` support. Then write the README section.
- [ ] **Step 4: Run** the new tests, then the full suite and `tsc`. Expected: green.
- [ ] **Step 5: Screenshots.** Use `npx wrangler dev` with a local seed: apply `migrations-search` with `npx wrangler d1 migrations apply tracked-search --local`, then insert the Task 3 fixture with a script under `.superpowers/sdd/2026-10-01-tracked-ui-phase3/`. Then use the gstack `/browse` skill (never `mcp__claude-in-chrome__*`) to shoot `/ui/search?q=mau%20p%20neck` and `?q=lily%20plamer%20dont` at 1440px and 390px. Fix what is squeezed or clipped. Put the paths in the report.
- [ ] **Step 6: Commit** `Search page: results as you type grouped by tracks, sets and DJs, keyboard navigation, highlights and the corrected-query notice; the top bar searches` plus the trailers.

---

## Deploy gate (controller, after the final whole-branch review)

1. Rebase `new-ui` on `origin/main`; `npm install` if the lockfile moved; run vitest and tsc.
2. Check the migrations:
   - `npx wrangler d1 migrations list tracked-search --remote` should show `0001_search.sql` pending.
   - `npx wrangler d1 migrations list tracked --remote`: nothing of ours pending (0013 is the pool session's).
3. With the owner's ok, apply `npx wrangler d1 migrations apply tracked-search --remote`. There is no export: the database is new, empty and rebuildable.
4. Push `main` only with the owner's explicit ok (the push deploys).
5. After the deploy:
   - Probe that `/ui/search` and `/ui/api/search` redirect to the Access login.
   - Ask the owner to press "Rebuild 500 more" until done, then try the three acceptance queries live on desktop and phone.
   - The index fills further as rechecks verify sets.
