/**
 * In-memory D1 for tests, backed by sql.js (SQLite compiled to WebAssembly —
 * pure JS, so it runs on whatever Node CI happens to have; a native
 * better-sqlite3 build crashed vitest's workers on the CI runner and
 * `node:sqlite` needs Node ≥ 22.13) with the real `migrations/*.sql` applied,
 * so a test exercises the same schema production runs on. Implements the
 * subset of the D1 API the code uses (`prepare().bind().first/all/run/raw`,
 * `batch`, `exec`).
 *
 * Deliberately as strict as D1 where it matters: `undefined` and boolean bind
 * values throw (D1 raises `D1_TYPE_ERROR` for both), `first()` returns `null`
 * on a miss, `bind()` returns a fresh statement, and `batch()` is one
 * transaction.
 */
import initSqlJs, { type Database, type SqlValue } from 'sql.js'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')
const SQL = await initSqlJs()

export function applyMigrations(db: Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
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
      if (this.values.length) stmt.bind(this.values)
      const out: Row[] = []
      while (stmt.step()) out.push(stmt.getAsObject() as Row)
      return out
    } finally {
      stmt.free()
    }
  }

  /** Execute synchronously (also what `batch()` calls inside its transaction). */
  _execSync(): Result<Row> {
    if (READS.test(this.sql)) return { results: this.rows(), success: true, meta: meta() }
    this.db.run(this.sql, this.values)
    const changes = this.db.getRowsModified()
    const lastRowId = Number(this.db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0]?.[0] ?? 0)
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

export function fakeD1(): FakeD1 {
  const db = new SQL.Database()
  applyMigrations(db)
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
