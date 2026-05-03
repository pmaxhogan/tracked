import { createRoute, type RouteHandler } from '@hono/zod-openapi'
import { NowPlayingRequest, NowPlayingResponse, ErrorResponse } from '../schemas'
import type { Env, ParsedTrack, ResponseTrack, Status } from '../types'
import { resolveVideo } from '../lib/youtube'
import { searchByYouTubeUrl, fetchTracklist, fetchMediaLinks, type MediaLinks } from '../lib/tracklists1001'
import { lookupAppleLink } from '../lib/itunes'
import { selectCurrent } from '../lib/timestamp'
import { TTL, getJson, putJson, sha1Hex } from '../lib/cache'
import { bearerAuth } from '../middleware/auth'

export const nowPlayingRoute = createRoute({
  method: 'post',
  path: '/now-playing',
  middleware: [bearerAuth] as const,
  security: [{ bearerAuth: [] }],
  request: {
    body: { content: { 'application/json': { schema: NowPlayingRequest } }, required: true },
  },
  responses: {
    200: { content: { 'application/json': { schema: NowPlayingResponse } }, description: 'Resolved tracks (or status flag)' },
    401: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Missing/invalid bearer token' },
    400: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Validation failure' },
    500: { content: { 'application/json': { schema: ErrorResponse } }, description: 'Server misconfiguration' },
  },
})

type Res = typeof NowPlayingResponse._type

export const nowPlayingHandler: RouteHandler<typeof nowPlayingRoute, { Bindings: Env }> = async (c) => {
  const body = c.req.valid('json')
  const window = body.transitionWindowSeconds ?? 15
  const env = c.env

  const empty = (status: Status, extras: Partial<Res> = {}, message?: string) =>
    c.json({ status, videoUrl: null, tracklistUrl: null, tracks: [], ...(message ? { message } : {}), ...extras } satisfies Res, 200)

  let videoId: string | null = null
  try {
    videoId = await resolveYouTube(env, body.videoTitle, body.videoDurationSeconds)
  } catch (e) {
    return empty('upstream_error', {}, `youtube: ${(e as Error).message}`)
  }
  if (!videoId) return empty('no_video')
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`

  let tracklistUrl: string | null = null
  try {
    tracklistUrl = await resolveTracklistUrl(env, videoId, videoUrl)
  } catch (e) {
    return empty('upstream_error', { videoUrl }, `1001 search: ${(e as Error).message}`)
  }
  if (!tracklistUrl) return empty('no_tracklist', { videoUrl })

  let parsedTracks: ParsedTrack[]
  try {
    parsedTracks = await resolveTracklist(env, tracklistUrl)
  } catch (e) {
    return empty('upstream_error', { videoUrl, tracklistUrl }, `1001 scrape: ${(e as Error).message}`)
  }

  const sel = selectCurrent(parsedTracks, body.currentSeconds, window)
  if (sel.picked.length === 0) {
    return empty('no_tracklist', { videoUrl, tracklistUrl })
  }

  const enriched = await Promise.all(
    sel.picked.map(async (t) => {
      const parsed = parsedTracks.find((p) => p.title === t.title && p.startSeconds === t.startSeconds)
      const links = await resolveLinks(env, parsed, t)
      return { ...t, ...links } satisfies ResponseTrack
    }),
  )

  const status: Status = sel.anyUnidentified ? 'unidentified' : 'ok'
  return c.json({ status, videoUrl, tracklistUrl, tracks: enriched } satisfies Res, 200)
}

async function resolveYouTube(env: Env, title: string, dur: number | undefined): Promise<string | null> {
  const key = `yt:${await sha1Hex(title)}:${dur ?? 'x'}`
  const cached = await getJson<{ videoId: string | null }>(env.CACHE, key)
  if (cached) return cached.videoId
  const r = await resolveVideo(title, dur, env.YOUTUBE_API_KEY)
  const videoId = r?.videoId ?? null
  await putJson(env.CACHE, key, { videoId }, TTL.YT_VIDEO)
  return videoId
}

async function resolveTracklistUrl(env: Env, videoId: string, videoUrl: string): Promise<string | null> {
  const key = `s1001:${videoId}`
  const cached = await getJson<{ tracklistUrl: string | null }>(env.CACHE, key)
  if (cached) return cached.tracklistUrl
  const { result } = await searchByYouTubeUrl(videoUrl)
  await putJson(env.CACHE, key, { tracklistUrl: result.tracklistUrl }, TTL.TRACKLIST_SEARCH)
  return result.tracklistUrl
}

async function resolveTracklist(env: Env, tracklistUrl: string): Promise<ParsedTrack[]> {
  const slug = tracklistUrl.match(/\/tracklist\/([^/]+)\//)?.[1] ?? tracklistUrl
  const key = `tl:${slug}`
  const cached = await getJson<ParsedTrack[]>(env.CACHE, key)
  if (cached) return cached
  const { result } = await fetchTracklist(tracklistUrl)
  await putJson(env.CACHE, key, result.tracks, TTL.TRACKLIST_PAGE)
  return result.tracks
}

async function resolveLinks(env: Env, parsed: ParsedTrack | undefined, t: ResponseTrack): Promise<{ appleLink: string | null; youtubeLink: string | null }> {
  if (t.isUnidentified) return { appleLink: null, youtubeLink: null }

  let apple: string | null = null
  let youtube: string | null = null

  if (parsed?.trackId && /^\d+$/.test(parsed.trackId)) {
    const ml = await getMediaLinks(env, parsed.trackId)
    apple = ml.appleLink
    youtube = ml.youtubeLink
  }

  if (!apple && t.artist && t.title) {
    apple = await lookupAppleCached(env, t.artist, t.title)
  }
  return { appleLink: apple, youtubeLink: youtube }
}

async function getMediaLinks(env: Env, trackId: string): Promise<MediaLinks> {
  const key = `ml:${trackId}`
  const cached = await getJson<MediaLinks>(env.CACHE, key)
  if (cached) return cached
  const { result } = await fetchMediaLinks(trackId)
  await putJson(env.CACHE, key, result, TTL.MEDIALINK)
  return result
}

async function lookupAppleCached(env: Env, artist: string, title: string): Promise<string | null> {
  const key = `am:${await sha1Hex(`${artist}|${title}`)}`
  const cached = await getJson<{ url: string | null }>(env.CACHE, key)
  if (cached) return cached.url
  const url = await lookupAppleLink(artist, title)
  await putJson(env.CACHE, key, { url }, TTL.APPLE)
  return url
}
