/**
 * Web Push (Notifications API) delivery for the admin page.
 *
 * The admin page registers a service worker (`/subscriptions/sw.js`),
 * subscribes with our VAPID public key and POSTs the resulting
 * PushSubscription here; we keep one KV record per browser under
 * `push:sub:<id>` in SUBS (durable, no TTL). `sendPushToAll` encrypts a JSON
 * payload per RFC 8291 with `@block65/webcrypto-web-push` (WebCrypto only, so
 * it runs on Workers without nodejs_compat) and POSTs it to each push service.
 * A 404/410 from the push service means the browser unsubscribed — the record
 * is dropped so we stop paying for dead endpoints.
 *
 * Used by lib/ban-state.ts for the "1001tracklists blocked your home IP, go
 * solve the captcha" alert (once at ban start, once when it clears) and by the
 * admin page's "Send test notification" button.
 */

import { buildPushPayload, type PushSubscription } from '@block65/webcrypto-web-push'
import type { Env } from '../types'
import { sha1Hex } from './cache'
import type { Logger } from './log'

export const PUSH_SUB_PREFIX = 'push:sub:'

export type StoredPushSubscription = {
  id: string
  endpoint: string
  expirationTime: number | null
  keys: { p256dh: string; auth: string }
  /** navigator.userAgent at subscribe time — shown on the admin page so you can tell phone from desktop. */
  ua: string | null
  createdAt: string
  lastOkAt: string | null
  lastError: string | null
  failCount: number
}

export type PushKind = 'ban_start' | 'ban_clear' | 'test'

/** What the service worker receives (as JSON) and turns into a Notification. */
export type PushPayload = {
  kind: PushKind
  title: string
  body: string
  /** Opened when the notification is tapped. */
  url: string
  /** Notifications with the same tag replace each other on the device. */
  tag: string
  ts: string
}

export function pushConfigured(env: Env): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY && env.VAPID_SUBJECT)
}

export function isPushSubscription(x: unknown): x is PushSubscription {
  if (!x || typeof x !== 'object') return false
  const o = x as Record<string, unknown>
  const keys = o.keys as Record<string, unknown> | undefined
  return (
    typeof o.endpoint === 'string' &&
    /^https:\/\//.test(o.endpoint) &&
    !!keys &&
    typeof keys.p256dh === 'string' &&
    typeof keys.auth === 'string'
  )
}

export async function subscriptionId(endpoint: string): Promise<string> {
  return (await sha1Hex(endpoint)).slice(0, 16)
}

export async function listPushSubscriptions(env: Env): Promise<StoredPushSubscription[]> {
  const out: StoredPushSubscription[] = []
  let cursor: string | undefined
  do {
    const page = await env.SUBS.list({ prefix: PUSH_SUB_PREFIX, cursor })
    for (const k of page.keys) {
      const v = (await env.SUBS.get(k.name, 'json')) as StoredPushSubscription | null
      if (v) out.push(v)
    }
    cursor = page.list_complete ? undefined : page.cursor
  } while (cursor)
  return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

export async function savePushSubscription(env: Env, sub: PushSubscription, ua: string | null): Promise<StoredPushSubscription> {
  const id = await subscriptionId(sub.endpoint)
  const existing = (await env.SUBS.get(`${PUSH_SUB_PREFIX}${id}`, 'json')) as StoredPushSubscription | null
  const record: StoredPushSubscription = {
    id,
    endpoint: sub.endpoint,
    expirationTime: sub.expirationTime ?? null,
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ua: ua ?? existing?.ua ?? null,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    lastOkAt: existing?.lastOkAt ?? null,
    lastError: null,
    failCount: 0,
  }
  await env.SUBS.put(`${PUSH_SUB_PREFIX}${id}`, JSON.stringify(record))
  return record
}

export async function deletePushSubscription(env: Env, idOrEndpoint: string): Promise<boolean> {
  const id = idOrEndpoint.startsWith('https://') ? await subscriptionId(idOrEndpoint) : idOrEndpoint
  const key = `${PUSH_SUB_PREFIX}${id}`
  const existed = (await env.SUBS.get(key)) !== null
  if (existed) await env.SUBS.delete(key)
  return existed
}

export type PushSendResult = {
  id: string
  ua: string | null
  ok: boolean
  status: number | null
  error: string | null
  removed: boolean
}

export type SendPushSummary = { configured: boolean; total: number; sent: number; failed: number; removed: number; results: PushSendResult[] }

/**
 * Deliver `payload` to every stored subscription. Never throws — delivery
 * problems are per-subscription and reported in the summary. `fetchImpl` is
 * injectable for tests.
 */
export async function sendPushToAll(
  env: Env,
  payload: PushPayload,
  log?: Logger,
  fetchImpl: typeof fetch = fetch,
): Promise<SendPushSummary> {
  if (!pushConfigured(env)) {
    log?.warn('push.not_configured', { kind: payload.kind })
    return { configured: false, total: 0, sent: 0, failed: 0, removed: 0, results: [] }
  }
  const subs = await listPushSubscriptions(env)
  const vapid = { subject: env.VAPID_SUBJECT, publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY }
  const results: PushSendResult[] = []
  for (const sub of subs) {
    const r: PushSendResult = { id: sub.id, ua: sub.ua, ok: false, status: null, error: null, removed: false }
    try {
      const built = await buildPushPayload(
        // Same tag → the newer notification replaces the older one on-device,
        // so a "cleared" push swallows a stale "blocked" one that was never tapped.
        { data: payload, options: { ttl: 6 * 60 * 60, urgency: 'high', topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32) || undefined } },
        { endpoint: sub.endpoint, expirationTime: sub.expirationTime, keys: sub.keys },
        vapid,
      )
      const res = await fetchImpl(sub.endpoint, { method: built.method, headers: built.headers, body: built.body })
      r.status = res.status
      if (res.status === 404 || res.status === 410) {
        // Subscription expired / user revoked permission: forget it.
        r.removed = true
        await env.SUBS.delete(`${PUSH_SUB_PREFIX}${sub.id}`)
      } else if (res.ok) {
        r.ok = true
        await env.SUBS.put(`${PUSH_SUB_PREFIX}${sub.id}`, JSON.stringify({ ...sub, lastOkAt: new Date().toISOString(), lastError: null, failCount: 0 }))
      } else {
        r.error = `push service ${res.status}: ${(await res.text()).slice(0, 200)}`
        await env.SUBS.put(`${PUSH_SUB_PREFIX}${sub.id}`, JSON.stringify({ ...sub, lastError: r.error, failCount: (sub.failCount ?? 0) + 1 }))
      }
    } catch (e) {
      r.error = e instanceof Error ? e.message : String(e)
      await env.SUBS.put(`${PUSH_SUB_PREFIX}${sub.id}`, JSON.stringify({ ...sub, lastError: r.error, failCount: (sub.failCount ?? 0) + 1 })).catch(() => {})
    }
    results.push(r)
  }
  const summary = {
    configured: true,
    total: subs.length,
    sent: results.filter((x) => x.ok).length,
    failed: results.filter((x) => !x.ok && !x.removed).length,
    removed: results.filter((x) => x.removed).length,
    results,
  }
  log?.info('push.sent', { kind: payload.kind, title: payload.title, ...summary, results: results.map((x) => ({ id: x.id, ok: x.ok, status: x.status, error: x.error, removed: x.removed })) })
  return summary
}

export const UNBLOCK_URL = 'https://www.1001tracklists.com/info/unblock_ip.html'

export function banStartPayload(ip: string | null, viaPool: boolean): PushPayload {
  return {
    kind: 'ban_start',
    title: '1001tracklists blocked your home IP',
    body: `${ip ? `IP ${ip} is` : 'Your home IP is'} temp-banned. ${viaPool ? 'Fetches are going through the fallback pool for now.' : 'Every route is blocked — sync is paused.'} Tap to solve the captcha.`,
    url: UNBLOCK_URL,
    tag: 'tracked-ip-ban',
    ts: new Date().toISOString(),
  }
}

export function banClearPayload(ip: string | null, blockedForMs: number | null): PushPayload {
  const dur = blockedForMs === null ? '' : ` after ${formatDuration(blockedForMs)}`
  return {
    kind: 'ban_clear',
    title: 'Home IP unblocked at 1001tracklists',
    body: `${ip ? `IP ${ip}` : 'Your home IP'} works again${dur}. Fetches are back on the direct route.`,
    url: '/subscriptions',
    tag: 'tracked-ip-ban',
    ts: new Date().toISOString(),
  }
}

export function testPayload(): PushPayload {
  return {
    kind: 'test',
    title: 'tracked: test notification',
    body: 'If you can read this, IP-ban alerts will reach this device.',
    url: '/subscriptions',
    tag: 'tracked-test',
    ts: new Date().toISOString(),
  }
}

export function formatDuration(ms: number): string {
  const m = Math.round(ms / 60000)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rem = m % 60
  return rem ? `${h} h ${rem} min` : `${h} h`
}
