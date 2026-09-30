/**
 * Fix the titles of managed DJ playlists created while 1001tracklists' July
 * 2026 redesign made every stored artist name start with "Tracklists By "
 * (the DJ page H1). The DJ page parser strips it now and the next DJ page
 * fetch corrects the stored name, but a YouTube playlist title is only set at
 * creation, so the existing ones keep "Tracklists By X (1001tklists)".
 *
 * `fixPlaylistTitles` walks every managed DJ playlist (`sub_sync.playlist_id`),
 * reads its current YouTube title, and for each one that starts with
 * "Tracklists By " computes the title a fresh creation would get now
 * (`artistPlaylistTitle` of the corrected artist name) and, unless `dryRun`,
 * renames it with `playlists.update`, sending back the playlist's own
 * description, privacy and default language so nothing else changes. The
 * stored artist name is corrected in D1 at the same time (not in a dry run).
 * The combined playlist is never touched (its title is fixed).
 *
 * Quota: playlists.list costs 1 unit per 50 playlists; each playlists.update
 * costs 50.
 */

import type { Env } from '../types'
import { dbOf } from './db'
import { errorFields, type Logger } from './log'
import { authedFetch, expectOk } from './youtube-playlists'

const API = 'https://www.googleapis.com/youtube/v3'
export const PLAYLIST_TITLE_SUFFIX = ' (1001tklists)'
const PREFIX_RE = /^Tracklists By\s+/i

/** The title a DJ's playlist is created with (lib/sync.ts uses this too). */
export function artistPlaylistTitle(artistName: string): string {
  return `${artistName}${PLAYLIST_TITLE_SUFFIX}`
}

/** An artist name without the redesign's "Tracklists By " H1 prefix. */
export function stripTracklistsBy(name: string): string {
  return name.replace(PREFIX_RE, '').trim()
}

export type TitleFix = {
  slug: string
  playlistId: string
  oldTitle: string
  newTitle: string
  /** renamed (done), would_rename (dry run), failed (YouTube refused; see error). */
  status: 'renamed' | 'would_rename' | 'failed'
  error?: string
}

export type FixTitlesResult = { dryRun: boolean; checked: number; fixes: TitleFix[] }

type PlaylistResource = {
  id: string
  snippet?: { title?: string; description?: string; defaultLanguage?: string }
  status?: { privacyStatus?: string }
}

async function readPlaylists(ids: string[], accessToken: string, fetcher: typeof fetch): Promise<Map<string, PlaylistResource>> {
  const out = new Map<string, PlaylistResource>()
  for (let i = 0; i < ids.length; i += 50) {
    const params = new URLSearchParams({ part: 'snippet,status', id: ids.slice(i, i + 50).join(','), maxResults: '50' })
    const res = await authedFetch(`${API}/playlists?${params}`, accessToken, {}, fetcher)
    await expectOk(res, 'playlists.list')
    const data = (await res.json()) as { items?: PlaylistResource[] }
    for (const p of data.items ?? []) out.set(p.id, p)
  }
  return out
}

/** playlists.update with the playlist's own description, privacy and language, only the title changed. */
export async function renamePlaylist(p: PlaylistResource, title: string, accessToken: string, fetcher: typeof fetch = fetch): Promise<void> {
  const snippet: Record<string, string> = { title, description: p.snippet?.description ?? '' }
  if (p.snippet?.defaultLanguage) snippet.defaultLanguage = p.snippet.defaultLanguage
  const body: Record<string, unknown> = { id: p.id, snippet }
  if (p.status?.privacyStatus) body.status = { privacyStatus: p.status.privacyStatus }
  const res = await authedFetch(`${API}/playlists?part=${body.status ? 'snippet,status' : 'snippet'}`, accessToken, { method: 'PUT', body: JSON.stringify(body) }, fetcher)
  await expectOk(res, 'playlists.update', p.id)
}

export async function fixPlaylistTitles(
  env: Env,
  accessToken: string,
  opts: { dryRun?: boolean; log?: Logger; fetcher?: typeof fetch } = {},
): Promise<FixTitlesResult> {
  const dryRun = opts.dryRun !== false
  const fetcher = opts.fetcher ?? fetch
  const db = dbOf(env)
  const subs = (
    await db.prepare('SELECT slug, playlist_id, artist_name FROM sub_sync WHERE playlist_id IS NOT NULL ORDER BY slug').all<{ slug: string; playlist_id: string; artist_name: string | null }>()
  ).results
  const live = await readPlaylists([...new Set(subs.map((s) => s.playlist_id))], accessToken, fetcher)
  const fixes: TitleFix[] = []
  for (const s of subs) {
    const p = live.get(s.playlist_id)
    const oldTitle = p?.snippet?.title
    if (!p || !oldTitle || !PREFIX_RE.test(oldTitle)) continue
    // The corrected name: the stored one without the prefix, else the title's own artist part.
    const fromTitle = oldTitle.endsWith(PLAYLIST_TITLE_SUFFIX) ? oldTitle.slice(0, -PLAYLIST_TITLE_SUFFIX.length) : oldTitle
    const name = stripTracklistsBy(s.artist_name ?? fromTitle) || stripTracklistsBy(fromTitle)
    if (!name) continue
    const newTitle = artistPlaylistTitle(name)
    if (newTitle === oldTitle) continue
    if (dryRun) {
      fixes.push({ slug: s.slug, playlistId: s.playlist_id, oldTitle, newTitle, status: 'would_rename' })
      continue
    }
    try {
      await renamePlaylist(p, newTitle, accessToken, fetcher)
      if (s.artist_name && s.artist_name !== name) await db.prepare('UPDATE sub_sync SET artist_name = ? WHERE slug = ?').bind(name, s.slug).run()
      fixes.push({ slug: s.slug, playlistId: s.playlist_id, oldTitle, newTitle, status: 'renamed' })
      opts.log?.info('playlist.title_fixed', { slug: s.slug, playlistId: s.playlist_id, oldTitle, newTitle })
    } catch (e) {
      opts.log?.warn('playlist.title_fix_failed', { slug: s.slug, playlistId: s.playlist_id, ...errorFields(e) })
      fixes.push({ slug: s.slug, playlistId: s.playlist_id, oldTitle, newTitle, status: 'failed', error: (e as Error).message.slice(0, 200) })
    }
  }
  return { dryRun, checked: subs.length, fixes }
}
