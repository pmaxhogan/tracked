import { describe, it, expect } from 'vitest'
import { fakeD1 } from './helpers/fake-d1'

describe('search schema (migrations-search/)', () => {
  const tables = ['search_sets', 'search_tracks', 'search_track_sets', 'search_vocab', 'sets_fts', 'tracks_fts', 'vocab_fts']

  it('creates all seven tables', async () => {
    const db = fakeD1({ migrations: 'search' })
    const { results } = await db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all<{ name: string }>()
    const names = results.map((r) => r.name)
    for (const t of tables) expect(names).toContain(t)
  })

  it('tracks_fts columns are in bm25 weight order', async () => {
    const db = fakeD1({ migrations: 'search' })
    const { results } = await db.prepare('PRAGMA table_info(tracks_fts)').all<{ name: string }>()
    expect(results.map((r) => r.name)).toEqual(['artist', 'title', 'label', 'djs', 'set_titles'])
  })

  it('a vocab_fts trigram MATCH finds palmer from "alm"', async () => {
    const db = fakeD1({ migrations: 'search' })
    await db.prepare("INSERT INTO vocab_fts(rowid, term) VALUES (1, 'palmer'), (2, 'neck')").run()
    const { results } = await db.prepare(`SELECT term FROM vocab_fts WHERE vocab_fts MATCH '"alm"'`).all<{ term: string }>()
    expect(results.map((r) => r.term)).toEqual(['palmer'])
  })
})
