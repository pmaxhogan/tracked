/**
 * The mkvid page's read endpoints (ui/pages/mkvid.ts). Mounted inside
 * subscriptionsApp, so behind its cfAccess gate and the /ui/api/* same-origin
 * guard. The actions (retry, move, ban, ...) stay in routes/subscriptions.ts.
 *
 *   GET /api/mkvid            the header: status line inputs, caps, counts, last poll,
 *                             the DJ list, old-style count, replaced videos, and the
 *                             requests rendering now (`rendering`). Home and Settings read
 *                             it too (they send `?limit=1`, which is ignored).
 *   GET /api/mkvid/queue      the waiting line: a data-table endpoint (lib/table-query.ts:
 *                             page, size, sort, q, f.<col>) over the pending requests. Default
 *                             sort `position` = claim order; every row carries its 1-based
 *                             `position` in the whole queue, which no filter or sort shifts.
 *   GET /api/mkvid/finished   everything that left the line (done, failed, superseded,
 *                             banned), newest activity first by default.
 *
 * Every request row is `requestSummary` plus `readiness` (why a waiting set is or is
 * not next) and, in the queue, `position`. `q` matches the set title, the DJ (stored
 * name or slug), the set URL and the error.
 */
import { Hono, type Context } from 'hono'
import type { Env } from '../types'
import {
  countMkvidRequests,
  getMkvidLastPoll,
  listMkvidDjs,
  MKVID_ACCOUNTS,
  MKVID_SOURCES,
  MKVID_STATUSES,
  mkvidAccountUsage,
  quotaDayEnd,
  requestSummary,
  rowToRequest,
  type MkvidRequest,
  type MkvidRow,
} from '../lib/mkvid'
import { readinessFor } from '../lib/mkvid-readiness'
import { countOldStyleVideos, listUndeletedOldVideos } from '../lib/mkvid-recreate'
import { parseTableQuery, runTableQuery, tableErrorBody, TableQueryError, type TableColumn, type TableDef, type TableQuery } from '../lib/table-query'
import { dbOf } from '../lib/db'

export const mkvidUiApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

type QueueDbRow = MkvidRow & { position?: number | null }

/** The columns both lists share (stored seconds; filters take unix ms like every datetime). */
const COLUMNS: Record<string, TableColumn<QueueDbRow>> = {
  id: { type: 'text', filterable: false },
  setDate: { sql: 'set_date', type: 'date' },
  setTitle: { sql: "COALESCE(set_title, '')", type: 'text', searchable: true },
  setUrl: { sql: 'set_url', type: 'text', sortable: false, searchable: true },
  artistName: { sql: "COALESCE(artist_name, '')", type: 'text', searchable: true, sortable: false },
  // The DJ, by slug: the DJ select filters `eq:<slug>`.
  dj: { sql: 'slug', type: 'text', searchable: true },
  source: { type: 'enum', options: MKVID_SOURCES },
  account: { type: 'enum', options: MKVID_ACCOUNTS },
  status: { type: 'enum', options: MKVID_STATUSES },
  attempts: { type: 'number' },
  createdAt: { sql: 'created_at', type: 'datetime', storage: 's' },
  updatedAt: { sql: 'updated_at', type: 'datetime', storage: 's' },
  notBefore: { sql: 'not_before', type: 'datetime', storage: 's' },
  videoId: { sql: 'video_id', type: 'text' },
  privacy: { type: 'enum' },
  style: { type: 'enum' },
  error: { type: 'text', sortable: false, searchable: true },
}

/** Claim order (lib/mkvid.ts QUEUE_ORDER): newest set first, undated last, ties by most recently queued. */
export const MKVID_QUEUE_TABLE: TableDef<QueueDbRow> = {
  from: "(SELECT *, ROW_NUMBER() OVER (ORDER BY sort_key DESC, created_at DESC, rowid ASC) AS position FROM mkvid_requests WHERE status = 'pending')",
  primaryKey: 'id',
  defaultSort: 'position',
  columns: { ...COLUMNS, position: { type: 'number' } },
}

export const MKVID_FINISHED_TABLE: TableDef<QueueDbRow> = {
  from: 'mkvid_requests',
  where: "status IN ('done', 'failed', 'superseded', 'banned')",
  primaryKey: 'id',
  defaultSort: '-updatedAt',
  columns: COLUMNS,
}

type Ctx = Context<{ Bindings: Env; Variables: { cfAccessEmail: string } }>

/** A table answer whose rows are requestSummary + readiness (+ position in the queue). */
async function requestTable(c: Ctx, def: TableDef<QueueDbRow>): Promise<Response> {
  let query: TableQuery
  try {
    query = parseTableQuery(new URL(c.req.url).searchParams, def)
  } catch (e) {
    if (e instanceof TableQueryError) return c.json(tableErrorBody(e), 400)
    throw e
  }
  const result = await runTableQuery<QueueDbRow>(dbOf(c.env), def, query)
  const reqs = result.rows.map((r) => ({ req: rowToRequest(r), position: r.position == null ? null : Number(r.position) }))
  const readiness = await readinessFor(c.env, reqs.map((x) => x.req).filter((r) => r.status !== 'done' && r.status !== 'superseded'))
  return c.json({
    ...result,
    rows: reqs.map((x) => ({ ...summaryOf(x.req, readiness.get(x.req.id) ?? null), ...(x.position != null ? { position: x.position } : {}) })),
  })
}

const summaryOf = (r: MkvidRequest, readiness: unknown) => ({ ...requestSummary(r), readiness })

mkvidUiApp.get('/api/mkvid/queue', (c) => requestTable(c, MKVID_QUEUE_TABLE))
mkvidUiApp.get('/api/mkvid/finished', (c) => requestTable(c, MKVID_FINISHED_TABLE))

/**
 * The mkvid header: the three things that decide whether anything moves (the
 * daily caps, how much of them is used, when mkvid last polled), the counts,
 * and the requests rendering now. The lists are the two table endpoints above.
 */
mkvidUiApp.get('/api/mkvid', async (c) => {
  const [counts, accounts, lastPoll, djs, oldStyleCount, oldVideos, claimed] = await Promise.all([
    countMkvidRequests(c.env),
    mkvidAccountUsage(c.env),
    getMkvidLastPoll(c.env),
    listMkvidDjs(c.env),
    countOldStyleVideos(c.env),
    listUndeletedOldVideos(c.env),
    dbOf(c.env).prepare("SELECT * FROM mkvid_requests WHERE status = 'claimed' ORDER BY claimed_at ASC LIMIT 10").all<MkvidRow>(),
  ])
  const rendering = claimed.results.map(rowToRequest)
  const readiness = await readinessFor(c.env, rendering)
  return c.json({
    enabled: !!c.env.MKVID_TOKEN,
    counts,
    /** Done videos made with a style other than scene (unknown counts): what "Recreate all old-style videos" would queue. */
    oldStyleCount,
    /** Videos a recreation replaced that are not deleted from YouTube yet (pending retry, or refused by mkvid). */
    oldVideos,
    /** Per Google project (fill order): today's claims vs cap. The totals below are their sums. */
    accounts,
    dailyClaims: accounts.reduce((n, a) => n + a.used, 0),
    dailyClaimCap: accounts.reduce((n, a) => n + a.cap, 0),
    /** Unix seconds when the quota day rolls over (midnight Pacific). */
    quotaResetsAt: quotaDayEnd(),
    /** mkvid's last `/mkvid/claim` poll; `at` is refreshed at most every 10 min while the outcome is unchanged. */
    lastPoll,
    now: Math.floor(Date.now() / 1000),
    /** Every DJ the queue has ever held, most requests first: the DJ filter's options. */
    djs,
    /** Requests mkvid has claimed and is working on (oldest claim first). */
    rendering: rendering.map((r) => summaryOf(r, readiness.get(r.id) ?? null)),
  })
})
