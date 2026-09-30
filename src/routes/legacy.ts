/**
 * The admin UI lived under /subscriptions until the phase 1 redesign moved it to /ui.
 * Old bookmarks and pushes delivered before the deploy still point here: pages answer a
 * 301 to the same path under /ui (the retired viewer to /ui/set), and the API, OAuth and
 * the old service worker answer 410 (a redirect would drop a POST body). The 410 only stops
 * serving the old worker script; it does not make browsers drop that worker. BAN_JS removes
 * the old registration and its push subscription client-side, after subscribing under /ui/.
 * No handler serves content, so none needs Access. Keep until the owner retires the old prefix.
 */
import { Hono } from 'hono'

export const LEGACY_PAGE_MAP: Record<string, string> = { '/tracklist': '/set' }

export const legacyApp = new Hono()

legacyApp.all('*', (c) => {
  const url = new URL(c.req.url)
  const rest = url.pathname.replace(/^\/subscriptions/, '') // '' | '/' | '/pool' | '/api/…'
  if (rest === '/sw.js' || rest.startsWith('/api/') || rest === '/api' || rest.startsWith('/oauth/') || rest === '/oauth') {
    return c.json({ error: 'moved', message: `This API moved to /ui${rest}` }, 410)
  }
  const mapped = LEGACY_PAGE_MAP[rest] ?? rest
  return c.redirect(`/ui${mapped}${url.search}`, 301)
})
