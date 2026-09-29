/**
 * Test helper: give a queued mkvid request a stored, verified (trusted) track
 * list, so the claim gate (lib/mkvid-readiness.ts) lets it through. `idRows`
 * of the `rows` are ID rows (the 7-day wait then applies).
 */
import type { Env } from '../../src/types'
import type { MkvidTrack } from '../../src/lib/mkvid'

export async function storeVerifiedList(env: Env, setUrl: string, opts: { rows?: number; idRows?: number; trusted?: boolean } = {}): Promise<void> {
  const rows = opts.rows ?? 3
  const idRows = opts.idRows ?? 0
  const tracks: MkvidTrack[] = Array.from({ length: rows }, (_, i) => ({
    cueSeconds: i * 60,
    artist: i < idRows ? null : `Artist ${i}`,
    title: i < idRows ? null : `Title ${i}`,
    artworkUrl: null,
    isId: i < idRows,
    layered: false,
  }))
  const req = await env.DB.prepare('SELECT id FROM mkvid_requests WHERE set_url = ?').bind(setUrl).first<{ id: string }>()
  if (!req) throw new Error(`no request for ${setUrl}`)
  await env.DB.prepare(
    `INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, named, mismatched, scraped_at, id_rows)
     VALUES (?, ?, ?, ?, 3, 0, 1, ?)
     ON CONFLICT(request_id) DO UPDATE SET tracks = excluded.tracks, track_count = excluded.track_count, trusted = excluded.trusted, id_rows = excluded.id_rows`,
  )
    .bind(req.id, JSON.stringify(tracks), rows, opts.trusted === false ? 0 : 1, idRows)
    .run()
}
