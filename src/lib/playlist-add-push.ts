/**
 * A push to every subscribed device each time a set's video goes into its
 * artist playlist: a sync addition (first processing, a recheck that found a
 * recording, a swapped video, a quota-deferred insert going through) or an
 * mkvid upload. Tapping opens /ui/set for that tracklist. The combined-playlist
 * mirror and the panel's Undo do not notify (the same video, or the owner's
 * own action).
 *
 * Best effort: never throws, so a push failure cannot fail an insert.
 */

import type { Env } from '../types'
import type { Logger } from './log'
import { errorFields } from './log'
import { prettifySlug } from './prettify-slug'
import { pushConfigured, sendPushToAll, youtubeThumbnail, type PushPayload } from './web-push'

/** A readable name from the URL alone: `/tracklist/<id>/<name>.html` → "Name". */
export function setNameFromUrl(setUrl: string): string {
  const m = setUrl.match(/\/tracklist\/([^/]+)\/([^/?#]+?)(?:\.html)?(?:[?#].*)?$/)
  return m ? prettifySlug(m[2]!) : setUrl
}

export function playlistAddPayload(p: { setUrl: string; setTitle: string | null; playlistTitle: string; via: 'sync' | 'mkvid'; videoId: string }, now: Date = new Date()): PushPayload {
  const name = p.setTitle?.trim() || setNameFromUrl(p.setUrl)
  const slug = p.setUrl.match(/\/tracklist\/([^/]+)\//)?.[1] ?? p.setUrl.slice(-40)
  return {
    kind: 'playlist_add',
    title: `Added to ${p.playlistTitle}${p.via === 'mkvid' ? ' (mkvid upload)' : ''}`,
    body: name,
    url: `/ui/set?url=${encodeURIComponent(p.setUrl)}`,
    // One per set: a second addition of the same set (a swapped video) replaces the first.
    tag: `tracked-pladd-${slug}`,
    ts: now.toISOString(),
    // The set's video: its thumbnail beside the text and, expanded, in full.
    icon: youtubeThumbnail(p.videoId),
    image: youtubeThumbnail(p.videoId),
  }
}

export async function notifyPlaylistAdd(
  env: Env,
  p: { setUrl: string; videoId: string; playlistTitle: string; via: 'sync' | 'mkvid'; setTitle?: string | null },
  log: Logger,
): Promise<void> {
  try {
    if (!pushConfigured(env)) return
    let setTitle = p.setTitle ?? null
    if (!setTitle) {
      const row = await env.DB.prepare('SELECT set_title FROM set_media_facts WHERE set_url = ?').bind(p.setUrl).first<{ set_title: string | null }>()
      setTitle = row?.set_title ?? null
    }
    const r = await sendPushToAll(env, playlistAddPayload({ setUrl: p.setUrl, setTitle, playlistTitle: p.playlistTitle, via: p.via, videoId: p.videoId }), log)
    log.info('push.playlist_add', { setUrl: p.setUrl, videoId: p.videoId, via: p.via, sent: r.sent, failed: r.failed })
  } catch (e) {
    log.warn('push.playlist_add_failed', { setUrl: p.setUrl, videoId: p.videoId, ...errorFields(e) })
  }
}
