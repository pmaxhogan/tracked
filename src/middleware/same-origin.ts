/**
 * CSRF guard for the Cloudflare Access-gated admin API (`/subscriptions/api/*`).
 *
 * The only credential on those routes is the Access cookie, which the browser
 * attaches to cross-site form posts too (SameSite=None) and to same-site ones
 * from sibling subdomains (SameSite=Lax). So every state-changing request
 * (anything but GET / HEAD / OPTIONS) must:
 *   1. come from this origin: `Sec-Fetch-Site: same-origin`, or, when the
 *      browser sends no Sec-Fetch-Site, an `Origin` equal to the Worker's own
 *      origin. A Sec-Fetch-Site other than same-origin is refused even when
 *      Origin matches.
 *   2. carry `Content-Type: application/json` (charset allowed). An HTML form
 *      cannot send that type, and a cross-origin fetch that does needs a CORS
 *      preflight this Worker never grants.
 * Refusals: 403 `{ error: 'cross_origin' }`, 415 `{ error: 'json_required' }`.
 * Bearer-token routes (Tasker, /mkvid, /pool/events, /tracklist/purge) are
 * outside `/subscriptions/api/` and not affected.
 */
import type { MiddlewareHandler } from 'hono'

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS'])

export function sameOriginCheck(req: Request): { ok: true } | { ok: false; status: 403 | 415; error: 'cross_origin' | 'json_required' } {
  if (SAFE_METHODS.has(req.method.toUpperCase())) return { ok: true }
  const self = new URL(req.url).origin
  const site = req.headers.get('sec-fetch-site')
  const origin = req.headers.get('origin')
  const sameOrigin = site !== null ? site.toLowerCase() === 'same-origin' : origin !== null && origin === self
  if (!sameOrigin) return { ok: false, status: 403, error: 'cross_origin' }
  const ct = (req.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
  if (ct !== 'application/json') return { ok: false, status: 415, error: 'json_required' }
  return { ok: true }
}

export const sameOriginJson: MiddlewareHandler = async (c, next) => {
  const r = sameOriginCheck(c.req.raw)
  if (!r.ok) {
    return c.json(
      { error: r.error, message: r.error === 'cross_origin' ? 'state-changing admin requests must come from this site' : 'send Content-Type: application/json' },
      r.status,
    )
  }
  return next()
}
