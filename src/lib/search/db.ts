import type { Env } from '../../types'
/** The search index database (migrations-search/). Throws when the binding is missing. */
export function searchDbOf(env: Env): D1Database {
  if (!env.SEARCH_DB) throw new Error('search_db_missing')
  return env.SEARCH_DB
}
