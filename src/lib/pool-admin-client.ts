/**
 * Thin typed client for the tlpool ADMIN routes (contract v1, see the pool
 * spec): accounts, challenges, status and tlpool's own settings. The fetch
 * path (`POST /fetch`) lives in `lib/pool.ts`, not here.
 *
 * Two rules this module exists to enforce:
 *
 * 1. The bearer `TLPOOL_TOKEN` and the `TLPOOL_URL` never reach a browser.
 *    Every error is a `PoolAdminError` with a fixed code; nothing from a
 *    thrown fetch (whose message carries the URL) or an upstream body is
 *    echoed, except a short snake_case error code.
 * 2. No credential ever reaches a page. Every upstream object is rebuilt
 *    from a WHITELIST of fields (a blacklist would miss a field name nobody
 *    anticipated), so a username, email or password tlpool might add later
 *    is dropped here.
 *
 * tlpool is Python, so the normalisers accept snake_case aliases as well as
 * the camelCase the contract uses.
 */
import type { Env } from '../types'

/** The two vars live here, not in `types.ts`, so this file has no shared edits. */
export type PoolEnv = Env & { TLPOOL_URL?: string; TLPOOL_TOKEN?: string }

export type Fetcher = (input: Request | string, init?: RequestInit) => Promise<Response>

export type PoolErrorCode =
  | 'pool_not_configured'
  | 'pool_unreachable'
  | 'pool_auth_failed'
  | 'pool_error'
  | 'bad_response'
  | 'not_found'
  | 'conflict'
  | 'expired'
  | 'invalid'
  | 'too_many'

export class PoolAdminError extends Error {
  constructor(
    readonly code: PoolErrorCode,
    /** HTTP status the Worker should answer the browser with. */
    readonly status: 400 | 404 | 409 | 410 | 422 | 429 | 503,
    /** Short snake_case code tlpool gave, when it gave one (safe to show). */
    readonly detail: string | null = null,
    readonly upstreamStatus: number | null = null,
  ) {
    super(code)
    this.name = 'PoolAdminError'
  }
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const ACCOUNT_ACTIONS = ['rest', 'retire', 'retest'] as const
export type AccountAction = (typeof ACCOUNT_ACTIONS)[number]

export type PoolAccount = {
  id: string
  state: string
  passive: boolean
  exitLabel: string | null
  exitKind: string | null
  usedToday: number | null
  budget: number | null
  rampDay: number | null
  lastOkAt: string | null
  lastChallengeAt: string | null
  flagged: boolean
  flagReason: string | null
  restUntil: string | null
}

export type PoolStatus = {
  accounts: PoolAccount[]
  queueDepth: number | null
  queueByPriority: Record<string, number>
  requestsToday: number | null
  requestsByPriority: Record<string, number>
}

export type ChallengeState = 'pending' | 'solved' | 'expired' | 'failed'

export type PoolChallenge = {
  id: string
  type: 'image' | 'checkbox'
  accountId: string | null
  /** Why the challenge exists: signup, login, fetch, retest… (snake_case code). */
  reason: string | null
  state: ChallengeState
  createdAt: string | null
  expiresAt: string | null
  /** Signup progress step, when the challenge belongs to an account creation. */
  step: string | null
  /** Short error code when the flow behind the challenge failed. */
  error: string | null
}

export type PoolSettings = {
  budgetPerDay: number | null
  /** Page budgets for the first days of a new account, e.g. [10, 20]; full budget after. */
  ramp: number[] | null
  /** Fraction 0..1 of each day's budget held back for the phone button. */
  reservedPhoneShare: number | null
  imagePolicy: string | null
}

export type AnswerOutcome = 'solved' | 'wrong' | 'expired' | 'accepted'

// ── small parsers ──────────────────────────────────────────────────────────

type Obj = Record<string, unknown>
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v)

function pick(o: Obj, ...keys: string[]): unknown {
  for (const k of keys) if (o[k] !== undefined && o[k] !== null) return o[k]
  return undefined
}
function num(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return null
}
/** A bounded plain label (exit label, state…): printable, no angle brackets, max 64. */
function label(v: unknown): string | null {
  if (typeof v !== 'string' && typeof v !== 'number') return null
  const s = String(v).trim()
  if (!s || s.length > 64 || /[\u0000-\u001f<>]/.test(s)) return null
  return s
}
function code(v: unknown): string | null {
  return typeof v === 'string' && /^[a-z][a-z0-9_]{0,47}$/.test(v) ? v : null
}
function opaqueId(v: unknown): string | null {
  if (typeof v === 'number') v = String(v)
  if (isObj(v)) v = v.id
  return typeof v === 'string' && ID_RE.test(v) ? v : null
}
function iso(v: unknown): string | null {
  if (typeof v === 'number' && Number.isFinite(v)) {
    // Python timestamps: seconds since epoch.
    const ms = v < 1e12 ? v * 1000 : v
    return new Date(ms).toISOString()
  }
  if (typeof v !== 'string') return null
  const t = Date.parse(v)
  return Number.isFinite(t) ? new Date(t).toISOString() : null
}
function bool(v: unknown): boolean {
  return v === true || v === 1 || v === 'true' || v === '1'
}
function countMap(v: unknown): Record<string, number> {
  const out: Record<string, number> = {}
  if (!isObj(v)) return out
  for (const [k, x] of Object.entries(v)) {
    const n = num(x)
    if (n !== null && code(k)) out[k] = n
  }
  return out
}

// ── normalisers (whitelists) ───────────────────────────────────────────────

export function normalizeAccount(raw: unknown): PoolAccount | null {
  if (!isObj(raw)) return null
  const id = opaqueId(pick(raw, 'id', 'accountId', 'account_id'))
  if (!id) return null
  const exit = isObj(raw.exit) ? raw.exit : {}
  const state = label(pick(raw, 'state', 'status')) ?? 'unknown'
  const flagRaw = pick(raw, 'flagged', 'flaggedAt', 'flagged_at')
  return {
    id,
    state,
    passive: bool(raw.passive),
    exitLabel: label(pick(raw, 'exitLabel', 'exit_label') ?? pick(exit, 'label', 'name')),
    exitKind: label(pick(raw, 'exitKind', 'exit_kind') ?? pick(exit, 'kind', 'type')),
    usedToday: num(pick(raw, 'usedToday', 'used_today', 'used')),
    budget: num(pick(raw, 'budget', 'budgetToday', 'budget_today')),
    rampDay: num(pick(raw, 'rampDay', 'ramp_day')),
    lastOkAt: iso(pick(raw, 'lastOkAt', 'last_ok_at', 'lastOk', 'last_ok', 'lastSuccessAt', 'last_success_at')),
    lastChallengeAt: iso(pick(raw, 'lastChallengeAt', 'last_challenge_at', 'lastChallenge', 'last_challenge')),
    flagged: state === 'flagged' || (flagRaw !== undefined && flagRaw !== false && flagRaw !== 0),
    flagReason: code(pick(raw, 'flagReason', 'flag_reason')),
    restUntil: iso(pick(raw, 'restUntil', 'rest_until', 'restingUntil', 'resting_until')),
  }
}

function accountList(v: unknown): PoolAccount[] {
  const arr = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.accounts) ? v.accounts : []
  return arr.map(normalizeAccount).filter((a): a is PoolAccount => a !== null)
}

export function normalizeStatus(raw: unknown): PoolStatus {
  if (!isObj(raw)) throw new PoolAdminError('bad_response', 503)
  const q = pick(raw, 'queueDepth', 'queue_depth', 'queue')
  const totals = isObj(raw.totals) ? raw.totals : {}
  const queueByPriority = isObj(q) ? countMap(q) : {}
  const queueDepth = isObj(q) ? Object.values(queueByPriority).reduce((a, b) => a + b, 0) : num(q)
  const requestsByPriority = countMap(pick(totals, 'byPriority', 'by_priority') ?? pick(raw, 'byPriority', 'by_priority'))
  let requestsToday = num(pick(totals, 'requestsToday', 'requests_today', 'today', 'total') ?? pick(raw, 'requestsToday', 'requests_today'))
  if (requestsToday === null && Object.keys(requestsByPriority).length) requestsToday = Object.values(requestsByPriority).reduce((a, b) => a + b, 0)
  return { accounts: accountList(raw.accounts), queueDepth, queueByPriority, requestsToday, requestsByPriority }
}

const CHALLENGE_STATES: Record<string, ChallengeState> = {
  pending: 'pending', open: 'pending', waiting: 'pending', active: 'pending',
  solved: 'solved', done: 'solved', answered: 'solved', ok: 'solved',
  expired: 'expired', closed: 'expired', timeout: 'expired', abandoned: 'expired',
  failed: 'failed', error: 'failed',
}

export function normalizeChallenge(raw: unknown, fallbackId?: string): PoolChallenge | null {
  if (!isObj(raw)) return null
  const id = opaqueId(pick(raw, 'id', 'challengeId', 'challenge_id')) ?? (fallbackId && ID_RE.test(fallbackId) ? fallbackId : null)
  if (!id) return null
  const signup = isObj(raw.signup) ? raw.signup : {}
  const t = String(pick(raw, 'type', 'kind') ?? 'image').toLowerCase()
  const createdAt = iso(pick(raw, 'createdAt', 'created_at'))
  let expiresAt = iso(pick(raw, 'expiresAt', 'expires_at'))
  // The spec holds every challenge 2 hours.
  if (!expiresAt && createdAt) expiresAt = new Date(Date.parse(createdAt) + 2 * 3600_000).toISOString()
  return {
    id,
    type: t === 'checkbox' || t === 'turnstile' ? 'checkbox' : 'image',
    accountId: opaqueId(pick(raw, 'account', 'accountId', 'account_id')),
    reason: code(pick(raw, 'reason', 'why', 'purpose')),
    state: CHALLENGE_STATES[String(pick(raw, 'state', 'status') ?? 'pending').toLowerCase()] ?? 'pending',
    createdAt,
    expiresAt,
    step: code(pick(raw, 'step') ?? pick(signup, 'step')),
    error: code(pick(raw, 'error') ?? pick(signup, 'error')),
  }
}

function challengeList(v: unknown): PoolChallenge[] {
  const arr = Array.isArray(v) ? v : isObj(v) && Array.isArray(v.challenges) ? v.challenges : []
  return arr.map((x) => normalizeChallenge(x)).filter((c): c is PoolChallenge => c !== null)
}

export function normalizeSettings(raw: unknown): PoolSettings {
  if (!isObj(raw)) throw new PoolAdminError('bad_response', 503)
  let ramp: number[] | null = null
  const r = pick(raw, 'ramp', 'rampSchedule', 'ramp_schedule')
  if (Array.isArray(r)) ramp = r.map(num).filter((n): n is number => n !== null)
  else if (isObj(r)) ramp = Object.keys(r).sort().map((k) => num(r[k])).filter((n): n is number => n !== null)
  let share = num(pick(raw, 'reservedPhoneShare', 'reserved_phone_share', 'phoneShare', 'phone_share'))
  if (share !== null && share > 1) share = share / 100
  return {
    budgetPerDay: num(pick(raw, 'budgetPerDay', 'budget_per_day', 'pagesPerDay', 'pages_per_day', 'budget')),
    ramp,
    reservedPhoneShare: share,
    imagePolicy: code(pick(raw, 'imagePolicy', 'image_policy')),
  }
}

/** Validates a browser-sent settings patch; only these four fields ever reach tlpool. */
export function validateSettingsPatch(body: unknown): Partial<PoolSettings> {
  if (!isObj(body)) throw new PoolAdminError('invalid', 400, 'body_not_object')
  const out: Partial<PoolSettings> = {}
  if (body.budgetPerDay !== undefined) {
    const n = num(body.budgetPerDay)
    if (n === null || !Number.isInteger(n) || n < 0 || n > 1000) throw new PoolAdminError('invalid', 400, 'budget_per_day')
    out.budgetPerDay = n
  }
  if (body.ramp !== undefined) {
    if (!Array.isArray(body.ramp) || body.ramp.length > 14) throw new PoolAdminError('invalid', 400, 'ramp')
    const ramp = body.ramp.map(num)
    if (ramp.some((n) => n === null || !Number.isInteger(n) || n < 0 || n > 1000)) throw new PoolAdminError('invalid', 400, 'ramp')
    out.ramp = ramp as number[]
  }
  if (body.reservedPhoneShare !== undefined) {
    const n = num(body.reservedPhoneShare)
    if (n === null || n < 0 || n > 0.9) throw new PoolAdminError('invalid', 400, 'reserved_phone_share')
    out.reservedPhoneShare = n
  }
  if (body.imagePolicy !== undefined) {
    const c = code(body.imagePolicy)
    if (!c) throw new PoolAdminError('invalid', 400, 'image_policy')
    out.imagePolicy = c
  }
  if (!Object.keys(out).length) throw new PoolAdminError('invalid', 400, 'nothing_to_change')
  return out
}

// ── the client ─────────────────────────────────────────────────────────────

const STATUS_MAP: Record<number, [PoolErrorCode, PoolAdminError['status']]> = {
  400: ['invalid', 400],
  404: ['not_found', 404],
  409: ['conflict', 409],
  410: ['expired', 410],
  422: ['invalid', 422],
  429: ['too_many', 429],
}

/** Headers a browser may usefully pass through to the live view (noVNC page, assets, websocket). */
const LIVE_REQ_HEADERS = ['accept', 'accept-encoding', 'content-type', 'upgrade', 'connection', 'sec-websocket-key', 'sec-websocket-version', 'sec-websocket-protocol', 'sec-websocket-extensions', 'if-none-match', 'if-modified-since']
const LIVE_RES_HEADERS = ['content-type', 'content-length', 'content-encoding', 'etag', 'last-modified']

export type PoolAdminClient = ReturnType<typeof createPoolAdminClient>

export function createPoolAdminClient(env: PoolEnv, fetcher: Fetcher = (i, init) => fetch(i, init)) {
  const base = (env.TLPOOL_URL ?? '').trim().replace(/\/+$/, '')
  const token = (env.TLPOOL_TOKEN ?? '').trim()
  const configured = Boolean(base && token)

  async function raw(method: string, path: string, opts: { body?: unknown; timeoutMs?: number; headers?: Record<string, string> } = {}): Promise<Response> {
    if (!configured) throw new PoolAdminError('pool_not_configured', 503)
    const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: 'application/json', ...(opts.headers ?? {}) }
    let body: string | undefined
    if (opts.body !== undefined) {
      headers['Content-Type'] = 'application/json'
      body = JSON.stringify(opts.body)
    }
    let r: Response
    try {
      r = await fetcher(base + path, { method, headers, body, signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) })
    } catch {
      // Never propagate the message: it names TLPOOL_URL.
      throw new PoolAdminError('pool_unreachable', 503)
    }
    if (r.ok) return r
    const detail = await r
      .clone()
      .json()
      .then((j: unknown) => (isObj(j) ? code(pick(j, 'error', 'code', 'detail')) : null))
      .catch(() => null)
    if (r.status === 401 || r.status === 403) throw new PoolAdminError('pool_auth_failed', 503, null, r.status)
    const mapped = STATUS_MAP[r.status]
    if (mapped) throw new PoolAdminError(mapped[0], mapped[1], detail, r.status)
    throw new PoolAdminError('pool_error', 503, detail, r.status)
  }

  async function json(method: string, path: string, opts: { body?: unknown; timeoutMs?: number } = {}): Promise<unknown> {
    const r = await raw(method, path, opts)
    try {
      return await r.json()
    } catch {
      throw new PoolAdminError('bad_response', 503)
    }
  }

  const seg = (id: string): string => {
    if (!ID_RE.test(id)) throw new PoolAdminError('invalid', 400, 'bad_id')
    return encodeURIComponent(id)
  }

  return {
    configured,

    async status(): Promise<PoolStatus> {
      return normalizeStatus(await json('GET', '/status'))
    },

    async listAccounts(): Promise<PoolAccount[]> {
      return accountList(await json('GET', '/accounts'))
    },

    /** Starts the signup flow; tlpool answers the id of the challenge that tracks it. */
    async createAccount(passive: boolean): Promise<{ challengeId: string; accountId: string | null }> {
      const j = await json('POST', '/accounts', { body: { passive }, timeoutMs: 30_000 })
      const o = isObj(j) ? j : {}
      const challengeId = opaqueId(pick(o, 'challengeId', 'challenge_id', 'challenge', 'id'))
      if (!challengeId) throw new PoolAdminError('bad_response', 503)
      return { challengeId, accountId: opaqueId(pick(o, 'accountId', 'account_id', 'account')) }
    },

    async accountAction(id: string, action: AccountAction): Promise<PoolAccount | null> {
      const j = await json('POST', `/accounts/${seg(id)}/${action}`, { body: {} }).catch((e) => {
        // An action that answers 204 / an empty body is still a success.
        if (e instanceof PoolAdminError && e.code === 'bad_response') return null
        throw e
      })
      return normalizeAccount(isObj(j) && isObj(j.account) ? j.account : j)
    },

    async listChallenges(): Promise<PoolChallenge[]> {
      return challengeList(await json('GET', '/challenges'))
    },

    async getChallenge(id: string): Promise<PoolChallenge> {
      const c = normalizeChallenge(await json('GET', `/challenges/${seg(id)}`), id)
      if (!c) throw new PoolAdminError('bad_response', 503)
      return c
    },

    /** The PNG screenshot. `refresh` asks tlpool for a fresh screenshot rather than the last one. */
    async challengeImage(id: string, refresh = false): Promise<{ body: ReadableStream | null; contentType: string }> {
      const r = await raw('GET', `/challenges/${seg(id)}/image${refresh ? '?refresh=1' : ''}`, { timeoutMs: 20_000, headers: { Accept: 'image/png,image/*' } })
      const ct = (r.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
      if (!ct.startsWith('image/')) throw new PoolAdminError('bad_response', 503)
      return { body: r.body, contentType: ct }
    },

    async answer(id: string, text: string): Promise<AnswerOutcome> {
      let j: unknown
      try {
        j = await json('POST', `/challenges/${seg(id)}/answer`, { body: { text }, timeoutMs: 30_000 })
      } catch (e) {
        if (e instanceof PoolAdminError) {
          if (e.code === 'expired' || (e.code === 'not_found' && e.detail !== 'bad_id')) return 'expired'
          if (e.code === 'invalid' && e.upstreamStatus === 422) return 'wrong'
          if (e.code === 'bad_response') return 'accepted'
        }
        throw e
      }
      const o = isObj(j) ? j : {}
      const s = String(pick(o, 'outcome', 'result', 'status', 'state') ?? '').toLowerCase()
      if (o.correct === false || s === 'wrong' || s === 'incorrect' || s === 'rejected') return 'wrong'
      if (s === 'expired' || s === 'closed') return 'expired'
      if (o.correct === true || s === 'solved' || s === 'ok' || s === 'correct') return 'solved'
      return 'accepted'
    },

    async getSettings(): Promise<PoolSettings> {
      return normalizeSettings(await json('GET', '/settings'))
    },

    async putSettings(patch: Partial<PoolSettings>): Promise<PoolSettings> {
      const j = await json('PUT', '/settings', { body: patch })
      return normalizeSettings(j)
    },

    /**
     * Raw pass-through for the noVNC live view: the page, its assets and the
     * websocket upgrade. Request headers are rebuilt from a whitelist (the
     * browser's Access cookie/JWT never reach tlpool); a 101 upgrade is
     * returned untouched (workerd cannot re-wrap one), anything else gets
     * fresh headers from a whitelist.
     */
    async live(id: string, subpath: string, search: string, req: Request): Promise<Response> {
      if (!configured) throw new PoolAdminError('pool_not_configured', 503)
      if (!/^[A-Za-z0-9._\-/]*$/.test(subpath) || subpath.split('/').some((p) => p === '..')) throw new PoolAdminError('invalid', 400, 'bad_path')
      const headers = new Headers()
      for (const h of LIVE_REQ_HEADERS) {
        const v = req.headers.get(h)
        if (v) headers.set(h, v)
      }
      headers.set('Authorization', `Bearer ${token}`)
      const isUpgrade = (req.headers.get('upgrade') ?? '').toLowerCase() === 'websocket'
      const target = `${base}/challenges/${seg(id)}/live/${subpath}${search}`
      let r: Response
      try {
        r = await fetcher(target, {
          method: req.method === 'HEAD' ? 'HEAD' : 'GET',
          headers,
          // A websocket lives as long as the owner looks at it; no timeout on it.
          signal: isUpgrade ? undefined : AbortSignal.timeout(20_000),
        })
      } catch {
        throw new PoolAdminError('pool_unreachable', 503)
      }
      if (r.status === 101) return r
      if (r.status === 401 || r.status === 403) throw new PoolAdminError('pool_auth_failed', 503, null, r.status)
      if (r.status === 404) throw new PoolAdminError('not_found', 404, null, 404)
      if (r.status === 410) throw new PoolAdminError('expired', 410, null, 410)
      if (r.status >= 500) throw new PoolAdminError('pool_error', 503, null, r.status)
      const out = new Headers()
      for (const h of LIVE_RES_HEADERS) {
        const v = r.headers.get(h)
        if (v) out.set(h, v)
      }
      out.set('Cache-Control', 'no-store')
      return new Response(r.body, { status: r.status, headers: out })
    },
  }
}
