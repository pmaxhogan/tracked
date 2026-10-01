/**
 * Test helper: give a queued mkvid request a stored, verified (trusted) track
 * list and a verified set_verification row, so the claim gate
 * (lib/mkvid-readiness.ts + lib/verification.ts) lets it through. `idRows`
 * of the `rows` are ID rows (the 7-day wait then applies); the last
 * `untimedRows` have no cue time (the 90 % timed gate then may apply).
 */
import type { Env } from '../../src/types'
import type { MkvidTrack } from '../../src/lib/mkvid'
import { timedRowCounts } from '../../src/lib/mkvid-readiness'

export async function storeVerifiedList(env: Env, setUrl: string, opts: { rows?: number; idRows?: number; trusted?: boolean; untimedRows?: number } = {}): Promise<void> {
  const rows = opts.rows ?? 3
  const idRows = opts.idRows ?? 0
  const tracks: MkvidTrack[] = Array.from({ length: rows }, (_, i) => ({
    cueSeconds: i > 0 && i >= rows - (opts.untimedRows ?? 0) ? null : i * 60,
    artist: i < idRows ? null : `Artist ${i}`,
    title: i < idRows ? null : `Title ${i}`,
    artworkUrl: null,
    isId: i < idRows,
    layered: false,
  }))
  const req = await env.DB.prepare('SELECT id FROM mkvid_requests WHERE set_url = ?').bind(setUrl).first<{ id: string }>()
  if (!req) throw new Error(`no request for ${setUrl}`)
  await env.DB.prepare(
    `INSERT INTO mkvid_request_tracks (request_id, tracks, track_count, trusted, named, mismatched, scraped_at, id_rows, base_rows, timed_rows)
     VALUES (?, ?, ?, ?, 3, 0, 1, ?, ?, ?)
     ON CONFLICT(request_id) DO UPDATE SET tracks = excluded.tracks, track_count = excluded.track_count, trusted = excluded.trusted, id_rows = excluded.id_rows,
       base_rows = excluded.base_rows, timed_rows = excluded.timed_rows`,
  )
    .bind(req.id, JSON.stringify(tracks), rows, opts.trusted === false ? 0 : 1, idRows, timedRowCounts(tracks).baseRows, timedRowCounts(tracks).timedRows)
    .run()
  // The claim also asks the fetch layer (lib/verification.ts isVerified): a
  // trusted list belongs to a verified set.
  if (opts.trusted !== false) {
    const now = Math.floor(Date.now() / 1000)
    await env.DB.prepare(
      `INSERT INTO set_verification (url, state, fingerprint, row_count, first_account, first_fetched_at, verify_due_at,
                                     second_account, second_fetched_at, verified_at, exclude_accounts, mismatches, updated_at)
       VALUES (?, 'verified', 'test', ?, 'acct-1', ?, NULL, 'acct-2', ?, ?, '[]', 0, ?)
       ON CONFLICT(url) DO UPDATE SET state = 'verified'`,
    )
      .bind(setUrl, rows, now - 3 * 3600, now, now, now)
      .run()
  }
}
