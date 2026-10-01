/**
 * The search scorer (src/lib/search/score.ts) and the query parser
 * (src/lib/search/query.ts): pure functions, no database.
 */
import { describe, expect, it } from 'vitest'
import { damerauLevenshtein, rankScore, tokenFieldScore, type QueryToken } from '../src/lib/search/score'
import { parseSearchQuery } from '../src/lib/search/query'

const tok = (text: string, ...corrections: Array<[string, number]>): QueryToken => ({
  text,
  variants: [
    { term: text, kind: 'exact', distance: 0 },
    ...(text.length >= 3 ? [{ term: text, kind: 'prefix' as const, distance: 0 }] : []),
    ...corrections.map(([term, distance]) => ({ term, kind: 'corrected' as const, distance })),
  ],
})

describe('damerauLevenshtein', () => {
  it('counts a transposition as one edit', () => expect(damerauLevenshtein('plamer', 'palmer', 2)).toBe(1))
  it('counts an insertion as one edit', () => expect(damerauLevenshtein('lily', 'lilly', 1)).toBe(1))
  it('is 0 for equal strings', () => expect(damerauLevenshtein('dont', 'dont', 1)).toBe(0))
  it('exits early once the distance must exceed max', () => {
    expect(damerauLevenshtein('eli', 'ultra', 1)).toBeGreaterThan(1)
    expect(damerauLevenshtein('eli', 'ultra', 1)).toBe(2)
    expect(damerauLevenshtein('abcdef', 'uvwxyz', 2)).toBe(3)
  })
  it('handles empty strings and substitutions', () => {
    expect(damerauLevenshtein('', 'ab', 5)).toBe(2)
    expect(damerauLevenshtein('brown', 'brawn', 2)).toBe(1)
    expect(damerauLevenshtein('summit', 'sumit', 1)).toBe(1)
  })
})

describe('tokenFieldScore', () => {
  it('ranks exact > prefix > corrected at distance 1 > corrected at distance 2, and 0 when absent', () => {
    const exact = tokenFieldScore(tok('palmer'), ['lilly', 'palmer'])
    const prefix = tokenFieldScore(tok('palm'), ['lilly', 'palmer'])
    const d1 = tokenFieldScore(tok('plamer', ['palmer', 1]), ['lilly', 'palmer'])
    const d2 = tokenFieldScore(tok('plamerr', ['palmer', 2]), ['lilly', 'palmer'])
    expect(exact).toBe(1)
    expect(prefix).toBe(0.9)
    expect(d1).toBeCloseTo(0.7)
    expect(d2).toBeCloseTo(0.6)
    expect(exact).toBeGreaterThan(prefix)
    expect(prefix).toBeGreaterThan(d1)
    expect(d1).toBeGreaterThan(d2)
    expect(tokenFieldScore(tok('neck'), ['mau', 'p'])).toBe(0)
  })
  it('takes the best variant', () => {
    expect(tokenFieldScore(tok('neck', ['deck', 1]), ['neck', 'deck'])).toBe(1)
  })
  it('a short token has no prefix variant', () => {
    expect(tokenFieldScore(tok('p'), ['palmer'])).toBe(0)
    expect(tokenFieldScore(tok('p'), ['mau', 'p'])).toBe(1)
  })
})

describe('rankScore', () => {
  const tokens = [tok('mau'), tok('p'), tok('neck')]
  it('scales by the squared matched fraction', () => {
    const all = rankScore(tokens, [{ tokens: ['mau', 'p'], weight: 3 }, { tokens: ['neck'], weight: 3 }], {})
    const two = rankScore(tokens, [{ tokens: ['mau', 'p'], weight: 3 }, { tokens: ['december'], weight: 3 }], {})
    expect(all).toBeCloseTo(9)
    // Same per-token scores (3 each): two matched is 6 × (2/3)², all three is 9 × 1.
    expect(two).toBeCloseTo(6 * (2 / 3) ** 2)
    expect(two / ((all * 2) / 3)).toBeCloseTo((2 / 3) ** 2)
  })
  it('takes the best field per token', () => {
    expect(rankScore([tok('neck')], [{ tokens: ['neck'], weight: 1 }, { tokens: ['neck'], weight: 3 }], {})).toBeCloseTo(3)
  })
  it('multiplies the boosts, and never boosts a zero score', () => {
    const fields = [{ tokens: ['neck'], weight: 3 }]
    const base = rankScore([tok('neck')], fields, {})
    expect(rankScore([tok('neck')], fields, { youtube: true })).toBeCloseTo(base * 1.05)
    expect(rankScore([tok('neck')], fields, { subscribed: true })).toBeCloseTo(base * 1.05)
    expect(rankScore([tok('neck')], fields, { recencyDays: 0 })).toBeCloseTo(base * 1.1)
    expect(rankScore([tok('neck')], fields, { recencyDays: 365 })).toBeCloseTo(base * 1.05)
    expect(rankScore([tok('neck')], fields, { recencyDays: 1000 })).toBeCloseTo(base)
    expect(rankScore([tok('neck')], fields, { recencyDays: null })).toBeCloseTo(base)
    expect(rankScore([tok('neck')], fields, { youtube: true, recencyDays: 0, subscribed: true })).toBeCloseTo(base * 1.05 * 1.1 * 1.05)
    expect(rankScore([tok('deck')], fields, { youtube: true, recencyDays: 0, subscribed: true })).toBe(0)
    expect(rankScore([], fields, { youtube: true })).toBe(0)
  })
})

describe('parseSearchQuery', () => {
  const p = (s: string) => parseSearchQuery(new URLSearchParams(s))
  it('defaults', () => expect(p('')).toEqual({ q: '', kind: 'all', limit: 20, exact: false }))
  it('trims and caps q at 200 characters', () => {
    expect(p('q=%20%20mau%20p%20')).toMatchObject({ q: 'mau p' })
    expect((p('q=' + 'a'.repeat(300)) as { q: string }).q).toHaveLength(200)
  })
  it('accepts every kind, a limit of 1..20 and exact=1', () => {
    for (const kind of ['all', 'sets', 'tracks', 'djs']) expect(p(`kind=${kind}`)).toMatchObject({ kind })
    expect(p('limit=1')).toMatchObject({ limit: 1 })
    expect(p('limit=20')).toMatchObject({ limit: 20 })
    expect(p('exact=1')).toMatchObject({ exact: true })
  })
  it('rejects bad parameters', () => {
    for (const bad of ['kind=bogus', 'kind=', 'limit=0', 'limit=21', 'limit=abc', 'limit=1.5', 'limit=', 'exact=2', 'exact=']) {
      expect(p(bad), bad).toHaveProperty('error')
    }
  })
})
