/**
 * Typed failures of a 1001tracklists fetch. Kept apart from lib/upstream1001.ts
 * (which re-exports them) so lib/pool.ts can subclass them without an import
 * cycle: `class X extends Y` runs at module load.
 *
 * Two families decide what a batch does next:
 *   - `UpstreamPausedError`: we stopped on purpose (the `ban:pause` master
 *     switch, or the pool says its budget is spent / a captcha is waiting for
 *     the owner). Stop the batch, charge the URL nothing.
 *   - `UpstreamUnavailableError`: the route is broken, not the URL (pool
 *     unreachable, no healthy account, blocked, timed out). Same handling.
 * `UpstreamHttpError` (a definitive 404/410) and `UpstreamTransportError` (a
 * one-off 5xx from 1001tracklists itself) are about the URL and are charged as
 * ordinary failures.
 */

import { IPBlockedError } from './fetch'

export class UpstreamPausedError extends Error {
  readonly until: string | null
  readonly reason: string
  constructor(reason: string, until: string | null) {
    super(until ? `1001tracklists fetching paused (${reason}) until ${until}` : `1001tracklists fetching paused (${reason})`)
    this.name = 'UpstreamPausedError'
    this.until = until
    this.reason = reason
  }
}

export class UpstreamUnavailableError extends Error {
  readonly reason: string
  constructor(reason: string) {
    super(`1001tracklists unreachable (${reason})`)
    this.name = 'UpstreamUnavailableError'
    this.reason = reason
  }
}

/** 1001tracklists answered a definitive 404/410: the URL is gone. Charged like any failure of that URL. */
export class UpstreamHttpError extends Error {
  readonly status: number
  readonly url: string
  constructor(status: number, url: string) {
    super(`1001tracklists answered ${status} for ${url}`)
    this.name = 'UpstreamHttpError'
    this.status = status
    this.url = url
  }
}

/** 1001tracklists itself answered an error page (5xx / unexpected status). A blip: one ordinary failure, retried on a later tick. */
export class UpstreamTransportError extends Error {
  readonly url: string
  constructor(url: string, detail: string) {
    super(`1001tracklists could not serve ${url} (${detail})`)
    this.name = 'UpstreamTransportError'
    this.url = url
  }
}

export function isStopTheBatchError(e: unknown): boolean {
  return e instanceof UpstreamPausedError || e instanceof UpstreamUnavailableError || e instanceof IPBlockedError
}
