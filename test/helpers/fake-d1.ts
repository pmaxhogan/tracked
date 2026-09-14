/**
 * In-memory D1 for tests, backed by better-sqlite3 with the real
 * `migrations/*.sql` applied, so a test exercises the same schema production
 * runs on. Implements the subset of the D1 API the code uses
 * (`prepare().bind().first/all/run/raw`, `batch`, `exec`).
 *
 * Deliberately as strict as D1 where it matters: `undefined` and boolean bind
 * values throw (D1 raises `D1_TYPE_ERROR` for both — better-sqlite3 rejects
 * them natively), `first()` returns `null` on a miss, and `bind()` returns a
 * fresh statement.
 */
import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const MIGRATIONS_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')

export function applyMigrations(db: Database.Database): void {
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
  for (const f of files) db.exec(readFileSync(join(MIGRATIONS_DIR, f), 'utf8'))
}

type Row = Record<string, unknown>

function meta(extra: Record<string, unknown> = {}) {
  return { duration: 0, size_after: 0, rows_read: 0, rows_written: 0, last_row_id: 0, changed_db: false, changes: 0, ...extra }
}

function checkBinds(values: unknown[]): void {
  for (const x of values) {
    if (x === undefined) throw new Error("D1_TYPE_ERROR: Type 'undefined' not supported for value 'undefined'")
    if (typeof x === 'boolean') throw new Error(`D1_TYPE_ERROR: Type 'boolean' not supported for value '${x}'`)
  }
}

class FakeStatement {
  constructor(
    private readonly db: Database.Database,
    private readonly sql: string,
    private readonly values: unknown[] = [],
  ) {}

  bind(...values: unknown[]): FakeStatement {
    checkBinds(values)
    return new FakeStatement(this.db, this.sql, values)
  }

  private stmt() {
    return this.db.prepare(this.sql)
  }

  async first<T = Row>(colName?: string): Promise<T | null> {
    const row = this.stmt().get(...this.values) as Row | undefined
    if (row === undefined) return null
    if (colName !== undefined) return (row[colName] as T) ?? null
    return row as T
  }

  async all<T = Row>(): Promise<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> {
    const s = this.stmt()
    if (s.reader) return { results: s.all(...this.values) as T[], success: true, meta: meta() }
    const r = s.run(...this.values)
    return { results: [], success: true, meta: meta({ changes: r.changes, last_row_id: Number(r.lastInsertRowid) }) }
  }

  async run<T = Row>(): Promise<{ results: T[]; success: true; meta: ReturnType<typeof meta> }> {
    const s = this.stmt()
    if (s.reader) return { results: s.all(...this.values) as T[], success: true, meta: meta() }
    const r = s.run(...this.values)
    return { results: [], success: true, meta: meta({ changes: r.changes, last_row_id: Number(r.lastInsertRowid), changed_db: r.changes > 0 }) }
  }

  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[]> {
    const s = this.stmt()
    const rows = s.raw(true).all(...this.values) as T[]
    if (options?.columnNames) return [s.columns().map((c) => c.name) as unknown as T, ...rows]
    return rows
  }

  /** Test-only: execute synchronously (inside a better-sqlite3 transaction for batch()). */
  _execSync(): { results: Row[]; success: true; meta: ReturnType<typeof meta> } {
    const s = this.stmt()
    if (s.reader) return { results: s.all(...this.values) as Row[], success: true, meta: meta() }
    const r = s.run(...this.values)
    return { results: [], success: true, meta: meta({ changes: r.changes, last_row_id: Number(r.lastInsertRowid), changed_db: r.changes > 0 }) }
  }
}

export type FakeD1 = D1Database & { _db: Database.Database }

export function fakeD1(): FakeD1 {
  const db = new Database(':memory:')
  applyMigrations(db)
  const api = {
    _db: db,
    prepare(sql: string) {
      return new FakeStatement(db, sql)
    },
    async batch(statements: FakeStatement[]) {
      // One transaction, like D1: a failure part-way rolls the whole batch back.
      const tx = db.transaction(() => statements.map((s) => s._execSync()))
      return tx()
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
