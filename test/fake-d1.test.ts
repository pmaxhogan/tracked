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
