/**
 * Pre-save routes (lib/presave.ts).
 *
 * Tasker (bearer API_TOKEN, registered in index.ts with app.openapi like /likes):
 *   POST /presave         save a track to watch → 200 { ok, created, presave, message }
 *   GET  /presave/status  ?trackId= | ?trackUrl= → { presave | null }
 *
 * Admin UI (CF Access, mounted at /ui/api by routes/subscriptions.ts):
 *   GET    /presaves               data table (lib/table-query.ts) + counts per stage
 *   POST   /presaves               same body and answer as POST /presave (source ui)
 *   POST   /presaves/lookup        { trackIds?, setUrl? } → { byTrackId, byRow }
 *   GET    /presaves/:id           { presave, upload }
 *   GET    /presaves/:id/checks    data table over its checks
 *   POST   /presaves/:id/recheck   { presave, check } (503 pool_busy on a refusal, the check recorded)
 *   POST   /presaves/:id/dismiss   { presave }
 *   POST   /presaves/:id/restore   { presave }
 *   DELETE /presaves/:id           { deleted: true }
 */
import { createRoute, z, type RouteHandler } from '@hono/zod-openapi'
import { Hono, type Context } from 'hono'
import type { Env } from '../types'
import { bearerAuth } from '../middleware/auth'
import { errorFields, makeLogger } from '../lib/log'
import { getAppSettings, type AppSettings } from '../lib/app-settings'
import { tableResponse, type TableDef } from '../lib/table-query'
import { getTrackUploadForPresave } from '../lib/track-uploads'
import {
  addPresave,
  deletePresave,
  dismissPresave,
  findPresave,
  getPresaveRow,
  lookupPresaves,
  presaveCheckOut,
  presaveOut,
  presaveStageCounts,
  PresaveInputError,
  recheckPresave,
  restorePresave,
  PRESAVE_LINK_SOURCES,
  PRESAVE_RESULTS,
  PRESAVE_SOURCES,
  PRESAVE_STAGES,
  PRESAVE_TRIGGERS,
  type PresaveCheckOut,
  type PresaveCheckRow,
  type PresaveOut,
  type PresaveRow,
  type PresaveSource,
} from '../lib/presave'
import { ErrorResponse } from '../schemas'

// ─── schemas (OpenAPI) ──────────────────────────────────────────────────────

const LinkEntrySchema = z
  .object({
    source: z.string().openapi({ example: '36', description: "1001tracklists' medialink source code." }),
    name: z.string().openapi({ example: 'spotify', description: 'spotify | apple | soundcloud | youtube | beatport | traxsource | a site named by its player host | src<code>' }),
    url: z.string().nullable().openapi({ example: 'https://open.spotify.com/track/5ly24DpozyrKv1FFDivUHx' }),
    playerId: z.string().nullable(),
    duration: z.number().int().nullable().openapi({ description: 'Seconds, when 1001tracklists reports one.' }),
  })
  .openapi('PresaveLink')

const ms = (d: string) => z.number().int().nullable().openapi({ description: `${d} (unix ms).` })

export const PresaveOutSchema = z
  .object({
    id: z.number().int(),
    trackId: z.string().nullable().openapi({ example: '909720', description: 'Numeric 1001tracklists medialink id; null until the row is identified.' }),
    trackUrl: z.string().nullable(),
    setUrl: z.string().nullable(),
    rowIndex: z.number().int().nullable().openapi({ description: '0-based page row of setUrl (anonymous rows counted).' }),
    cueSeconds: z.number().int().nullable(),
    artist: z.string().nullable(),
    title: z.string().nullable(),
    artworkUrl: z.string().nullable(),
    label: z.string().nullable(),
    djSlug: z.string().nullable(),
    stage: z.enum(PRESAVE_STAGES).openapi({ description: 'identify (no track id yet) → links (watching for a YouTube link) → found | uploaded; dismissed.' }),
    links: z.array(LinkEntrySchema),
    linkSources: z.array(z.string()),
    linkCount: z.number().int(),
    durationSeconds: z.number().int().nullable(),
    youtubeVideoId: z.string().nullable(),
    youtubeUrl: z.string().nullable(),
    youtubeMusicUrl: z.string().nullable().openapi({ example: 'https://music.youtube.com/watch?v=h8CtvP1rEy8' }),
    source: z.string(),
    createdAt: z.number().int(),
    updatedAt: z.number().int(),
    lastCheckedAt: ms('Last check'),
    nextCheckAt: ms('Next scheduled check; null once found, uploaded or dismissed'),
    checkCount: z.number().int(),
    failCount: z.number().int(),
    lastResult: z.string().nullable(),
    lastError: z.string().nullable(),
    identifiedAt: ms('When the row was identified'),
    foundAt: ms('When 1001tracklists had a YouTube link'),
    notifiedAt: ms('When the push went out'),
    dismissedAt: ms('When it was dismissed'),
    uploadEligibleAt: z.number().int().openapi({ description: 'createdAt + trackUploads.minWatchDays (unix ms).' }),
  })
  .openapi('Presave')

const optStr = z.string().nullable().optional()
const optInt = z.coerce.number().int().min(0).nullable().optional()

export const PresaveRequest = z
  .object({
    trackId: z.union([z.string(), z.number().int()]).nullable().optional().openapi({ example: '909720', description: 'Numeric 1001tracklists track id (the /now-playing and /tracklist trackId).' }),
    trackUrl: optStr.openapi({ example: 'https://www.1001tracklists.com/track/1hf79cg5/tobehonest-where-ya-at/index.html' }),
    tracklistUrl: optStr.openapi({ description: 'The set it was heard in. With rowIndex or cueSeconds it identifies a row that has no id (an "ID" row).' }),
    rowIndex: optInt.openapi({ description: '0-based page row (the /now-playing rowIndex).' }),
    cueSeconds: optInt.openapi({ description: "The row's cue in seconds; matches the row when rowIndex is missing." }),
    artist: optStr.openapi({ description: '"ID" counts as unknown.' }),
    title: optStr,
    artworkUrl: optStr,
  })
  .refine(
    (b) => {
      const id = b.trackId !== undefined && b.trackId !== null && String(b.trackId).trim() !== ''
      return id || !!b.trackUrl || (!!b.tracklistUrl && (b.rowIndex != null || b.cueSeconds != null))
    },
    { message: 'give a trackId, a trackUrl, or a tracklistUrl with rowIndex or cueSeconds', path: ['trackId'] },
  )
  .openapi('PresaveRequest')

export const PresaveResponse = z
  .object({
    ok: z.literal(true),
    created: z.boolean().openapi({ description: 'false when it was already pre-saved (a dismissed one is watched again).' }),
    presave: PresaveOutSchema,
    message: z.string().openapi({ example: 'Pre-saved: TOBEHONEST – Where Ya At (watching for a YouTube link)', description: 'One line for a flash.' }),
  })
  .openapi('PresaveResponse')

export const presaveRoute = createRoute({
  method: 'post',
  path: '/presave',
  middleware: [bearerAuth] as const,
  security: [{ bearerAuth: [] }],
  summary: 'Pre-save a track: watch it until 1001tracklists has a YouTube link',
  request: { body: { content: { 'application/json': { schema: PresaveRequest } }, required: true } },
  responses: {
    200: { content: { 'application/json': { schema: PresaveResponse } }, description: 'Saved (or already saved). The immediate check ran unless the pool refused; that never fails the save.' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Bad input' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid bearer token' },
  },
})

export const presaveStatusRoute = createRoute({
  method: 'get',
  path: '/presave/status',
  middleware: [bearerAuth] as const,
  security: [{ bearerAuth: [] }],
  summary: 'Whether a track is pre-saved, and its state',
  request: { query: z.object({ trackId: z.string().optional(), trackUrl: z.string().optional() }) },
  responses: {
    200: { content: { 'application/json': { schema: z.object({ presave: PresaveOutSchema.nullable() }) } }, description: 'The presave, or null' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid bearer token' },
  },
})

// ─── shared save ────────────────────────────────────────────────────────────

type SaveBody = z.infer<typeof PresaveRequest> & { setUrl?: string | null; label?: string | null; djSlug?: string | null; check?: boolean }

async function save(env: Env, body: SaveBody, source: PresaveSource, log: ReturnType<typeof makeLogger>): Promise<{ status: 200; body: { ok: true; created: boolean; presave: PresaveOut; message: string } } | { status: 400; body: { error: string; message: string } }> {
  try {
    const r = await addPresave(
      env,
      {
        trackId: body.trackId ?? null,
        trackUrl: body.trackUrl ?? null,
        setUrl: body.tracklistUrl ?? body.setUrl ?? null,
        rowIndex: body.rowIndex ?? null,
        cueSeconds: body.cueSeconds ?? null,
        artist: body.artist ?? null,
        title: body.title ?? null,
        artworkUrl: body.artworkUrl ?? null,
        label: body.label ?? null,
        djSlug: body.djSlug ?? null,
      },
      source,
      { log, check: body.check !== false },
    )
    const settings = await getAppSettings(env)
    return { status: 200, body: { ok: true, created: r.created, presave: presaveOut(r.presave, settings), message: r.message } }
  } catch (e) {
    if (e instanceof PresaveInputError) return { status: 400, body: { error: 'invalid_request', message: e.message } }
    throw e
  }
}

export const presaveHandler: RouteHandler<typeof presaveRoute, { Bindings: Env }> = async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'presave' })
  try {
    const r = await save(c.env, c.req.valid('json'), 'tasker', log)
    return r.status === 200 ? c.json(r.body, 200) : c.json(r.body, 400)
  } catch (e) {
    log.error('presave.threw', errorFields(e))
    return c.json({ error: 'internal', message: e instanceof Error ? e.message : String(e) }, 500 as 400)
  }
}

export const presaveStatusHandler: RouteHandler<typeof presaveStatusRoute, { Bindings: Env }> = async (c) => {
  const q = c.req.valid('query')
  const p = await findPresave(c.env, { trackId: q.trackId ?? null, trackUrl: q.trackUrl ?? null })
  return c.json({ presave: p ? presaveOut(p, await getAppSettings(c.env)) : null }, 200)
}

// ─── the admin UI API ───────────────────────────────────────────────────────

function presavesTable(settings: AppSettings): TableDef<PresaveRow, PresaveOut> {
  return {
    from: 'presaves',
    primaryKey: 'id',
    defaultSort: '-createdAt',
    columns: {
      id: { sql: 'id', type: 'number' },
      artist: { sql: 'artist', type: 'text', searchable: true },
      title: { sql: 'title', type: 'text', searchable: true },
      stage: { sql: 'stage', type: 'enum', options: PRESAVE_STAGES },
      linkSources: { sql: "COALESCE(link_sources, ',none,')", type: 'enum', multi: true, sortable: false, options: PRESAVE_LINK_SOURCES },
      linkCount: { sql: 'link_count', type: 'number' },
      durationSeconds: { sql: 'duration_seconds', type: 'number' },
      createdAt: { sql: 'created_at', type: 'datetime', storage: 'ms' },
      lastCheckedAt: { sql: 'last_checked_at', type: 'datetime', storage: 'ms' },
      nextCheckAt: { sql: 'next_check_at', type: 'datetime', storage: 'ms' },
      foundAt: { sql: 'found_at', type: 'datetime', storage: 'ms' },
      checkCount: { sql: 'check_count', type: 'number' },
      lastResult: { sql: 'last_result', type: 'enum', options: PRESAVE_RESULTS },
      source: { sql: 'source', type: 'enum', options: PRESAVE_SOURCES },
      djSlug: { sql: 'dj_slug', type: 'text', searchable: true },
      setUrl: { sql: 'set_url', type: 'text', searchable: true },
    },
    mapRow: (r) => presaveOut(r, settings),
  }
}

const CHECKS_TABLE: TableDef<PresaveCheckRow, PresaveCheckOut> = {
  from: 'presave_checks',
  primaryKey: 'id',
  defaultSort: '-at',
  columns: {
    id: { sql: 'id', type: 'number' },
    at: { sql: 'at', type: 'datetime', storage: 'ms' },
    trigger: { sql: 'trigger', type: 'enum', options: PRESAVE_TRIGGERS },
    result: { sql: 'result', type: 'enum', options: PRESAVE_RESULTS },
    stageBefore: { sql: 'stage_before', type: 'enum', options: PRESAVE_STAGES },
    stageAfter: { sql: 'stage_after', type: 'enum', options: PRESAVE_STAGES },
    linkCount: { sql: 'link_count', type: 'number' },
    linkSources: { sql: "COALESCE(link_sources, ',none,')", type: 'enum', multi: true, sortable: false },
    youtubeVideoId: { sql: 'youtube_video_id', type: 'text' },
    error: { sql: 'error', type: 'text', searchable: true },
    ms: { sql: 'ms', type: 'number' },
  },
  mapRow: (r) => presaveCheckOut(r),
}

export const presaveUiApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

const uiLog = (c: Context<{ Bindings: Env; Variables: { cfAccessEmail: string } }>, route: string) =>
  makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route, by: c.get('cfAccessEmail') })

const idOf = (raw: string): number | null => (/^\d{1,12}$/.test(raw) ? Number(raw) : null)

presaveUiApp.get('/presaves', async (c) => {
  const settings = await getAppSettings(c.env)
  return tableResponse(c, presavesTable(settings), c.env.DB, { extra: async () => ({ counts: await presaveStageCounts(c.env) }) })
})

presaveUiApp.post('/presaves', async (c) => {
  const log = uiLog(c, 'subs.presave_add')
  const raw = await c.req.json().catch(() => undefined)
  const parsed = PresaveRequest.safeParse(raw ?? {})
  if (!parsed.success) return c.json({ error: 'invalid_request', message: parsed.error.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`).join('; ') }, 400)
  const extra = (raw ?? {}) as { setUrl?: unknown; label?: unknown; djSlug?: unknown; check?: unknown }
  const body: SaveBody = {
    ...parsed.data,
    setUrl: typeof extra.setUrl === 'string' ? extra.setUrl : null,
    label: typeof extra.label === 'string' ? extra.label : null,
    djSlug: typeof extra.djSlug === 'string' ? extra.djSlug : null,
    check: extra.check !== false,
  }
  const r = await save(c.env, body, 'ui', log)
  return r.status === 200 ? c.json(r.body, 200) : c.json(r.body, 400)
})

// Registered before /presaves/:id so "lookup" is never read as an id.
presaveUiApp.post('/presaves/lookup', async (c) => {
  const body = ((await c.req.json().catch(() => ({}))) ?? {}) as { trackIds?: unknown; setUrl?: unknown }
  const trackIds = Array.isArray(body.trackIds) ? body.trackIds.map((x) => String(x)) : []
  const setUrl = typeof body.setUrl === 'string' ? body.setUrl : null
  return c.json(await lookupPresaves(c.env, { trackIds, setUrl }))
})

presaveUiApp.get('/presaves/:id', async (c) => {
  const id = idOf(c.req.param('id'))
  const p = id === null ? null : await getPresaveRow(c.env, id)
  if (!p) return c.json({ error: 'not_found' }, 404)
  return c.json({ presave: presaveOut(p, await getAppSettings(c.env)), upload: await getTrackUploadForPresave(c.env, p.id).catch(() => null) })
})

presaveUiApp.get('/presaves/:id/checks', async (c) => {
  const id = idOf(c.req.param('id'))
  if (id === null || !(await getPresaveRow(c.env, id))) return c.json({ error: 'not_found' }, 404)
  return tableResponse(c, CHECKS_TABLE, c.env.DB, { where: 'presave_id = ?', binds: [id] })
})

presaveUiApp.post('/presaves/:id/recheck', async (c) => {
  const log = uiLog(c, 'subs.presave_recheck')
  const id = idOf(c.req.param('id'))
  const r = id === null ? null : await recheckPresave(c.env, id, 'manual', { log })
  if (!r) return c.json({ error: 'not_found' }, 404)
  const settings = await getAppSettings(c.env)
  const out = { presave: presaveOut(r.presave, settings), check: r.check ? presaveCheckOut(r.check) : null }
  if (r.refused) return c.json({ error: 'pool_busy', message: `The pool would not look it up now: ${r.refused.message}`, ...out }, 503)
  return c.json(out)
})

presaveUiApp.post('/presaves/:id/dismiss', async (c) => {
  const id = idOf(c.req.param('id'))
  const p = id === null ? null : await dismissPresave(c.env, id)
  if (!p) return c.json({ error: 'not_found' }, 404)
  return c.json({ presave: presaveOut(p, await getAppSettings(c.env)) })
})

presaveUiApp.post('/presaves/:id/restore', async (c) => {
  const id = idOf(c.req.param('id'))
  const p = id === null ? null : await restorePresave(c.env, id)
  if (!p) return c.json({ error: 'not_found' }, 404)
  return c.json({ presave: presaveOut(p, await getAppSettings(c.env)) })
})

presaveUiApp.delete('/presaves/:id', async (c) => {
  const id = idOf(c.req.param('id'))
  if (id === null || !(await deletePresave(c.env, id))) return c.json({ error: 'not_found' }, 404)
  return c.json({ deleted: true })
})
