/**
 * Keyset pagination shared by both audit trails: pages walk `(ts, id)`
 * descending, and the cursor names the last row seen. Ordering by `ts` (not
 * just the autoincrement id) matters because rows imported from the old KV
 * trail get fresh ids but carry their original timestamps.
 */

export type AuditPage = {
  records: Array<Record<string, unknown> & { key: string }>
  /** Pass back as `cursor` to fetch the next (older) page; null when this was the last page. */
  cursor: string | null
}

export function encodeCursor(ts: number, id: number): string {
  return `${ts}:${id}`
}

export function decodeCursor(cursor: string | null | undefined): { ts: number; id: number } | null {
  if (!cursor) return null
  const m = cursor.match(/^(\d+):(\d+)$/)
  if (!m) return null
  return { ts: Number(m[1]), id: Number(m[2]) }
}
