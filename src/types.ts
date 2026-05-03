export type Env = {
  CACHE: KVNamespace
  API_TOKEN: string
  YOUTUBE_API_KEY: string
}

export type Status = 'ok' | 'no_video' | 'no_tracklist' | 'unidentified' | 'upstream_error'

export type ParsedTrack = {
  /** Display "H:MM:SS" / "M:SS" / "" if no cue. */
  startTime: string
  /** Parsed cue in seconds. null if cue was missing. */
  startSeconds: number | null
  artist: string
  title: string
  /** Internal 1001tracklists track id, used for the medialink AJAX. null if unextractable. */
  trackId: string | null
  isUnidentified: boolean
  /** True if this row is a "w/" sibling of the previous row (mashup-linked position). */
  isMashupLinked: boolean
}

export type ResponseTrack = {
  title: string
  artist: string
  startTime: string
  startSeconds: number | null
  isCurrent: boolean
  isUnidentified: boolean
  appleLink: string | null
  youtubeLink: string | null
}
