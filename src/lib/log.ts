/**
 * Tiny structured logger. Each log line is a single JSON object so it's easy
 * to grep / pipe through jq from `wrangler tail --format json`. Every entry
 * carries a request id (cf-ray when available) so all log lines from one
 * invocation can be correlated.
 *
 * We're intentionally verbose — this service handles ~30 calls/day, so
 * full request bodies, full response bodies, and full error context are
 * cheap and very useful when debugging.
 */

export type LogLevel = 'info' | 'warn' | 'error'

export type Logger = {
  info(event: string, fields?: Record<string, unknown>): void
  warn(event: string, fields?: Record<string, unknown>): void
  error(event: string, fields?: Record<string, unknown>): void
  /** Wraps an async fn, timing it; logs success/failure with duration. */
  time<T>(event: string, fn: () => Promise<T>, extraOnSuccess?: (v: T) => Record<string, unknown>): Promise<T>
  child(extra: Record<string, unknown>): Logger
}

export function makeLogger(base: Record<string, unknown> = {}): Logger {
  const emit = (level: LogLevel, event: string, fields?: Record<string, unknown>) => {
    const line = { level, event, t: new Date().toISOString(), ...base, ...(fields ?? {}) }
    const out = safeStringify(line)
    if (level === 'error') console.error(out)
    else if (level === 'warn') console.warn(out)
    else console.log(out)
  }
  const log: Logger = {
    info: (e, f) => emit('info', e, f),
    warn: (e, f) => emit('warn', e, f),
    error: (e, f) => emit('error', e, f),
    async time(event, fn, extraOnSuccess) {
      const start = Date.now()
      try {
        const v = await fn()
        emit('info', `${event}.ok`, { ms: Date.now() - start, ...(extraOnSuccess ? extraOnSuccess(v) : {}) })
        return v
      } catch (e) {
        emit('error', `${event}.fail`, { ms: Date.now() - start, ...errorFields(e) })
        throw e
      }
    },
    child: (extra) => makeLogger({ ...base, ...extra }),
  }
  return log
}

export function errorFields(e: unknown): Record<string, unknown> {
  if (e instanceof Error) {
    return { errorName: e.name, errorMessage: e.message, errorStack: e.stack }
  }
  return { error: String(e) }
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v)
  } catch {
    return JSON.stringify({ level: 'error', event: 'log.serialization_failed', raw: String(v) })
  }
}
