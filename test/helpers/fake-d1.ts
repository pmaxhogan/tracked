/**
 * In-memory D1 for tests, backed by @sqlite.org/sqlite-wasm (the official
 * SQLite WebAssembly build, used through its oo1 API) with the real
 * `migrations/*.sql` applied, so a test exercises the same schema production
 * runs on. It is WebAssembly, so it runs on whatever Node CI happens to have:
 * a native better-sqlite3 build crashed vitest's workers on the CI runner, and
 * `node:sqlite` needs Node >= 22.13. The engine is this build and not sql.js
 * because the search index needs FTS5 with the trigram tokenizer. sql.js
 * builds have no FTS5, and sql.js-fts5 is SQLite 3.33, which has no trigram.
 * Implements the subset of the D1 API the code uses
 * (`prepare().bind().first/all/run/raw`, `batch`, `exec`).
 *
 * Deliberately as strict as D1 where it matters: `undefined` and boolean bind
 * values throw (D1 raises `D1_TYPE_ERROR` for both), `first()` returns `null`
 * on a miss, `bind()` returns a fresh statement, and `batch()` is one
 * transaction. Integers come back as JS numbers, never bigint, as D1 returns
 * them.
 *
 * `fakeD1()` applies `migrations/` (the main database). `fakeD1({ migrations:
 * 'search' })` applies `migrations-search/` (the search database) and applies
 * nothing while that directory does not exist.
 */
import sqlite3InitModule, { type Database, type SqlValue } from '@sqlite.org/sqlite-wasm'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const MIGRATIONS = { main: join(ROOT, 'migrations'), search: join(ROOT, 'migrations-search') } as const

// The library reads this documented config object once at init and deletes it
// afterwards. Two things keep test output clean:
// - Disabling kvvfs (the localStorage/sessionStorage VFS) stops init from
//   probing `globalThis.localStorage`, which on Node >= 25 prints an
//   ExperimentalWarning. Tests only use ':memory:'.
// - oo1 warns "sqlite3_step() rc= ..." on every failing step and then throws
//   the same error. The throw is what tests see; drop the duplicate warning and
//   pass any other warning through.
;(globalThis as { sqlite3ApiConfig?: unknown }).sqlite3ApiConfig = {
  disable: { vfs: { kvvfs: true } },
  warn: (...args: unknown[]) => {
    if (typeof args[0] === 'string' && args[0].startsWith('sqlite3_step() rc=')) return
    console.warn(...args)
  },
}
const sqlite3 = await sqlite3InitModule()

/** A bare in-memory database with no migrations applied. */
export function openRawDb(): Database {
  return new sqlite3.oo1.DB(':memory:')
}

/** Apply every `*.sql` file in `dir` (default `migrations/`) in name order. A missing directory applies nothing. */
export function applyMigrations(db: Database, dir: string = MIGRATIONS.main): void {
  if (!existsSync(dir)) return
  const files = readdirSync(dir)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) db.exec(readFileSync(join(dir, f), 'utf8'))
}

type Row = Record<string, unknown>
type Meta = {
  duration: number
  size_after: number
  rows_read: number
  rows_written: number
  last_row_id: number
  changed_db: boolean
  changes: number
}
type Result<T> = { results: T[]; success: true; meta: Meta }

function meta(extra: Partial<Meta> = {}): Meta {
  return { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0, ...extra }
}

function checkBinds(values: unknown[]): void {
  for (const x of values) {
    if (x === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'")
    if (typeof x === 'boolean') throw new Error(`D1_TYPE_ERROR: Type 'boolean' not supported for value '${x}'`)
  }
}

/** A plain object (oo1 rows have a null prototype) with any bigint turned into a number. */
function plainRow(row: Record<string, SqlValue>): Row {
  const out: Row = {}
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v
  return out
}

/** Statements that return rows are stepped; everything else is run and reports changes. */
const READS = /^\s*(?:SELECT|WITH|PRAGMA|EXPLAIN)\b/i

class FakeStatement {
  constructor(
    private readonly db: Database,
    private readonly sql: string,
    private readonly values: SqlValue[] = [],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    checkBinds(values)
    return new FakeStatement(this.db, this.sql, values as SqlValue[])
  }

  private rows(): Row[] {
    const stmt = this.db.prepare(this.sql)
    try {
      // oo1 throws on bind() for a statement with no parameters, so only bind when there are values.
      if (this.values.length) stmt.bind(this.values)
      const out: Row[] = []
      while (stmt.step()) out.push(plainRow(stmt.get({}) as Record<string, SqlValue>))
      return out
    } finally {
      stmt.finalize()
    }
  }

  /** Execute synchronously (also what `batch()` calls inside its transaction). */
  _execSync(): Result<Row> {
    if (READS.test(this.sql)) return { results: this.rows(), success: true, meta: meta() }
    this.rows()
    const changes = this.db.changes()
    const lastRowId = Number(sqlite3.capi.sqlite3_last_insert_rowid(this.db))
    return { results: [], success: true, meta: meta({ changes, last_row_id: lastRowId, changed_db: changes > 0 }) }
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.rows()[0]
    if (row === undefined) return null
    if (colName !== undefined) return (row[colName] as T) ?? null
    return row as T
  }

  async all<T = Row>(): Promise<Result<T>> {
    return this._execSync() as Result<T>
  }

  async run<T = Row>(): Promise<Result<T>> {
    return this._execSync() as Result<T>
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const rows = this.rows()
    const values = rows.map((r) => Object.values(r) as unknown as T)
    if (options?.columnNames) return [(rows[0] ? Object.keys(rows[0]) : []) as unknown as T, ...values]
    return values
  }
}

export type FakeD1 = D1Database & { _db: Database }

export function fakeD1(opts: { migrations?: 'main' | 'search' } = {}): FakeD1 {
  const db = openRawDb()
  applyMigrations(db, MIGRATIONS[opts.migrations ?? 'main'])
  const api = {
    _db: db,
    prepare(sql: string) {
      return new FakeStatement(db, sql)
    },
    async batch(statements: FakeStatement[]) {
      // One transaction, like D1: a failure part-way rolls the whole batch back.
      db.exec('BEGIN')
      try {
        const out = statements.map((s) => s._execSync())
        db.exec('COMMIT')
        return out
      } catch (e) {
        db.exec('ROLLBACK')
        throw e
      }
    },
    async exec(sql: string) {
      db.exec(sql)
      return { count: 1, duration: 0 }
    },
    async dump() {
      return new ArrayBuffer(0)
    },
    withSession() {
      throw new Error('withSession is not supported by fakeD1')
    },
  }
  return api as unknown as FakeD1
}
