/**
 * tlpool's plain numeric runtime settings (tlpool settings.py DEFAULTS /
 * NUMERIC / validate_patch) that /ui/pool/settings edits beyond its budget
 * form. `GET/PUT /ui/api/pool/limits` passes exactly these keys through
 * (lib/pool-admin-client.ts); tlpool checks the ranges and answers 400 with
 * the reason. min/max here mirror settings.py so the form can say so first.
 */

export type TlpoolField = {
  key: string
  label: string
  help: string
  /** Shown in the input's unit slot; `s` fields are edited in seconds. */
  unit: string
  min: number
  max: number
  step: number
  def: number
}

export type TlpoolFieldGroup = { id: string; title: string; fields: TlpoolField[] }

const f = (key: string, label: string, def: number, min: number, max: number, unit: string, help: string, step = 1): TlpoolField => ({ key, label, help, unit, min, max, step, def })

export const TLPOOL_FIELD_GROUPS: TlpoolFieldGroup[] = [
  {
    id: 'tp-pace',
    title: 'Pacing between page views',
    fields: [
      f('minGapSeconds', 'Minimum gap', 35, 10, 3600, 's', 'Shortest wait between two page views of one account.'),
      f('gapMedianExtraSeconds', 'Typical extra gap', 50, 10, 3600, 's', 'Median of the random extra on top of the minimum.'),
      f('maxGapSeconds', 'Longest gap', 1500, 30, 86400, 's', 'Cap on the random gap.'),
      f('xhrMinGapSeconds', 'Lookup minimum gap', 3, 0, 600, 's', 'Shortest wait between two in-page lookups.', 0.5),
      f('xhrGapMedianExtraSeconds', 'Lookup typical extra gap', 6, 0, 600, 's', 'Median random extra between lookups.', 0.5),
    ],
  },
  {
    id: 'tp-rest',
    title: 'Captchas, flags and rests',
    fields: [
      f('challengeTtlSeconds', 'Captcha waits for you', 7200, 60, 86400, 's', 'How long a captcha stays open for an answer.'),
      f('challengeExpiredRestSeconds', 'Rest after an unanswered captcha', 21600, 0, 2592000, 's', 'Also the rest after too many walls in a row.'),
      f('challengesBeforeFlag', 'Captchas in 24 h before a flag', 3, 1, 50, '', 'A flagged account rests and is retested.'),
      f('flagRestSeconds', 'Rest of a flagged account', 259200, 0, 2592000, 's', 'Before its retest.'),
      f('retestRestSeconds', 'Rest before a requested retest', 21600, 0, 604800, 's', 'Whatever reason tracked gave.'),
      f('retestInconclusiveRestSeconds', 'Rest after an inconclusive retest', 43200, 0, 604800, 's', 'Then it is retested again.'),
      f('exitFailRestSeconds', 'Rest when the exit fails', 1800, 0, 86400, 's', 'The browser could not use its exit.'),
      f('loginFailRestSeconds', 'Rest when a login fails', 3600, 0, 604800, 's', 'Still logged out after a fresh login.'),
      f('maxWallsPerFetch', 'Walls in a row per fetch', 3, 1, 10, '', 'Then the account rests.'),
      f('maxCaptchaAnswers', 'Answers per image captcha', 8, 1, 30, '', 'A wrong answer gets a fresh image.'),
      f('turnstileSelfPassSeconds', 'Checkbox wall self-pass wait', 20, 0, 120, 's', 'Time to pass by itself before you are asked.'),
    ],
  },
  {
    id: 'tp-fetch',
    title: 'Fetch mechanics',
    fields: [
      f('defaultMaxWaitSeconds', 'Wait for a free account', 20, 0, 90, 's', 'When the request names no wait.', 0.5),
      f('phoneMaxWaitSeconds', 'Phone fetch wait at most', 25, 0, 90, 's', 'Whatever the phone asks.', 0.5),
      f('navTimeoutSeconds', 'Page load timeout', 45, 10, 85, 's', 'One page load or in-page request.'),
      f('netErrorTries', 'Loads on a browser network error', 3, 1, 10, '', 'Transient errors that never reached the site.'),
      f('netErrorBenchAfter', 'Network-error fetches before an exit rests', 3, 0, 20, '', 'In a row, while other accounts fetch fine; it then rests like a failed exit. 0 = never.'),
      f('resultTtlSeconds', 'Reuse a finished answer for', 1800, 0, 86400, 's', 'A repeat request for the same URL gets it.'),
      f('idleCloseSeconds', 'Close an idle browser after', 0, 0, 3600, 's', '0 = the IDLE_CLOSE_SECONDS env value (240); else at least 30.'),
    ],
  },
  {
    id: 'tp-house',
    title: 'Accounts, exits and housekeeping',
    fields: [
      f('signupStaleSeconds', 'Signup counts as failed after', 21600, 600, 604800, 's', 'A signup stuck in new this long.'),
      f('exitProbeMax', 'Exits probed per new account', 8, 1, 50, '', 'Before giving up.'),
      f('exitQuarantineDays', 'Retired account exit quarantine', 30, 0, 365, 'days', 'Its exit is not reused for this long.'),
      f('egressRecheckSeconds', 'Recheck an open browser exit IP', 900, 60, 86400, 's', 'How often.'),
      f('dumpDailyCap', 'Debug dumps a day', 50, 0, 1000, '', 'Blocked or challenged answers saved.'),
      f('captureKeepDays', 'Keep navigation captures', 30, 1, 365, 'days', 'Screenshots and HTML of every page view.'),
    ],
  },
]

/** Every key the admin client passes through to tlpool's PUT /settings and back from GET. */
export const TLPOOL_NUMERIC_KEYS: readonly string[] = TLPOOL_FIELD_GROUPS.flatMap((g) => g.fields.map((x) => x.key))
