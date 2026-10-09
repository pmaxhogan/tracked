import { describe, it, expect } from 'vitest'
import { Hono } from 'hono'
import { fakeD1 } from './helpers/fake-d1'
import {
  parseTableQuery, runTableQuery, runLocalTable, tableResponse, localTableResponse, buildTableSql,
  TableQueryError, tableErrorBody, type TableDef, type TableQuery,
} from '../src/lib/table-query'

type Row = { id: number; name: string | null; n: number | null; at_ms: number | null; at_s: number | null; at_iso: string | null; day: string | null; stage: string | null; tags: string | null; flag: number | null; base: number | null }

// Fixed rows, NULLs in every column, mixed case, wildcard characters, a w/ group.
const ROWS: Row[] = [
  { id: 1, name: 'Alpha', n: 10, at_ms: 1_700_000_000_000, at_s: 1_700_000_000, at_iso: '2023-11-14T22:13:20.000Z', day: '2026-01-05', stage: 'found', tags: ',spotify,apple,', flag: 1, base: null },
  { id: 2, name: 'beta', n: 5, at_ms: 1_700_000_100_000, at_s: 1_700_000_100, at_iso: '2023-11-14T22:15:00.000Z', day: '2026-01-06', stage: 'links', tags: ',spotify,', flag: 0, base: null },
  { id: 3, name: 'Gamma 100%', n: null, at_ms: null, at_s: null, at_iso: null, day: null, stage: null, tags: null, flag: null, base: null },
  { id: 4, name: 'alpha two', n: 10, at_ms: 1_700_000_050_000, at_s: 1_700_000_050, at_iso: '2023-11-14T22:14:10.000Z', day: '2026-01-05', stage: 'found', tags: ',youtube,', flag: 1, base: null },
  { id: 5, name: 'w/ child of beta', n: 99, at_ms: 1_600_000_000_000, at_s: 1_600_000_000, at_iso: '2020-09-13T12:26:40.000Z', day: '2025-12-31', stage: 'identify', tags: ',none,', flag: 0, base: 2 },
  { id: 6, name: 'delta_x', n: -3, at_ms: 1_800_000_000_000, at_s: 1_800_000_000, at_iso: '2027-01-15T08:00:00.000Z', day: '2027-01-15', stage: 'links', tags: '', flag: 1, base: null },
  { id: 7, name: null, n: 0, at_ms: 1_700_000_000_000, at_s: 1_700_000_000, at_iso: '2023-11-14T22:13:20.000Z', day: '2026-01-05', stage: 'found', tags: ',apple,', flag: 0, base: null },
  { id: 8, name: 'w/ second child', n: 1, at_ms: 1_650_000_000_000, at_s: 1_650_000_000, at_iso: '2022-04-15T05:20:00.000Z', day: '2026-02-01', stage: 'links', tags: ',spotify,youtube,', flag: 1, base: 2 },
]

const DEF: TableDef<Row> = {
  from: 'tq_t',
  primaryKey: 'id',
  defaultSort: '-id',
  columns: {
    id: { type: 'number' },
    name: { type: 'text', searchable: true },
    n: { type: 'number' },
    atMs: { sql: 'at_ms', type: 'datetime', get: (r) => r.at_ms },
    atS: { sql: 'at_s', type: 'datetime', storage: 's', get: (r) => r.at_s },
    atIso: { sql: 'at_iso', type: 'datetime', storage: 'iso', get: (r) => r.at_iso },
    day: { type: 'date' },
    stage: { type: 'enum', options: ['identify', 'links', 'found'], searchable: true },
    tags: { type: 'enum', multi: true, sortable: false },
    flag: { type: 'bool' },
    hidden: { sql: 'n', type: 'number', sortable: false, filterable: false, get: (r) => r.n },
  },
}
const GROUP_DEF: TableDef<Row> = {
  ...DEF,
  group: { sql: { key: 'COALESCE(base, id)', isChild: 'base IS NOT NULL' }, key: (r) => r.base ?? r.id, isChild: (r) => r.base != null },
}

async function db() {
  const d = fakeD1()
  await d.exec('CREATE TABLE tq_t (id INTEGER PRIMARY KEY, name TEXT, n INTEGER, at_ms INTEGER, at_s INTEGER, at_iso TEXT, day TEXT, stage TEXT, tags TEXT, flag INTEGER, base INTEGER)')
  for (const r of ROWS) {
    await d.prepare('INSERT INTO tq_t VALUES (?,?,?,?,?,?,?,?,?,?,?)')
      .bind(r.id, r.name, r.n, r.at_ms, r.at_s, r.at_iso, r.day, r.stage, r.tags, r.flag, r.base).run()
  }
  return d
}

const q = (s: string, def: TableDef<Row, unknown> = DEF): TableQuery => parseTableQuery(new URLSearchParams(s), def)
const ids = (rows: Row[]) => rows.map((r) => r.id)

describe('parseTableQuery', () => {
  it('defaults: page 1, size 50, no sort/filters/q', () => {
    expect(q('')).toEqual({ page: 1, size: 50, sort: [], filters: [], q: '' })
  })
  it('clamps size to 10..200 and honours defaultSize', () => {
    expect(q('size=3').size).toBe(10)
    expect(q('size=5000').size).toBe(200)
    expect(parseTableQuery({}, { ...DEF, defaultSize: 25 }).size).toBe(25)
  })
  it('parses multi sort with directions, dropping duplicates', () => {
    expect(q('sort=-n,name,n').sort).toEqual([{ col: 'n', dir: 'desc' }, { col: 'name', dir: 'asc' }])
  })
  it('splits a filter on the first colon only and accepts a Record', () => {
    expect(q('f.name=eq:a:b').filters).toEqual([{ col: 'name', op: 'eq', value: 'a:b' }])
    expect(parseTableQuery({ 'f.n': ['gt:1', 'lt:5'], q: ' hi ' }, DEF)).toMatchObject({ filters: [{ col: 'n', op: 'gt', value: '1' }, { col: 'n', op: 'lt', value: '5' }], q: 'hi' })
    expect(q('f.n=empty').filters).toEqual([{ col: 'n', op: 'empty', value: '' }])
  })
  it.each([
    ['page=0', /page/],
    ['page=abc', /page/],
    ['size=-1', /size/],
    ['sort=nope', /unknown column/],
    ['sort=tags', /not sortable/],
    ['sort=__proto__', /unknown column/],
    ['f.nope=eq:1', /unknown column/],
    ['f.constructor=eq:1', /unknown column/],
    ['f.hidden=eq:1', /not filterable/],
    ['f.n=has:1', /unknown op/],
    ['f.n=gt:abc', /not a number/],
    ['f.n=between:..', /at least one side/],
    ['f.n=between:5', /a\.\.b/],
    ['f.name=has:', /needs a value/],
    ['f.day=on:2026-02-30', /no such date/],
    ['f.day=before:26-1-1', /YYYY-MM-DD/],
    ['f.stage=in:found|bogus', /unknown value/],
    ['f.stage=all:found', /unknown op/],
    ['f.stage=in:', /at least one value/],
    ['f.flag=eq:2', /1 or 0/],
    ['f.atMs=on:2026-01-01', /unknown op/],
  ])('%s is a TableQueryError', (s, re) => {
    let err: unknown
    try { q(s) } catch (e) { err = e }
    expect(err).toBeInstanceOf(TableQueryError)
    expect((err as Error).message).toMatch(re)
    expect(tableErrorBody(err as TableQueryError)).toEqual({ error: 'bad_table_query', message: (err as Error).message })
  })
})

// Every query here is checked twice: the SQL result and runLocalTable must agree.
const CASES: Array<[string, number[] | null, TableDef<Row>?]> = [
  ['', [8, 7, 6, 5, 4, 3, 2, 1]],
  ['sort=name', [1, 4, 2, 6, 3, 5, 8, 7]],
  ['sort=-name', [8, 5, 3, 6, 2, 4, 1, 7]],
  ['sort=n', [6, 7, 8, 2, 1, 4, 5, 3]], // ties (10,10) break on id in the first key's direction
  ['sort=-n', [5, 4, 1, 2, 8, 7, 6, 3]],
  ['sort=-n,name', [5, 1, 4, 2, 8, 7, 6, 3]],
  ['sort=stage,-id', [7, 4, 1, 5, 8, 6, 2, 3]],
  ['sort=atIso', [5, 8, 1, 7, 4, 2, 6, 3]],
  ['sort=-flag,id', [1, 4, 6, 8, 2, 5, 7, 3]],
  // text
  ['f.name=eq:ALPHA', [1]],
  ['f.name=ne:alpha', [8, 7, 6, 5, 4, 3, 2]],
  ['f.name=has:100%', [3]],
  ['f.name=has:_', [6]],
  ['f.name=nhas:alpha', [8, 7, 6, 5, 3, 2]],
  ['f.name=sw:w/', [8, 5]],
  ['f.name=ew:TWO', [4]],
  ['f.name=empty', [7]],
  ['f.name=nempty', [8, 6, 5, 4, 3, 2, 1]],
  // number
  ['f.n=eq:10', [4, 1]],
  ['f.n=ne:10', [8, 7, 6, 5, 3, 2]],
  ['f.n=gt:5', [5, 4, 1]],
  ['f.n=gte:5', [5, 4, 2, 1]],
  ['f.n=lt:1', [7, 6]],
  ['f.n=lte:1', [8, 7, 6]],
  ['f.n=between:1..10', [8, 4, 2, 1]],
  ['f.n=between:..0', [7, 6]],
  ['f.n=between:50..', [5]],
  ['f.n=empty', [3]],
  ['f.n=nempty', [8, 7, 6, 5, 4, 2, 1]],
  ['f.n=gt:0&f.n=lt:10', [8, 2]],
  // datetime in every storage (values are ms)
  ...(['atMs', 'atS', 'atIso'] as const).flatMap((c): Array<[string, number[]]> => [
    [`f.${c}=gte:1700000000000`, [7, 6, 4, 2, 1]],
    [`f.${c}=gt:1700000000000`, [6, 4, 2]],
    [`f.${c}=eq:1700000000000`, [7, 1]],
    [`f.${c}=lt:1650000000001`, [8, 5]],
    [`f.${c}=between:1700000000000..1700000060000`, [7, 4, 1]],
    [`f.${c}=empty`, [3]],
  ]),
  // date
  ['f.day=on:2026-01-05', [7, 4, 1]],
  ['f.day=eq:2026-01-05', [7, 4, 1]],
  ['f.day=before:2026-01-06', [7, 5, 4, 1]],
  ['f.day=after:2026-01-06', [8, 6]],
  ['f.day=between:2026-01-01..2026-01-31', [7, 4, 2, 1]],
  ['f.day=between:..2025-12-31', [5]],
  ['f.day=empty', [3]],
  // enum
  ['f.stage=in:found|identify', [7, 5, 4, 1]],
  ['f.stage=nin:found', [8, 6, 5, 3, 2]],
  ['f.stage=empty', [3]],
  // multi-valued enum
  ['f.tags=in:apple|youtube', [8, 7, 4, 1]],
  ['f.tags=all:spotify|youtube', [8]],
  ['f.tags=nin:spotify', [7, 6, 5, 4, 3]],
  ['f.tags=empty', [6, 3]],
  ['f.tags=nempty', [8, 7, 5, 4, 2, 1]],
  // bool
  ['f.flag=eq:1', [8, 6, 4, 1]],
  ['f.flag=eq:0', [7, 5, 3, 2]],
  // search: name and stage, case-insensitive, wildcards literal
  ['q=ALPHA', [4, 1]],
  ['q=links', [8, 6, 2]],
  ['q=%', [3]],
  ['q=zzz', []],
  ['q=a&f.flag=eq:1&sort=name', [1, 4, 6]],
  // paging, clamped
  ['size=10&page=1', [8, 7, 6, 5, 4, 3, 2, 1]],
  ['size=10&page=9', [8, 7, 6, 5, 4, 3, 2, 1]],
  // groups: children right after their parent (2), the group sorts by its lead
  ['sort=n', [6, 7, 2, 5, 8, 1, 4, 3], GROUP_DEF],
  ['sort=-n', [4, 1, 2, 5, 8, 7, 6, 3], GROUP_DEF],
  ['sort=name', [1, 4, 2, 5, 8, 6, 3, 7], GROUP_DEF],
  ['', [7, 6, 4, 3, 2, 5, 8, 1], GROUP_DEF],
  ['f.name=sw:w/', [5, 8], GROUP_DEF], // parent filtered out: the children form their own group, lead = lowest id
]

describe('runTableQuery (SQL) and runLocalTable agree', () => {
  it.each(CASES)('%s', async (s, want, def = DEF) => {
    const d = await db()
    const query = q(s, def)
    const sql = await runTableQuery(d, def, query)
    const local = runLocalTable(ROWS, def, query)
    expect(ids(sql.rows)).toEqual(ids(local.rows))
    expect(sql.total).toBe(local.total)
    if (want) expect(ids(sql.rows)).toEqual(want)
    if (def.group) for (const r of sql.rows) expect(Object.keys(r).some((k) => k.startsWith('__tq_'))).toBe(false)
  })
})

describe('paging', () => {
  it('reports totals, clamps a page past the end, and the effective sort', async () => {
    const d = await db()
    const big: Row[] = Array.from({ length: 23 }, (_, i) => ({ ...ROWS[0]!, id: 100 + i, base: null }))
    for (const r of big) await d.prepare('INSERT INTO tq_t (id, name, n) VALUES (?, ?, ?)').bind(r.id, r.name, r.n).run()
    const p2 = await runTableQuery(d, DEF, q('size=10&page=2&sort=id'))
    expect(p2).toMatchObject({ total: 31, page: 2, size: 10, pageCount: 4, sort: [{ col: 'id', dir: 'asc' }] })
    expect(ids(p2.rows)).toEqual([102, 103, 104, 105, 106, 107, 108, 109, 110, 111])
    const last = await runTableQuery(d, DEF, q('size=10&page=99&sort=id'))
    expect(last.page).toBe(4)
    expect(ids(last.rows)).toEqual([122])
    const dflt = await runTableQuery(d, DEF, q(''))
    expect(dflt.sort).toEqual([{ col: 'id', dir: 'desc' }])
    const none = await runTableQuery(d, DEF, q('q=nothing-matches'))
    expect(none).toMatchObject({ rows: [], total: 0, page: 1, pageCount: 1 })
  })
  it('runLocalTable pages the same way', () => {
    const r = runLocalTable(ROWS, DEF, q('size=10&page=3'))
    expect(r).toMatchObject({ total: 8, page: 1, pageCount: 1 })
  })
})

describe('SQL safety and options', () => {
  it('binds every value: nothing from the request reaches the SQL text', () => {
    const evil = "x'); DROP TABLE tq_t; --"
    const b = buildTableSql(DEF, q(`q=${encodeURIComponent(evil)}&f.name=has:${encodeURIComponent(evil)}&f.stage=in:found`))
    expect(b.countSql).not.toContain('DROP')
    expect(b.pageSql(10, 0).sql).not.toContain('DROP')
    expect(b.binds).toContain(`%${evil.replace('_', '\\_')}%`) // LIKE wildcards escaped
    expect(b.binds).toContain('found')
  })
  it('def.where / binds and opts.where scope the rows; mapRow shapes them', async () => {
    const d = await db()
    const def: TableDef<Row, { key: number }> = { ...DEF, where: 'flag = ?', binds: [1], mapRow: (r) => ({ key: r.id }) }
    const r = await runTableQuery(d, def, q('sort=id', def), { where: 'n >= ?', binds: [5] })
    expect(r.rows).toEqual([{ key: 1 }, { key: 4 }])
    expect(r.total).toBe(2)
  })
})

describe('Hono helpers', () => {
  it('tableResponse answers the contract, 400 on a bad query, and merges extra', async () => {
    const d = await db()
    const app = new Hono()
    app.get('/t', (c) => tableResponse(c, DEF, d, { extra: (res) => ({ counts: { all: res.total } }) }))
    app.get('/l', (c) => localTableResponse(c, DEF, () => ROWS))
    const ok = await app.request('/t?f.n=gte:5&f.n=lte:10&sort=-n&size=10')
    expect(ok.status).toBe(200)
    const body = await ok.json() as Record<string, unknown> & { rows: Row[] }
    expect(ids(body.rows)).toEqual([4, 1, 2])
    expect(body).toMatchObject({ total: 3, page: 1, size: 10, pageCount: 1, sort: [{ col: 'n', dir: 'desc' }], filters: [{ col: 'n', op: 'gte', value: '5' }, { col: 'n', op: 'lte', value: '10' }], q: '', counts: { all: 3 } })
    const no = await app.request('/t?f.zzz=eq:1')
    expect(no.status).toBe(400)
    expect(await no.json()).toEqual({ error: 'bad_table_query', message: 'unknown column: zzz' })
    const loc = await (await app.request('/l?f.n=gte:5&f.n=lte:10&sort=-n&size=10')).json() as { rows: Row[] }
    expect(ids(loc.rows)).toEqual([4, 1, 2])
  })
})

describe('D1 bind limit', () => {
  it('a query needing more than 100 bound values is a 400 bad_table_query, not a D1 500', async () => {
    const vals = (p: string) => Array.from({ length: 50 }, (_, i) => `${p}${i}`).join('|')
    // 50 + 50 `in` values + LIMIT/OFFSET = 102 binds: refused while parsing (where every route answers 400)…
    const params = new URLSearchParams()
    params.append('f.tags', `in:${vals('a')}`)
    params.append('f.tags', `nin:${vals('b')}`)
    expect(() => parseTableQuery(params, DEF)).toThrow(TableQueryError)
    // …and by buildTableSql for a query assembled by hand (or pushed over by opts.binds).
    const big: TableQuery = { page: 1, size: 10, sort: [], q: '', filters: [{ col: 'tags', op: 'in', value: vals('a') }, { col: 'tags', op: 'nin', value: vals('b') }] }
    expect(() => buildTableSql(DEF, big)).toThrow(/at most 98/)
    const near = q(`f.tags=in:${vals('a')}`)
    const scope = (n: number) => ({ where: '1 = 1' + ' AND ? IS NOT NULL'.repeat(n), binds: Array(n).fill(1) })
    expect(() => buildTableSql(DEF, near, scope(49))).toThrow(TableQueryError)
    expect(await runTableQuery(await db(), DEF, near, scope(49)).catch((e) => e)).toBeInstanceOf(TableQueryError)
    // 98 values (+ LIMIT, OFFSET = D1's 100) still run.
    const fits = await runTableQuery(await db(), DEF, near, scope(48))
    expect(fits.total).toBe(0)
  })
})
