/**
 * Data-table queries: the server half of the admin UI's data table (the client
 * half is `src/ui/data-table.ts`, global `TKTable`). Every list endpoint that
 * the table reads speaks one HTTP contract, parsed and run here.
 *
 * ## HTTP contract (query string of every table endpoint)
 *
 * - `page`  1-based, default 1. A page past the end is clamped to the last
 *           page; the answer reports the page actually served.
 * - `size`  rows per page, default 50 (`def.defaultSize`), clamped to 10..200.
 * - `sort`  comma list of column keys, `-` prefix = descending
 *           (`sort=-createdAt,title`). Empty = `def.defaultSort`. The primary
 *           key is always appended as the last tiebreak (in the direction of
 *           the first sort key), so paging is stable. NULLs sort last in both
 *           directions. `text` columns sort case-insensitively (ASCII).
 * - `q`     free text, case-insensitive "contains" over the `searchable`
 *           columns (ignored when the table has none). At most 200 chars.
 * - `f.<col>=<op>:<value>` a filter; repeatable, all ANDed. Split on the
 *           FIRST colon only. Ops by column type:
 *   - `text`:     `eq`, `ne`, `has` (contains), `nhas`, `sw`, `ew`, `empty`, `nempty`
 *                 (eq/ne case-insensitive; has/sw/ew are LIKE with the value escaped)
 *   - `number`:   `eq`, `ne`, `gt`, `gte`, `lt`, `lte`, `between` (`a..b`, inclusive,
 *                 either side may be blank), `empty`, `nempty`
 *   - `datetime`: same ops as number; values are **unix ms** whatever the storage
 *                 (`storage: 'ms' | 's' | 'iso'` says how the column is stored)
 *   - `date`:     stored `YYYY-MM-DD`: `eq`/`on`, `before` (<), `after` (>),
 *                 `between` (`a..b` inclusive, either side blank), `empty`, `nempty`
 *   - `enum`:     `in` (`a|b|c`), `nin`, `empty`, `nempty`; a multi-valued column
 *                 (`multi: true`, stored `,a,b,`) also has `all`, and `in` means
 *                 "has any of", `nin` "has none of"
 *   - `bool`:     `eq:1` / `eq:0` (`true`/`false` accepted); NULL counts as 0
 *   Negative ops (`ne`, `nhas`, `nin`) keep NULL rows: "not X" includes "unknown".
 * - Answer: `{ rows, total, page, size, pageCount, sort: [{ col, dir }],
 *   filters: [{ col, op, value }], q }` plus whatever the endpoint adds
 *   (counts, facets). `sort` is the effective sort (the default when none was
 *   asked), without the primary-key tiebreak. `pageCount` is at least 1.
 * - An unknown column, a column that is not sortable / filterable, an unknown
 *   op or a bad value answers `400 { error: 'bad_table_query', message }`.
 *
 * ## Defining a table
 *
 * ```ts
 * import { tableResponse, type TableDef } from '../lib/table-query'
 *
 * const PRESAVES: TableDef<PresaveRow, PresaveOut> = {
 *   from: 'presaves',                       // trusted SQL (FROM clause, may join)
 *   select: '*',                            // trusted SQL select list (default '*')
 *   where: 'dismissed_at IS NULL OR ? = 1', // optional fixed scope, with binds
 *   binds: [1],
 *   primaryKey: 'id',                       // a key of `columns`: the tiebreak
 *   defaultSort: '-createdAt',              // same syntax as the `sort` param
 *   columns: {
 *     id:            { sql: 'id', type: 'number', filterable: false },
 *     artist:        { sql: 'artist', type: 'text', searchable: true },
 *     title:         { sql: 'title', type: 'text', searchable: true },
 *     stage:         { sql: 'stage', type: 'enum', options: ['identify', 'links', 'found'] },
 *     linkSources:   { sql: 'link_sources', type: 'enum', multi: true, sortable: false },
 *     createdAt:     { sql: 'created_at', type: 'datetime', storage: 'ms' },
 *     completedAt:   { sql: 'completed_at', type: 'datetime', storage: 's' },
 *     setDate:       { sql: 'set_date', type: 'date' },
 *     hasLink:       { sql: 'link_count > 0', type: 'bool', get: (r) => r.link_count > 0 },
 *   },
 *   mapRow: (r) => toPresaveOut(r),         // optional: DB row -> JSON row
 * }
 *
 * // In a Hono route: parses c.req.url, answers 400 on a bad query, else the JSON.
 * app.get('/ui/api/presaves', (c) => tableResponse(c, PRESAVES, c.env.DB, {
 *   extra: async () => ({ counts: await stageCounts(c.env.DB) }),
 * }))
 * ```
 *
 * With a joined `from`, give an explicit `select` (aliased, no duplicate
 * column names): the group query wraps it as `SELECT * FROM (SELECT <select>, ...)`.
 *
 * Column keys must be identifiers (`[A-Za-z][A-Za-z0-9_]*`). `sql` defaults to
 * the key. Defaults: `sortable: true`, `filterable: true`, `searchable: false`.
 * `options` (enum) makes values outside the list a 400. `get(row)` reads the
 * column's value from a row in `runLocalTable` (default `row[key]`); a
 * multi-valued enum may be an array or a `,a,b,` string there.
 *
 * Every value is bound (`?`), never interpolated; the only SQL text comes from
 * the definition (trusted code). Request column keys are checked against the
 * definition's own keys.
 *
 * ## Groups (rows that belong together)
 *
 * `group` keeps a child row (a `w/` row) right after its parent whatever the
 * sort: a group sorts by its lead row (its non-child row, else its first row by
 * primary key), then children follow by primary key. In SQL give
 * `group.sql = { key, isChild }` (the group id expression, the same for parent
 * and children, e.g. `COALESCE(base_id, id)`; and a 0/1 child expression);
 * it runs with window functions. For `runLocalTable` give `group.key(row)` and
 * `group.isChild(row)`. A filter that drops a parent leaves its children as a
 * group of their own, and a page boundary can still fall inside a group.
 *
 * ## Lists computed in the Worker
 *
 * `runLocalTable(rows, def, query)` applies the same filters, search, sort
 * and paging in JS (`from`/`sql` are not needed; `get` reads values), and
 * `localTableResponse(c, def, rows, opts)` is its Hono handler.
 */
import type { Context } from 'hono'

// ── types ──────────────────────────────────────────────────────────────────

export type TableColumnType = 'text' | 'number' | 'datetime' | 'date' | 'enum' | 'bool'
export type TableStorage = 'ms' | 's' | 'iso'
export type TableBind = string | number | null
export type SortDir = 'asc' | 'desc'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type AnyRow = any

export interface TableColumn<Row = AnyRow> {
  /** Trusted SQL expression for the column (default: the key). */
  sql?: string
  type: TableColumnType
  /** Default true. */
  sortable?: boolean
  /** Default true. */
  filterable?: boolean
  /** Part of the `q` search. Default false. */
  searchable?: boolean
  /** datetime only: how the value is stored (default 'ms'). Filter values are always unix ms. */
  storage?: TableStorage
  /** enum only: stored `,a,b,` (local rows may also hold an array). */
  multi?: boolean
  /** enum only: the allowed values; anything else is a 400. */
  options?: readonly string[]
  /** Local mode: the column's value in a row (default `row[key]`). */
  get?: (row: Row) => unknown
}

export interface TableGroup<Row = AnyRow> {
  /** SQL mode: the group id expression and a 0/1 "is a child row" expression. */
  sql?: { key: string; isChild: string }
  /** Local mode: the group id (null/undefined = the row's own primary key). */
  key?: (row: Row) => unknown
  /** Local mode: whether the row is a child (a `w/` row). */
  isChild?: (row: Row) => boolean
}

export interface TableDef<Row = AnyRow, Out = Row> {
  columns: Record<string, TableColumn<Row>>
  /** SQL mode: trusted FROM clause (a table, or joins). */
  from?: string
  /** SQL mode: trusted select list (default `*`). */
  select?: string
  /** SQL mode: a fixed WHERE condition with `?` placeholders bound from `binds`. */
  where?: string
  binds?: TableBind[]
  /** Same syntax as the `sort` param, or the parsed form. */
  defaultSort: string | TableSort[]
  /** A key of `columns`: the last tiebreak of every sort. */
  primaryKey: string
  /** Rows per page when `size` is absent (default 50). */
  defaultSize?: number
  /** Turns a DB row (or a local row) into the JSON row. */
  mapRow?: (row: Row) => Out
  group?: TableGroup<Row>
}

export interface TableSort { col: string; dir: SortDir }
export interface TableFilter { col: string; op: string; value: string }
export interface TableQuery { page: number; size: number; sort: TableSort[]; filters: TableFilter[]; q: string }
export interface TableResult<Out> {
  rows: Out[]
  total: number
  page: number
  size: number
  pageCount: number
  sort: TableSort[]
  filters: TableFilter[]
  q: string
}

/** Extra scope for one call: an AND-ed WHERE condition with its binds. */
export interface TableRunOpts { where?: string; binds?: TableBind[] }

export type TableParams = URLSearchParams | Record<string, string | string[] | undefined | null>

export const TABLE_SIZE_MIN = 10
export const TABLE_SIZE_MAX = 200
export const TABLE_SIZE_DEFAULT = 50
const MAX_SORT_KEYS = 5
const MAX_FILTERS = 40
const MAX_Q = 200
const MAX_VALUE = 500
const MAX_LIST = 50
/** D1's limit on bound parameters in one statement. */
export const D1_MAX_BINDS = 100

/** A bad request: answer it with `400 tableErrorBody(e)`. */
export class TableQueryError extends Error {
  readonly code = 'bad_table_query' as const
  constructor(message: string) {
    super(message)
    this.name = 'TableQueryError'
  }
}

export function isTableQueryError(e: unknown): e is TableQueryError {
  return e instanceof TableQueryError
}

/** The 400 body for a TableQueryError. */
export function tableErrorBody(e: TableQueryError | { message: string }): { error: 'bad_table_query'; message: string } {
  return { error: 'bad_table_query', message: e.message }
}

const bad = (msg: string): never => {
  throw new TableQueryError(msg)
}

// ── definition checks ──────────────────────────────────────────────────────

const KEY_RE = /^[A-Za-z][A-Za-z0-9_]*$/
const OPS: Record<TableColumnType, readonly string[]> = {
  text: ['eq', 'ne', 'has', 'nhas', 'sw', 'ew', 'empty', 'nempty'],
  number: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'nempty'],
  datetime: ['eq', 'ne', 'gt', 'gte', 'lt', 'lte', 'between', 'empty', 'nempty'],
  date: ['eq', 'on', 'before', 'after', 'between', 'empty', 'nempty'],
  enum: ['in', 'nin', 'all', 'empty', 'nempty'],
  bool: ['eq'],
}
/** The ops a column type accepts (for docs and the client). */
export function tableOps(type: TableColumnType, multi = false): readonly string[] {
  return type === 'enum' && !multi ? OPS.enum.filter((o) => o !== 'all') : OPS[type]
}

const checked = new WeakSet<object>()
function checkDef(def: TableDef<AnyRow, AnyRow>): void {
  if (checked.has(def)) return
  const keys = Object.keys(def.columns)
  for (const k of keys) {
    if (!KEY_RE.test(k)) throw new Error(`table def: bad column key ${JSON.stringify(k)}`)
    const col = def.columns[k]!
    if (!(col.type in OPS)) throw new Error(`table def: column ${k} has unknown type ${String(col.type)}`)
    if (col.storage && !['ms', 's', 'iso'].includes(col.storage)) throw new Error(`table def: column ${k} has unknown storage`)
  }
  if (!has(def.columns, def.primaryKey)) throw new Error('table def: primaryKey must be a column key')
  checked.add(def)
}

function has(o: object, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k)
}

function column(def: TableDef<AnyRow, AnyRow>, key: string): TableColumn {
  if (!KEY_RE.test(key) || !has(def.columns, key)) return bad(`unknown column: ${key.slice(0, 60)}`)
  return def.columns[key]!
}

const colSql = (key: string, col: TableColumn): string => `(${col.sql ?? key})`

// ── parsing ────────────────────────────────────────────────────────────────

function paramList(params: TableParams, name: string): string[] {
  if (params instanceof URLSearchParams) return params.getAll(name)
  const v = params[name]
  if (v == null) return []
  return Array.isArray(v) ? v.map(String) : [String(v)]
}

function paramNames(params: TableParams): string[] {
  if (params instanceof URLSearchParams) return [...new Set(params.keys())]
  return Object.keys(params)
}

function intParam(params: TableParams, name: string): number | null {
  const raw = paramList(params, name)[0]
  if (raw == null || raw.trim() === '') return null
  if (!/^\d{1,9}$/.test(raw.trim())) return bad(`${name} must be a positive whole number`)
  return Number(raw.trim())
}

/** Parses a sort string (`-createdAt,title`) against the definition. */
export function parseSort(raw: string | TableSort[], def: TableDef<AnyRow, AnyRow>): TableSort[] {
  const items: TableSort[] = Array.isArray(raw)
    ? raw
    : raw.split(',').map((s) => s.trim()).filter(Boolean).map((s) => {
      const desc = s.startsWith('-')
      const col = s.replace(/^[-+]/, '')
      return { col, dir: desc ? 'desc' : 'asc' } as TableSort
    })
  const out: TableSort[] = []
  for (const s of items) {
    const col = column(def, s.col)
    if (col.sortable === false) bad(`column ${s.col} is not sortable`)
    if (s.dir !== 'asc' && s.dir !== 'desc') bad(`bad sort direction for ${s.col}`)
    if (!out.some((o) => o.col === s.col)) out.push({ col: s.col, dir: s.dir })
  }
  if (out.length > MAX_SORT_KEYS) bad(`at most ${MAX_SORT_KEYS} sort columns`)
  return out
}

/**
 * Parses the contract's query string into a TableQuery, validating every key,
 * op and value against `def`. Throws TableQueryError on anything bad.
 */
export function parseTableQuery(params: TableParams, def: TableDef<AnyRow, AnyRow>): TableQuery {
  checkDef(def)
  const page = intParam(params, 'page') ?? 1
  if (page < 1) bad('page must be 1 or more')
  const sizeRaw = intParam(params, 'size')
  const size = Math.min(TABLE_SIZE_MAX, Math.max(TABLE_SIZE_MIN, sizeRaw ?? def.defaultSize ?? TABLE_SIZE_DEFAULT))
  const sortRaw = paramList(params, 'sort').join(',')
  const sort = parseSort(sortRaw, def)
  const q = (paramList(params, 'q')[0] ?? '').trim()
  if (q.length > MAX_Q) bad(`q is longer than ${MAX_Q} characters`)
  const filters: TableFilter[] = []
  for (const name of paramNames(params)) {
    if (!name.startsWith('f.')) continue
    const key = name.slice(2)
    for (const raw of paramList(params, name)) {
      const i = raw.indexOf(':')
      const op = (i < 0 ? raw : raw.slice(0, i)).trim()
      const value = i < 0 ? '' : raw.slice(i + 1)
      const f = { col: key, op, value }
      compileFilter(def, f) // validates
      filters.push(f)
    }
  }
  if (filters.length > MAX_FILTERS) bad(`at most ${MAX_FILTERS} filters`)
  const query = { page, size, sort, filters, q }
  // SQL mode: checked here too, where every route already answers a TableQueryError with 400.
  if (def.from) checkBindCount(whereSql(def, query, undefined).binds.length)
  return query
}

// ── filters, compiled once for SQL and for JS ──────────────────────────────

type Compiled =
  | { kind: 'empty'; neg: boolean }
  | { kind: 'cmp'; op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte'; v: number | string }
  | { kind: 'range'; lo: number | string | null; hi: number | string | null }
  | { kind: 'text'; op: 'eq' | 'ne' | 'has' | 'nhas' | 'sw' | 'ew'; v: string }
  | { kind: 'in'; op: 'in' | 'nin' | 'all'; list: string[] }
  | { kind: 'bool'; v: 0 | 1 }

function num(v: string, what: string): number {
  const t = v.trim()
  if (t === '' || !/^-?(\d+\.?\d*|\.\d+)(e[-+]?\d+)?$/i.test(t)) return bad(`${what}: not a number: ${t.slice(0, 40)}`)
  const n = Number(t)
  if (!Number.isFinite(n)) return bad(`${what}: not a number`)
  return n
}

function day(v: string, what: string): string {
  const t = v.trim()
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(t)
  if (!m) return bad(`${what}: not a YYYY-MM-DD date: ${t.slice(0, 40)}`)
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])))
  if (d.toISOString().slice(0, 10) !== t) return bad(`${what}: no such date: ${t}`)
  return t
}

function compileFilter(def: TableDef<AnyRow, AnyRow>, f: TableFilter): Compiled {
  const col = column(def, f.col)
  if (col.filterable === false) bad(`column ${f.col} is not filterable`)
  const what = `f.${f.col}`
  if (!tableOps(col.type, !!col.multi).includes(f.op)) bad(`${what}: unknown op ${JSON.stringify(f.op.slice(0, 20))} for a ${col.type} column`)
  if (f.value.length > MAX_VALUE) bad(`${what}: value too long`)
  if (f.op === 'empty' || f.op === 'nempty') return { kind: 'empty', neg: f.op === 'nempty' }
  switch (col.type) {
    case 'text': {
      if (f.value === '') bad(`${what}: ${f.op} needs a value`)
      return { kind: 'text', op: f.op as 'eq', v: f.value }
    }
    case 'number':
    case 'datetime': {
      if (f.op === 'between') {
        const [a = '', b = ''] = splitRange(f.value, what)
        const lo = a.trim() === '' ? null : num(a, what)
        const hi = b.trim() === '' ? null : num(b, what)
        if (lo === null && hi === null) bad(`${what}: between needs at least one side`)
        return { kind: 'range', lo, hi }
      }
      return { kind: 'cmp', op: f.op as 'eq', v: num(f.value, what) }
    }
    case 'date': {
      if (f.op === 'between') {
        const [a = '', b = ''] = splitRange(f.value, what)
        const lo = a.trim() === '' ? null : day(a, what)
        const hi = b.trim() === '' ? null : day(b, what)
        if (lo === null && hi === null) bad(`${what}: between needs at least one side`)
        return { kind: 'range', lo, hi }
      }
      const v = day(f.value, what)
      return { kind: 'cmp', op: f.op === 'before' ? 'lt' : f.op === 'after' ? 'gt' : 'eq', v }
    }
    case 'enum': {
      const list = [...new Set(f.value.split('|').map((s) => s.trim()).filter(Boolean))]
      if (!list.length) bad(`${what}: ${f.op} needs at least one value`)
      if (list.length > MAX_LIST) bad(`${what}: too many values`)
      if (col.options) for (const v of list) if (!col.options.includes(v)) bad(`${what}: unknown value ${JSON.stringify(v.slice(0, 40))}`)
      if (col.multi) for (const v of list) if (v.includes(',')) bad(`${what}: a value cannot contain a comma`)
      return { kind: 'in', op: f.op as 'in', list }
    }
    case 'bool': {
      const v = f.value.trim().toLowerCase()
      if (v === '1' || v === 'true') return { kind: 'bool', v: 1 }
      if (v === '0' || v === 'false') return { kind: 'bool', v: 0 }
      return bad(`${what}: eq takes 1 or 0`)
    }
  }
}

function splitRange(v: string, what: string): string[] {
  const i = v.indexOf('..')
  if (i < 0) return bad(`${what}: between takes a..b`)
  return [v.slice(0, i), v.slice(i + 2)]
}

// ── SQL ────────────────────────────────────────────────────────────────────

/** `%`, `_` and `\` are LIKE wildcards: a search for `100%` must not match everything. */
function likeEscape(s: string): string {
  return s.replace(/[\\%_]/g, (ch) => `\\${ch}`)
}
const LIKE = "LIKE ? ESCAPE '\\'"

/** The expression a datetime column is compared through, and the bound value for an ms value. */
function dtSide(key: string, col: TableColumn): { expr: string; bind: (ms: number) => number } {
  const e = colSql(key, col)
  if (col.storage === 's') return { expr: e, bind: (ms) => ms / 1000 }
  if (col.storage === 'iso') return { expr: `CAST(ROUND((julianday(${e}) - 2440587.5) * 86400000) AS INTEGER)`, bind: (ms) => ms }
  return { expr: e, bind: (ms) => ms }
}

const CMP_SQL = { eq: '=', ne: '!=', gt: '>', gte: '>=', lt: '<', lte: '<=' } as const

function filterSql(def: TableDef<AnyRow, AnyRow>, f: TableFilter, binds: TableBind[]): string {
  const c = compileFilter(def, f)
  const col = def.columns[f.col]!
  let e = colSql(f.col, col)
  let conv = (v: number | string): TableBind => v
  if (col.type === 'datetime') {
    const s = dtSide(f.col, col)
    e = s.expr
    conv = (v) => s.bind(v as number)
  }
  switch (c.kind) {
    case 'empty': {
      const isEmpty = col.type === 'text' || col.type === 'enum' ? `(${e} IS NULL OR ${e} = '')` : `${e} IS NULL`
      return c.neg ? `NOT ${isEmpty}` : isEmpty
    }
    case 'cmp': {
      binds.push(conv(c.v))
      return c.op === 'ne' ? `(${e} IS NULL OR ${e} != ?)` : `${e} ${CMP_SQL[c.op]} ?`
    }
    case 'range': {
      const parts: string[] = []
      if (c.lo !== null) { parts.push(`${e} >= ?`); binds.push(conv(c.lo)) }
      if (c.hi !== null) { parts.push(`${e} <= ?`); binds.push(conv(c.hi)) }
      return `(${parts.join(' AND ')})`
    }
    case 'text': {
      switch (c.op) {
        case 'eq': binds.push(c.v); return `${e} = ? COLLATE NOCASE`
        case 'ne': binds.push(c.v); return `(${e} IS NULL OR NOT (${e} = ? COLLATE NOCASE))`
        case 'has': binds.push(`%${likeEscape(c.v)}%`); return `${e} ${LIKE}`
        case 'nhas': binds.push(`%${likeEscape(c.v)}%`); return `(${e} IS NULL OR ${e} NOT ${LIKE})`
        case 'sw': binds.push(`${likeEscape(c.v)}%`); return `${e} ${LIKE}`
        case 'ew': binds.push(`%${likeEscape(c.v)}`); return `${e} ${LIKE}`
      }
      break
    }
    case 'in': {
      if (col.multi) {
        const one = c.list.map((v) => { binds.push(`,${v},`); return `instr(${e}, ?) > 0` })
        if (c.op === 'all') return `(${e} IS NOT NULL AND ${one.join(' AND ')})`
        if (c.op === 'nin') return `(${e} IS NULL OR NOT (${one.join(' OR ')}))`
        return `(${e} IS NOT NULL AND (${one.join(' OR ')}))`
      }
      binds.push(...c.list)
      const marks = c.list.map(() => '?').join(', ')
      return c.op === 'nin' ? `(${e} IS NULL OR ${e} NOT IN (${marks}))` : `${e} IN (${marks})`
    }
    case 'bool':
      return c.v ? `COALESCE(${e}, 0) != 0` : `COALESCE(${e}, 0) = 0`
  }
  return bad('unreachable')
}

function checkBindCount(n: number): void {
  if (n + 2 > D1_MAX_BINDS) bad(`the filters need ${n} values; at most ${D1_MAX_BINDS - 2} fit in one query (use fewer filters or fewer values)`)
}

function whereSql(def: TableDef<AnyRow, AnyRow>, query: TableQuery, opts: TableRunOpts | undefined): { sql: string; binds: TableBind[] } {
  const parts: string[] = []
  const binds: TableBind[] = []
  if (def.where) { parts.push(`(${def.where})`); binds.push(...(def.binds ?? [])) }
  if (opts?.where) { parts.push(`(${opts.where})`); binds.push(...(opts.binds ?? [])) }
  for (const f of query.filters) parts.push(filterSql(def, f, binds))
  const searchable = Object.keys(def.columns).filter((k) => def.columns[k]!.searchable)
  if (query.q && searchable.length) {
    const term = `%${likeEscape(query.q)}%`
    parts.push(`(${searchable.map((k) => { binds.push(term); return `COALESCE(CAST(${colSql(k, def.columns[k]!)} AS TEXT), '') ${LIKE}` }).join(' OR ')})`)
  }
  return { sql: parts.length ? `WHERE ${parts.join(' AND ')}` : '', binds }
}

/** The effective sort: the query's, else the definition's default. */
function effectiveSort(def: TableDef<AnyRow, AnyRow>, query: TableQuery): TableSort[] {
  return query.sort.length ? query.sort : parseSort(def.defaultSort, def)
}

const sqlDir = (d: SortDir) => (d === 'desc' ? 'DESC' : 'ASC')

/** Builds the count and page SQL (exported for tests and EXPLAIN). */
export function buildTableSql(def: TableDef<AnyRow, AnyRow>, query: TableQuery, opts?: TableRunOpts): {
  countSql: string; pageSql: (limit: number, offset: number) => { sql: string; binds: TableBind[] }; binds: TableBind[]; sort: TableSort[]
} {
  checkDef(def)
  if (!def.from) throw new Error('table def: runTableQuery needs `from`')
  const where = whereSql(def, query, opts)
  // D1 binds at most 100 values per statement (the page query adds LIMIT and OFFSET):
  // past that it is the request's fault (many `in` values × filters), so a 400, not D1's 500.
  checkBindCount(where.binds.length)
  const sort = effectiveSort(def, query)
  const pk = colSql(def.primaryKey, def.columns[def.primaryKey]!)
  const dir0 = sqlDir(sort[0]?.dir ?? 'asc')
  const select = def.select ?? '*'
  const countSql = `SELECT COUNT(*) AS n FROM ${def.from} ${where.sql}`
  const g = def.group?.sql
  let pageSql: string
  if (!g) {
    const order = sort.map((s) => {
      const col = def.columns[s.col]!
      const e = colSql(s.col, col)
      return `${e} IS NULL, ${e}${col.type === 'text' ? ' COLLATE NOCASE' : ''} ${sqlDir(s.dir)}`
    })
    order.push(`${pk} ${dir0}`)
    pageSql = `SELECT ${select} FROM ${def.from} ${where.sql} ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?`
  } else {
    const ic = `(CASE WHEN (${g.isChild}) THEN 1 ELSE 0 END)`
    const win = `OVER (PARTITION BY (${g.key}) ORDER BY ${ic} ASC, ${pk} ASC ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING)`
    const leads = sort.map((s, i) => `FIRST_VALUE(${colSql(s.col, def.columns[s.col]!)}) ${win} AS __tq_s${i}`)
    const inner = `SELECT ${select}, ${[...leads, `FIRST_VALUE(${pk}) ${win} AS __tq_lpk`, `${ic} AS __tq_ic`, `${pk} AS __tq_pk`].join(', ')} FROM ${def.from} ${where.sql}`
    const order = sort.map((s, i) => `__tq_s${i} IS NULL, __tq_s${i}${def.columns[s.col]!.type === 'text' ? ' COLLATE NOCASE' : ''} ${sqlDir(s.dir)}`)
    order.push(`__tq_lpk ${dir0}`, '__tq_ic ASC', '__tq_pk ASC')
    pageSql = `SELECT * FROM (${inner}) ORDER BY ${order.join(', ')} LIMIT ? OFFSET ?`
  }
  return {
    countSql,
    binds: where.binds,
    sort,
    pageSql: (limit, offset) => ({ sql: pageSql, binds: [...where.binds, limit, offset] }),
  }
}

function pageMath(total: number, query: TableQuery): { page: number; pageCount: number; offset: number } {
  const pageCount = Math.max(1, Math.ceil(total / query.size))
  const page = Math.min(query.page, pageCount)
  return { page, pageCount, offset: (page - 1) * query.size }
}

/**
 * Runs a parsed query against D1: one COUNT(*) and one page query, every value
 * bound. `opts.where`/`opts.binds` AND an extra scope onto the definition's.
 */
export async function runTableQuery<Row = AnyRow, Out = Row>(
  db: D1Database, def: TableDef<Row, Out>, query: TableQuery, opts?: TableRunOpts,
): Promise<TableResult<Out>> {
  const d = def as TableDef<AnyRow, AnyRow>
  const b = buildTableSql(d, query, opts)
  const count = await db.prepare(b.countSql).bind(...b.binds).first<{ n: number }>()
  const total = Number(count?.n ?? 0)
  const { page, pageCount, offset } = pageMath(total, query)
  let rows: Row[] = []
  if (total > 0) {
    const p = b.pageSql(query.size, offset)
    const res = await db.prepare(p.sql).bind(...p.binds).all<Record<string, unknown>>()
    rows = (res.results ?? []).map((r) => {
      if (!d.group?.sql) return r as Row
      const out: Record<string, unknown> = {}
      for (const [k, v] of Object.entries(r)) if (!k.startsWith('__tq_')) out[k] = v
      return out as Row
    })
  }
  return {
    rows: def.mapRow ? rows.map((r) => def.mapRow!(r)) : (rows as unknown as Out[]),
    total, page, size: query.size, pageCount, sort: b.sort, filters: query.filters, q: query.q,
  }
}

// ── local (JS) ─────────────────────────────────────────────────────────────

/** ASCII-only case folding: what SQLite's NOCASE and LIKE do. */
const fold = (s: string) => s.replace(/[A-Z]/g, (ch) => ch.toLowerCase())

function rawValue(def: TableDef<AnyRow, AnyRow>, key: string, row: AnyRow): unknown {
  const col = def.columns[key]!
  const v = col.get ? col.get(row) : row?.[key]
  return v === undefined ? null : v
}

function toMs(v: unknown, storage: TableStorage | undefined): number | null {
  if (v == null || v === '') return null
  if (storage === 'iso') {
    const t = Date.parse(String(v))
    return Number.isNaN(t) ? null : t
  }
  const n = Number(v)
  if (!Number.isFinite(n)) return null
  return storage === 's' ? n * 1000 : n
}

function multiList(v: unknown): string[] | null {
  if (v == null) return null
  if (Array.isArray(v)) return v.map(String)
  return String(v).split(',').filter(Boolean)
}

/** SQLite-like ordering of two non-null values: numbers before text, text by code unit. */
function cmpRaw(a: unknown, b: unknown): number {
  const an = typeof a === 'number', bn = typeof b === 'number'
  if (an && bn) return (a as number) - (b as number)
  if (an !== bn) return an ? -1 : 1
  const as = String(a), bs = String(b)
  return as < bs ? -1 : as > bs ? 1 : 0
}

function localMatch(def: TableDef<AnyRow, AnyRow>, f: TableFilter, row: AnyRow): boolean {
  const c = compileFilter(def, f)
  const col = def.columns[f.col]!
  const raw = rawValue(def, f.col, row)
  let v: unknown = raw
  if (col.type === 'datetime') v = toMs(raw, col.storage)
  else if (col.type === 'number') v = raw == null || raw === '' ? null : Number(raw)
  switch (c.kind) {
    case 'empty': {
      const isEmpty = v == null || ((col.type === 'text' || col.type === 'enum') && v === '') || (!!col.multi && Array.isArray(v) && v.length === 0)
      return c.neg ? !isEmpty : isEmpty
    }
    case 'cmp': {
      if (v == null) return c.op === 'ne'
      const d = cmpRaw(v, c.v)
      switch (c.op) {
        case 'eq': return d === 0
        case 'ne': return d !== 0
        case 'gt': return d > 0
        case 'gte': return d >= 0
        case 'lt': return d < 0
        case 'lte': return d <= 0
      }
      return false
    }
    case 'range':
      if (v == null) return false
      return (c.lo === null || cmpRaw(v, c.lo) >= 0) && (c.hi === null || cmpRaw(v, c.hi) <= 0)
    case 'text': {
      if (v == null) return c.op === 'ne' || c.op === 'nhas'
      const s = fold(String(v)), t = fold(c.v)
      switch (c.op) {
        case 'eq': return s === t
        case 'ne': return s !== t
        case 'has': return s.includes(t)
        case 'nhas': return !s.includes(t)
        case 'sw': return s.startsWith(t)
        case 'ew': return s.endsWith(t)
      }
      return false
    }
    case 'in': {
      if (col.multi) {
        const list = multiList(raw)
        if (list == null) return c.op === 'nin'
        if (c.op === 'all') return c.list.every((x) => list.includes(x))
        const any = c.list.some((x) => list.includes(x))
        return c.op === 'nin' ? !any : any
      }
      if (v == null) return c.op === 'nin'
      const hit = c.list.includes(String(v))
      return c.op === 'nin' ? !hit : hit
    }
    case 'bool': {
      const truthy = !(v == null || v === 0 || v === false || v === '0' || v === '')
      return c.v ? truthy : !truthy
    }
  }
}

function localSearch(def: TableDef<AnyRow, AnyRow>, q: string, row: AnyRow): boolean {
  const t = fold(q)
  for (const k of Object.keys(def.columns)) {
    if (!def.columns[k]!.searchable) continue
    const v = rawValue(def, k, row)
    if (v != null && fold(Array.isArray(v) ? `,${v.join(',')},` : String(v)).includes(t)) return true
  }
  return false
}

function sortValue(def: TableDef<AnyRow, AnyRow>, key: string, row: AnyRow): unknown {
  const col = def.columns[key]!
  const v = rawValue(def, key, row)
  if (v == null) return null
  if (col.type === 'text') return fold(String(v))
  if (col.type === 'number') return v === '' ? null : Number(v)
  if (col.type === 'bool') return v === true ? 1 : v === false ? 0 : v
  return v
}

/** Sorts, filters, searches and pages rows in JS with the same semantics as runTableQuery. */
export function runLocalTable<Row = AnyRow, Out = Row>(rows: readonly Row[], def: TableDef<Row, Out>, query: TableQuery): TableResult<Out> {
  const d = def as TableDef<AnyRow, AnyRow>
  checkDef(d)
  const sort = effectiveSort(d, query)
  const searchable = Object.keys(d.columns).some((k) => d.columns[k]!.searchable)
  const kept = rows.filter((r) => query.filters.every((f) => localMatch(d, f, r)) && (!query.q || !searchable || localSearch(d, query.q, r)))
  type Item = { row: Row; pk: unknown; ic: number; vals: unknown[]; lead?: Item }
  const items: Item[] = kept.map((row) => ({
    row,
    pk: rawValue(d, d.primaryKey, row),
    ic: d.group?.isChild?.(row) ? 1 : 0,
    vals: sort.map((s) => sortValue(d, s.col, row)),
  }))
  const pkCmp = (a: unknown, b: unknown) => (a == null ? (b == null ? 0 : 1) : b == null ? -1 : cmpRaw(a, b))
  if (d.group?.key || d.group?.isChild) {
    const groups = new Map<unknown, Item[]>()
    for (const it of items) {
      const gk0 = d.group.key ? d.group.key(it.row) : null
      const gk = gk0 == null ? it.pk : gk0
      const list = groups.get(gk)
      if (list) list.push(it)
      else groups.set(gk, [it])
    }
    for (const list of groups.values()) {
      let lead = list[0]!
      for (const it of list) if (it.ic < lead.ic || (it.ic === lead.ic && pkCmp(it.pk, lead.pk) < 0)) lead = it
      for (const it of list) it.lead = lead
    }
  }
  const dir0 = sort[0]?.dir === 'desc' ? -1 : 1
  items.sort((a, b) => {
    const la = a.lead ?? a, lb = b.lead ?? b
    for (let i = 0; i < sort.length; i++) {
      const x = la.vals[i], y = lb.vals[i]
      if (x == null || y == null) {
        if (x == null && y == null) continue
        return x == null ? 1 : -1
      }
      const c = cmpRaw(x, y)
      if (c) return sort[i]!.dir === 'desc' ? -c : c
    }
    const lp = pkCmp(la.pk, lb.pk)
    if (lp) return lp * dir0
    if (a.ic !== b.ic) return a.ic - b.ic
    return pkCmp(a.pk, b.pk)
  })
  const total = items.length
  const { page, pageCount, offset } = pageMath(total, query)
  const slice = items.slice(offset, offset + query.size).map((it) => it.row)
  return {
    rows: def.mapRow ? slice.map((r) => def.mapRow!(r)) : (slice as unknown as Out[]),
    total, page, size: query.size, pageCount, sort, filters: query.filters, q: query.q,
  }
}

// ── Hono helpers ───────────────────────────────────────────────────────────

export interface TableResponseOpts<Out> extends TableRunOpts {
  /** Extra fields merged into the answer (counts, facets). */
  extra?: (result: TableResult<Out>, query: TableQuery) => Record<string, unknown> | Promise<Record<string, unknown>>
}

/** Parses the request, answers 400 `bad_table_query` on a bad query, else runs it on D1 and answers the JSON. */
export async function tableResponse<Row, Out>(c: Context, def: TableDef<Row, Out>, db: D1Database, opts?: TableResponseOpts<Out>): Promise<Response> {
  let query: TableQuery
  try {
    query = parseTableQuery(new URL(c.req.url).searchParams, def as TableDef<AnyRow, AnyRow>)
  } catch (e) {
    if (e instanceof TableQueryError) return c.json(tableErrorBody(e), 400)
    throw e
  }
  const result = await runTableQuery(db, def, query, opts)
  const extra = opts?.extra ? await opts.extra(result, query) : {}
  return c.json({ ...result, ...extra })
}

/** tableResponse for rows computed in the Worker (runLocalTable). */
export async function localTableResponse<Row, Out>(
  c: Context, def: TableDef<Row, Out>, rows: readonly Row[] | (() => Promise<readonly Row[]> | readonly Row[]),
  opts?: Pick<TableResponseOpts<Out>, 'extra'>,
): Promise<Response> {
  let query: TableQuery
  try {
    query = parseTableQuery(new URL(c.req.url).searchParams, def as TableDef<AnyRow, AnyRow>)
  } catch (e) {
    if (e instanceof TableQueryError) return c.json(tableErrorBody(e), 400)
    throw e
  }
  const list = typeof rows === 'function' ? await rows() : rows
  const result = runLocalTable(list, def, query)
  const extra = opts?.extra ? await opts.extra(result, query) : {}
  return c.json({ ...result, ...extra })
}
