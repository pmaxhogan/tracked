import type { MiddlewareHandler } from 'hono'
import type { Env } from '../types'

/**
 * Build a bearer-token gate that compares against ONE named secret. Each
 * route surface gets its own token so an agent holding LIKED_SONGS_TOKEN
 * can't drive the Tasker routes (and vice versa).
 */
export function bearerAuthFor(secretName: 'API_TOKEN' | 'LIKED_SONGS_TOKEN'): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const expected = c.env[secretName]
    if (!expected) return c.json({ error: `${secretName} not configured` }, 500)
    const header = c.req.header('Authorization') ?? ''
    const m = header.match(/^Bearer\s+(.+)$/i)
    if (!m || !timingSafeEqual(m[1]!, expected)) {
      return c.json({ error: 'unauthorized' }, 401)
    }
    await next()
    return
  }
}

/** Tasker token — gates /now-playing, /tracklist, /likes, /openapi.json. */
export const bearerAuth = bearerAuthFor('API_TOKEN')

/** Agent token — gates GET /liked-songs only. */
export const likedSongsAuth = bearerAuthFor('LIKED_SONGS_TOKEN')

function timingSafeEqual(a: string, b: string): boolean {
  const ae = new TextEncoder().encode(a)
  const be = new TextEncoder().encode(b)
  if (ae.length !== be.length) return false
  let diff = 0
  for (let i = 0; i < ae.length; i++) diff |= ae[i]! ^ be[i]!
  return diff === 0
}
