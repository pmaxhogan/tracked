// Page registry helpers for the /ui admin pages. Each page module exports a
// UiPage (or a function building its HTML); the routers serve them through
// servePage.
import type { Context } from 'hono'

/** One shell page: its path relative to /ui (e.g. '/djs') and its full HTML. */
export interface UiPage { path: string; html: string }

/** Serves one admin page. The page bundles its own JS inline; no-store keeps
 *  browsers from serving a stale page after a deploy, which would mean stale UI
 *  logic (e.g. a banner that doesn't auto-refresh). */
export function servePage(c: Context, html: string) {
  c.header('Cache-Control', 'no-store')
  return c.html(html)
}
