export type Env = {
  CACHE: KVNamespace
  API_TOKEN: string
  YOUTUBE_API_KEY: string
  /** Optional. When set, tracklist page GETs route through Bright Data Web Unlocker. */
  BRIGHTDATA_API_KEY?: string
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
  /** Canonical 1001tracklists track page URL. null when the meta url is missing. */
  trackUrl: string | null
  /** Square 300×300 album art URL (Beatport CDN or SoundCloud CDN). null when the row only had a 1001tl placeholder. */
  artworkUrl: string | null
  /** True only when the playing track is fully anonymous (e.g. "Cave Studio - ID"). Remix/edit variants of a known base track surface artist+title+links and use idStatus instead. */
  isUnidentified: boolean
  /**
   * Non-null when the row has a 1001tl trackStatus marker indicating a partial-ID
   * variant of a known base track — typically "ID Remix", "ID Edit", "ID Bootleg",
   * "ID Rework". Links/trackUrl point to the BASE track in this case; the actual
   * playing version may differ. null when the row is fully ID'd or fully unidentified.
   */
  idStatus: string | null
  /** True if this row is a "w/" sibling of the previous row (mashup-linked position). */
  isMashupLinked: boolean
}

export type ResponseTrack = {
  title: string
  artist: string
  startTime: string
  startSeconds: number | null
  /** Length the track occupies in the set: nextGroupStart - thisGroupStart for non-last
   *  groups; setEnd - thisGroupStart for the last group when the caller provided
   *  videoDurationSeconds. null when neither input is known. Mashup-linked siblings
   *  share their group's duration. */
  durationSeconds: number | null
  /** Same as durationSeconds, formatted "M:SS" / "H:MM:SS". Empty string when null. */
  durationTime: string
  isCurrent: boolean
  isUnidentified: boolean
  /** "ID Remix" / "ID Edit" / etc. — non-null means the links point to the base track but the actual playing version is a not-yet-identified variant. */
  idStatus: string | null
  appleLink: string | null
  youtubeLink: string | null
  /** Canonical 1001tracklists track page URL. null when no meta url is present. */
  trackUrl: string | null
  /** Square 300×300 album-art URL. null when only a placeholder was available. */
  artworkUrl: string | null
}
