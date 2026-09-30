/**
 * Events tlpool posts to the Worker (`POST /pool/events`, routes/pool-api.ts):
 * stored in D1 (`pool_events`, migration 0007) and, for the two that need the
 * owner, turned into a Web Push through lib/web-push.ts:
 *
 *   - `challenge.created` → "captcha waiting", opens /subscriptions/captcha/<id>
 *     (the page W8 builds: captcha image + answer box, or the live view for
 *     the checkbox wall)
 *   - `account.flagged`   → "account flagged", opens the captcha page when the
 *     event names a challenge, else /subscriptions/pool (the accounts page)
 *
 * Every push is sent immediately, at any hour (owner decision 2026-09-29: no
 * quiet hours). tlpool still holds a challenge for 2 h and then rests the
 * account 6 h; that is tlpool's, not this module's.
 *
 * Accepted body (liberal; unknown fields are ignored and never stored):
 *   { id?, type, challengeId? | challenge: { id, type, account, createdAt, expiresAt },
 *     accountId?, challengeType?, createdAt?, expiresAt?, priority?, phoneInitiated?, reason? }
 * Only ids matching tight patterns are kept (account ids must look like
 * `acct-N`), so a username can never end up in D1 or a push.
 */

import type { Env } from '../types'
import { dbOf, parseJson } from './db'
import type { Logger } from './log'
import { pushConfigured, sendPushToAll, type PushPayload } from './web-push'

/** Every event tlpool emits (tlpool/webhook.py EVENTS). Pushed: challenge.created, account.flagged, account.retired. */
export const POOL_EVENT_TYPES = ['challenge.created', 'challenge.solved', 'challenge.expired', 'account.flagged', 'account.created', 'account.retired', 'account.rested'] as const
export type PoolEventType = (typeof POOL_EVENT_TYPES)[number]

export type PoolEvent = {
  eventId: string | null
  type: PoolEventType
  challengeId: string | null
  accountId: string | null
  challengeType: 'image' | 'checkbox' | null
  createdAt: string | null
  expiresAt: string | null
  /** The fetch that hit the challenge was the phone button's (said in the push text). */
  phoneInitiated: boolean
  reason: string | null
}

export type PushStatus = 'none' | 'sent' | 'failed' | 'not_configured'

const ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/
const ACCOUNT_RE = /^acct-[A-Za-z0-9_-]{1,40}$/

const str = (x: unknown): string | null => (typeof x === 'string' && x.length > 0 ? x : null)
const id = (x: unknown): string | null => {
  const s = typeof x === 'number' && Number.isFinite(x) ? String(x) : str(x)
  return s && ID_RE.test(s) ? s : null
}
const account = (x: unknown): string | null => {
  const s = str(x)
  return s && ACCOUNT_RE.test(s) ? s : null
}
const iso = (x: unknown): string | null => {
  const s = str(x)
  return s && Number.isFinite(Date.parse(s)) ? new Date(Date.parse(s)).toISOString() : null
}
/** Free text from the pool, minus anything that looks like an address or a login. */
const safeReason = (x: unknown): string | null => {
  const s = str(x)
  if (!s) return null
  return s.replace(/\S+@\S+/g, '[redacted]').replace(/[^\x20-\x7E]/g, ' ').slice(0, 160).trim() || null
}

/** Validate and whitelist an incoming event. */
export function sanitizePoolEvent(body: unknown): { ok: true; event: PoolEvent } | { ok: false; error: string } {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, error: 'body must be a JSON object' }
  const b = body as Record<string, unknown>
  const type = str(b.type)
  if (!type || !(POOL_EVENT_TYPES as readonly string[]).includes(type)) return { ok: false, error: `unknown type ${JSON.stringify(type)}` }
  const ch = b.challenge && typeof b.challenge === 'object' && !Array.isArray(b.challenge) ? (b.challenge as Record<string, unknown>) : {}
  const challengeType = str(b.challengeType) ?? str(ch.type)
  const event: PoolEvent = {
    eventId: id(b.id ?? b.eventId),
    type: type as PoolEventType,
    challengeId: id(b.challengeId ?? ch.id),
    accountId: account(b.accountId ?? ch.account ?? ch.accountId ?? b.account),
    challengeType: challengeType === 'image' || challengeType === 'checkbox' ? challengeType : null,
    createdAt: iso(b.createdAt ?? ch.createdAt),
    expiresAt: iso(b.expiresAt ?? ch.expiresAt),
    phoneInitiated: b.phoneInitiated === true || b.priority === 'phone' || ch.priority === 'phone',
    reason: safeReason(b.reason),
  }
  if (event.type.startsWith('challenge.') && !event.challengeId) return { ok: false, error: 'challenge event without a valid challenge id' }
  return { ok: true, event }
}

/** The push for an event, or null when this event type does not page the owner. */
export function poolEventPushPayload(ev: PoolEvent, now: Date = new Date()): PushPayload | null {
  const who = ev.accountId ?? 'a pool account'
  if (ev.type === 'challenge.created' && ev.challengeId) {
    const kind = ev.challengeType === 'checkbox' ? 'a checkbox wall (live view)' : ev.challengeType === 'image' ? 'an image captcha' : 'a captcha'
    const until = ev.expiresAt ? ` Held until ${new Date(ev.expiresAt).toLocaleTimeString('en-US', { timeZone: 'America/Chicago', hour: 'numeric', minute: '2-digit' })}.` : ''
    return {
      kind: 'pool_challenge',
      title: '1001tracklists captcha waiting',
      body: `${who} hit ${kind}${ev.phoneInitiated ? ' on a phone lookup' : ''}. Tap to solve.${until}`,
      url: `/subscriptions/captcha/${encodeURIComponent(ev.challengeId)}`,
      tag: `tlpool-challenge-${ev.challengeId}`.slice(0, 64),
      ts: now.toISOString(),
    }
  }
  if (ev.type === 'account.flagged') {
    return {
      kind: 'pool_account',
      title: 'Pool account flagged',
      body: `${who} was flagged${ev.reason ? ` (${ev.reason})` : ''}. It rests 72 h, then gets one retest.`,
      url: ev.challengeId ? `/subscriptions/captcha/${encodeURIComponent(ev.challengeId)}` : '/subscriptions/pool',
      tag: `tlpool-account-${ev.accountId ?? 'unknown'}`.slice(0, 64),
      ts: now.toISOString(),
    }
  }
  if (ev.type === 'account.retired') {
    return {
      kind: 'pool_account',
      title: 'Pool account retired',
      body: `${who} was retired${ev.reason ? ` (${ev.reason})` : ''}. Its exit is not reused for 30 days.`,
      url: '/subscriptions/pool',
      tag: `tlpool-account-${ev.accountId ?? 'unknown'}`.slice(0, 64),
      ts: now.toISOString(),
    }
  }
  return null
}

export type ReceiveResult = { duplicate: boolean; rowId: number | null; push: PushStatus }

/**
 * Store one event (idempotent on tlpool's event id) and push it when it pages
 * the owner. Never throws on push problems.
 */
export async function receivePoolEvent(
  env: Env,
  event: PoolEvent,
  opts: { log?: Logger; now?: Date; fetchImpl?: typeof fetch } = {},
): Promise<ReceiveResult> {
  const now = opts.now ?? new Date()
  const nowSec = Math.floor(now.getTime() / 1000)
  const db = dbOf(env)
  if (event.eventId) {
    const existing = await db.prepare('SELECT id, push_status FROM pool_events WHERE event_id = ?').bind(event.eventId).first<{ id: number; push_status: PushStatus }>()
    if (existing) return { duplicate: true, rowId: Number(existing.id), push: existing.push_status }
  }
  const payload = poolEventPushPayload(event, now)
  let push: PushStatus = 'none'
  if (payload) {
    if (!pushConfigured(env)) push = 'not_configured'
    else push = 'sent'
  }
  const ins = await db
    .prepare(
      `INSERT INTO pool_events (event_id, type, challenge_id, account_id, payload, received_at, push_status, pushed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL)`,
    )
    .bind(event.eventId, event.type, event.challengeId, event.accountId, JSON.stringify(event), nowSec, push === 'sent' ? 'none' : push)
    .run()
  const rowId = Number(ins.meta.last_row_id) || null
  if (push === 'sent' && payload) push = await deliver(env, rowId, payload, nowSec, opts)
  opts.log?.info('pool.event', { type: event.type, challengeId: event.challengeId, accountId: event.accountId, phoneInitiated: event.phoneInitiated, push })
  return { duplicate: false, rowId, push }
}

async function deliver(env: Env, rowId: number | null, payload: PushPayload, nowSec: number, opts: { log?: Logger; fetchImpl?: typeof fetch }): Promise<PushStatus> {
  const r = await sendPushToAll(env, payload, opts.log, opts.fetchImpl ?? fetch)
  const status: PushStatus = r.sent > 0 ? 'sent' : 'failed'
  if (rowId !== null) await dbOf(env).prepare('UPDATE pool_events SET push_status = ?, pushed_at = ?, push_attempts = push_attempts + 1 WHERE id = ?').bind(status, nowSec, rowId).run()
  return status
}

/** A push that failed is tried again by the cron this many times in all. */
export const MAX_PUSH_ATTEMPTS = 5
/** ... and only while the event is this fresh (tlpool holds a challenge 2 h). */
const PUSH_RETRY_WINDOW_SECONDS = 2 * 60 * 60

/**
 * Cron hook (every tick): send again the pushes whose delivery failed (a
 * push-service 5xx), while the event is under 2 h old, at most
 * MAX_PUSH_ATTEMPTS deliveries each; a challenge that was solved or expired
 * meanwhile is not pushed. Never throws on push problems.
 */
export async function retryFailedPoolPushes(env: Env, opts: { log?: Logger; now?: Date; fetchImpl?: typeof fetch } = {}): Promise<{ retried: number; sent: number }> {
  if (!pushConfigured(env)) return { retried: 0, sent: 0 }
  const now = opts.now ?? new Date()
  const nowSec = Math.floor(now.getTime() / 1000)
  const db = dbOf(env)
  const rows = await db
    .prepare(`SELECT id, type, challenge_id, payload FROM pool_events WHERE push_status = 'failed' AND push_attempts < ? AND received_at >= ? ORDER BY received_at LIMIT 10`)
    .bind(MAX_PUSH_ATTEMPTS, nowSec - PUSH_RETRY_WINDOW_SECONDS)
    .all<{ id: number; type: string; challenge_id: string | null; payload: string }>()
  let sent = 0
  for (const row of rows.results) {
    const ev = parseJson<PoolEvent | null>(row.payload, null)
    const payload = ev ? poolEventPushPayload(ev, now) : null
    if (!ev || !payload) continue
    if (ev.type === 'challenge.created' && row.challenge_id) {
      const closed = await db
        .prepare(`SELECT 1 AS x FROM pool_events WHERE challenge_id = ? AND type IN ('challenge.solved', 'challenge.expired') LIMIT 1`)
        .bind(row.challenge_id)
        .first<{ x: number }>()
      const lapsed = ev.expiresAt ? Date.parse(ev.expiresAt) <= now.getTime() : false
      if (closed || lapsed) {
        await db.prepare(`UPDATE pool_events SET push_status = 'none' WHERE id = ?`).bind(row.id).run()
        continue
      }
    }
    if ((await deliver(env, Number(row.id), payload, nowSec, opts)) === 'sent') sent++
  }
  if (rows.results.length) opts.log?.info('pool.push_retries', { retried: rows.results.length, sent })
  return { retried: rows.results.length, sent }
}

/** Daily: drop events older than 90 days (the audit horizon everywhere else). */
export async function prunePoolEvents(env: Env, nowSec = Math.floor(Date.now() / 1000)): Promise<number> {
  const r = await dbOf(env).prepare('DELETE FROM pool_events WHERE received_at < ?').bind(nowSec - 90 * 86400).run()
  return r.meta.changes ?? 0
}

/** Newest events first, for the admin pages. */
export async function listPoolEvents(env: Env, limit = 50): Promise<Array<PoolEvent & { rowId: number; receivedAt: number; pushStatus: PushStatus }>> {
  const res = await dbOf(env)
    .prepare('SELECT id, payload, received_at, push_status FROM pool_events ORDER BY received_at DESC, id DESC LIMIT ?')
    .bind(Math.max(1, Math.min(200, Math.floor(limit))))
    .all<{ id: number; payload: string; received_at: number; push_status: PushStatus }>()
  return res.results.flatMap((r) => {
    const ev = parseJson<PoolEvent | null>(r.payload, null)
    return ev ? [{ ...ev, rowId: Number(r.id), receivedAt: Number(r.received_at), pushStatus: r.push_status }] : []
  })
}
