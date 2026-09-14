/**
 * Small helpers over the D1 binding (`env.DB`). The schema lives in
 * `migrations/*.sql`; this module only knows how to talk to it safely.
 *
 * Two D1 rules every caller must respect, enforced here:
 *   - D1 rejects `undefined` and booleans as bind values (`D1_TYPE_ERROR`), so
 *     optional fields are coerced to `null` / 0|1 at the boundary with `v()`.
 *   - A single `batch()` is one transaction. Big imports are chunked so one
 *     statement list never grows past D1's per-batch limits, while each chunk
 *     still commits atomically.
 */

import type { Env } from '../types'

/** Coerce a JS value into something D1 will bind: undefined → null, boolean → 0/1. */
export function v(x: unknown): string | number | null {
  if (x === undefined || x === null) return null
  if (typeof x === 'boolean') return x ? 1 : 0
  if (typeof x === 'number' || typeof x === 'string') return x
  return JSON.stringify(x)
}

/** Largest statement list handed to a single `batch()` call. */
export const BATCH_CHUNK = 100

/** Run `statements` in chunks of `BATCH_CHUNK`, each chunk one transaction. */
export async function batchChunked(db: D1Database, statements: D1PreparedStatement[]): Promise<void> {
  for (let i = 0; i < statements.length; i += BATCH_CHUNK) {
    const chunk = statements.slice(i, i + BATCH_CHUNK)
    if (chunk.length === 1) await chunk[0]!.run()
    else if (chunk.length > 1) await db.batch(chunk)
  }
}

/** `env.DB`, or a clear error when the binding is missing (misconfigured wrangler.jsonc / test env). */
export function dbOf(env: Env): D1Database {
  if (!env.DB) throw new Error('D1 binding DB is not configured')
  return env.DB
}

/** Parse a JSON column, tolerating NULL / garbage (returns `fallback`). */
export function parseJson<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== 'string' || raw === '') return fallback
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}
