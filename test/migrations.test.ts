/**
 * Migrations 0007-0009 (and later) applied, in order, on a database that
 * already holds production-shaped data from 0001-0006: the upgrade path the
 * deploy takes. (A fresh database is what every other test file uses.)
 */
import { describe, it, expect } from 'vitest'
import initSqlJs from 'sql.js'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'migrations')
const SQL = await initSqlJs()
const files = readdirSync(DIR).filter((f) => f.endsWith('.sql')).sort()
const upTo = (n: number) => files.filter((f) => Number(f.slice(0, 4)) <= n)
const after = (n: number) => files.filter((f) => Number(f.slice(0, 4)) > n)

function rows(db: InstanceType<typeof SQL.Database>, sql: string): Record<string, unknown>[] {
  const r = db.exec(sql)[0]
  if (!r) return []
  return r.values.map((v) => Object.fromEntries(r.columns.map((c, i) => [c, v[i]])))
}

describe('migrations on a copy of the pre-pool schema with data', () => {
  it('0013 counts the base and timed rows of stored lists ("w/" rows not counted, row 0 always timed)', () => {
    const db = new SQL.Database()
    for (const f of upTo(12)) db.exec(readFileSync(join(DIR, f), 'utf8'))
    const t = (cueSeconds: number | null, layered = false) => ({ cueSeconds, artist: 'A', title: 'T', artworkUrl: null, isId: false, layered })
    const tracks = JSON.stringify([t(null), t(null), t(120.5), t(null, true), t(300)])
    db.exec(`INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, named, mismatched, scraped_at) VALUES ('r1', '${tracks}', 5, 1, 3, 0, 1)`)
    for (const f of after(12)) db.exec(readFileSync(join(DIR, f), 'utf8'))
    expect(rows(db, 'SELECT base_rows, timed_rows FROM mkvid_request_tracks')).toEqual([{ base_rows: 4, timed_rows: 3 }])
  })

  it('are numbered without gaps or duplicates', () => {
    const nums = files.map((f) => Number(f.slice(0, 4)))
    expect(nums).toEqual(nums.map((_, i) => i + 1))
  })

  it('0007+ apply over 0001-0006 data: old trusted lists are reset (review W4 #1) and 0009 backfills the row counts', () => {
    const db = new SQL.Database()
    for (const f of upTo(6)) db.exec(readFileSync(join(DIR, f), 'utf8'))
    // Production-shaped rows from before the pool: a queued request whose list was trusted on the in-page check alone.
    const tracks = JSON.stringify([
      { cueSeconds: 0, artist: 'A', title: 'T', artworkUrl: null, isId: false, layered: false },
      { cueSeconds: 60, artist: null, title: null, artworkUrl: null, isId: true, layered: false },
      { cueSeconds: 120, artist: 'B', title: 'U', artworkUrl: null, isId: false, layered: false },
    ])
    db.exec(`INSERT INTO mkvid_requests (id, slug, set_url, source, source_url, track_count, ided_count, status, created_at, updated_at)
             VALUES ('r1', 'dj', 'https://www.1001tracklists.com/tracklist/abc/x-2026-01-01.html', 'soundcloud', 'https://api.soundcloud.com/tracks/1', 2, 2, 'pending', 1, 1)`)
    db.exec(`INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, named, mismatched, scraped_at) VALUES ('r1', '${tracks}', 3, 1, 3, 0, 1)`)
    db.exec(`INSERT INTO tracklists (slug, url, processed, abandoned, checked_at, position, discovered_at) VALUES ('dj', 'https://www.1001tracklists.com/tracklist/abc/x-2026-01-01.html', 1, 0, 5, 0, 1)`)

    for (const f of after(6)) db.exec(readFileSync(join(DIR, f), 'utf8'))

    expect(rows(db, 'SELECT trusted, id_rows FROM mkvid_request_tracks')).toEqual([{ trusted: 0, id_rows: 1 }])
    // 0013: all three rows are base rows and timed.
    expect(rows(db, 'SELECT base_rows, timed_rows FROM mkvid_request_tracks')).toEqual([{ base_rows: 3, timed_rows: 3 }])
    expect(rows(db, 'SELECT track_count, ided_count, skip_id_wait FROM mkvid_requests')).toEqual([{ track_count: 3, ided_count: 2, skip_id_wait: 0 }])
    // The pool-era tables exist and the old rows are untouched.
    for (const t of ['set_schedule', 'set_verification', 'dj_schedule', 'pool_events', 'set_media_facts', 'mkvid_old_videos']) {
      expect(rows(db, `SELECT name FROM sqlite_master WHERE type = 'table' AND name = '${t}'`)).toHaveLength(1)
    }
    expect(rows(db, 'SELECT checked_at FROM tracklists')).toEqual([{ checked_at: 5 }])
  })
})
