import type { Context, MiddlewareHandler } from 'hono'
import type { Env } from '../types'

export const bearerAuth: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const expected = c.env.API_TOKEN
  if (!expected) return c.json({ error: 'API_TOKEN not configured' }, 500)
  const header = c.req.header('Authorization') ?? ''
  const m = header.match(/^Bearer\s+(.+)$/i)
  if (!m || !timingSafeEqual(m[1]!, expected)) {
    return c.json({ error: 'unauthorized' }, 401)
  }
  await next()
  return
}

function timingSafeEqual(a: string, b: string): boolean {
  const ae = new TextEncoder().encode(a)
  const be = new TextEncoder().encode(b)
  if (ae.length !== be.length) return false
  let diff = 0
  for (let i = 0; i < ae.length; i++) diff |= ae[i]! ^ be[i]!
  return diff === 0
}
