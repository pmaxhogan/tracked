/**
 * App settings API (lib/app-settings.ts), mounted under /ui/api behind the
 * CF Access gate (routes/subscriptions.ts):
 *   GET /ui/api/settings  `{ settings, defaults, effective }`; `effective` is
 *                         what is in force once a null (env-backed) field
 *                         falls back to its env var or the code default.
 *   PUT /ui/api/settings  partial settings, deep-merged; `null` resets an
 *                         env-backed field. 200 `{ settings, effective }` or
 *                         400 `{ error: 'invalid_settings', issues }`.
 */
import { Hono } from 'hono'
import type { Env } from '../types'
import { makeLogger } from '../lib/log'
import { DEFAULT_APP_SETTINGS, getAppSettings, updateAppSettings, type AppSettings } from '../lib/app-settings'
import { claimTtl, dailyClaimCap } from '../lib/mkvid'
import { rejectVerticalEnabled, sweepSettings } from '../lib/playlist-hygiene'

/** The env-backed fields as they resolve now. */
export function effectiveAppSettings(env: Env, s: AppSettings) {
  const sweep = sweepSettings(env, s)
  return {
    mkvid: {
      dailyClaimCap: dailyClaimCap(env, 'primary', s),
      sharedDailyClaimCap: dailyClaimCap(env, 'shared', s),
      claimTtlMinutes: Math.round(claimTtl(env, s) / 60),
    },
    playlists: { sweepDryRun: sweep.dryRun, sweepDailyRemovals: sweep.dailyRemovals, rejectVertical: rejectVerticalEnabled(env, s) },
  }
}

export const appSettingsApp = new Hono<{ Bindings: Env; Variables: { cfAccessEmail: string } }>()

appSettingsApp.get('/settings', async (c) => {
  const settings = await getAppSettings(c.env)
  return c.json({ settings, defaults: DEFAULT_APP_SETTINGS, effective: effectiveAppSettings(c.env, settings) })
})

appSettingsApp.put('/settings', async (c) => {
  const log = makeLogger({ reqId: c.req.raw.headers.get('cf-ray') ?? 'local', route: 'subs.app_settings', by: c.get('cfAccessEmail') })
  const body = await c.req.json().catch(() => undefined)
  const r = await updateAppSettings(c.env, body)
  if (!r.ok) {
    log.warn('app.settings_rejected', { issues: r.issues })
    return c.json({ error: 'invalid_settings', issues: r.issues }, 400)
  }
  log.info('app.settings_updated', { settings: r.settings })
  return c.json({ settings: r.settings, effective: effectiveAppSettings(c.env, r.settings) })
})
